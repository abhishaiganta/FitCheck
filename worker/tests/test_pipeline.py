"""Integration (spec section 9): the full worker pipeline on 3 fixture listings with providers mocked
and a real Postgres (test schema), ending with assets ready. Also covers the section 14 failure paths:
provider fallbacks, retries, dead-letters, stale locks and idempotent re-runs.
"""
from __future__ import annotations

import io
import json
import threading
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from worker.config import Settings
from worker.context import Ctx
from worker.limits import Limits, PgStore, ProviderError, QuotaExceeded
from worker.providers import PollResult, Provider
from worker.stages import cutout, export, gen, scrape, select, tag
from worker.storage import Storage
from worker.tests.fixtures_glb import messy_table_glb, upright_lamp_glb
from worker.usd_validate import validate_usdz

FB = json.loads((Path(__file__).parent / "fixtures" / "bd_fb_sample.json").read_text(encoding="utf-8"))[:3]


def photo_jpeg() -> bytes:
    img = Image.new("RGB", (640, 480), (235, 235, 230))
    ImageDraw.Draw(img).rectangle([220, 120, 420, 420], fill=(140, 96, 60))
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


def fake_rembg(_ctx, photo: bytes):
    """Stands in for rembg: the brown box becomes opaque, the rest transparent."""
    img = Image.open(io.BytesIO(photo)).convert("RGBA")
    alpha = Image.new("L", img.size, 0)
    ImageDraw.Draw(alpha).rectangle([220, 120, 420, 420], fill=255)
    img.putalpha(alpha)
    return img


class FakeGemini:
    def __init__(self):
        self.tag_calls = 0
        self.fail_with: Exception | None = None

    def tag(self, *, title, description, price, photos):
        self.tag_calls += 1
        if self.fail_with:
            raise self.fail_with
        from worker.tagging import validate_tag
        out = validate_tag({
            "category": "side_table", "style_tags": ["wood"], "condition": "good", "w_in": 20, "d_in": 16, "h_in": 24,
            "dims_source": "estimated", "weight_lb_est": 15, "best_photo_idx": 0, "photo_ok": True,
            "summary": f"Fixture item: {title}",
            "views": [{"photo_idx": i, "same_object": True, "angle": "front", "clean": True} for i in range(len(photos))],
        }, title=title, description=description, n_photos=len(photos))
        return out, "fake-vision"

    def embed(self, texts, task_type="RETRIEVAL_DOCUMENT"):
        return [[1.0] + [0.0] * 767 for _ in texts]


class FakeProvider(Provider):
    """Scripted provider: behaviour per listing comes from `script` (first match on the PNG is not needed,
    jobs are answered in submit order)."""
    supports_multi = True

    def __init__(self, name: str, outcomes: list):
        super().__init__(["key-" + name])
        self.name = name
        self.outcomes = list(outcomes)
        self.submitted = 0
        self.jobs: dict[str, object] = {}

    def submit(self, views, key):
        outcome = self.outcomes.pop(0) if self.outcomes else "ok"
        if isinstance(outcome, Exception):
            raise outcome
        self.submitted += 1
        job = f"job{self.submitted}"
        self.jobs[job] = outcome
        return job

    def poll(self, job_id, key):
        outcome = self.jobs[job_id]
        if outcome == "ok":
            return PollResult("done", glb=messy_table_glb())
        if outcome == "lamp":
            return PollResult("done", glb=upright_lamp_glb())
        if outcome == "invalid":
            return PollResult("done", glb=b"this is not a glb")
        if outcome == "fail":
            return PollResult("failed", error="mock failure")
        if outcome == "lost":
            self.jobs[job_id] = "ok"                     # only the first poll loses it
            return PollResult("failed", error="job lost (worker restarted)")
        return PollResult("running")


@pytest.fixture
def ctx(db, tmp_path, monkeypatch):
    import worker.stages.cutout as cutout_mod
    import worker.stages.tag as tag_mod
    import worker.storage as storage_mod

    monkeypatch.setenv("REAL_3D_FOR", "all")
    monkeypatch.delenv("MULTI_PHOTO", raising=False)
    monkeypatch.setattr(storage_mod, "LOCAL_DIR", tmp_path / "store")
    monkeypatch.setattr(tag_mod, "fetch_bytes", lambda url, **kw: photo_jpeg())
    monkeypatch.setattr(cutout_mod, "fetch_bytes", lambda url, **kw: photo_jpeg())
    monkeypatch.setattr(cutout_mod, "remove_background", fake_rembg)
    s = Settings()
    s.gemini_keys = ["g"]
    c = Ctx(settings=s, db=db, limits=Limits(PgStore(db), sleep=lambda _s: None), storage=Storage(token=""),
            stop=threading.Event())
    c._gemini = FakeGemini()
    c._providers = [FakeProvider("tripo", ["ok", "ok", "ok"])]
    yield c
    if c._exporter is not None:
        c._exporter.close()


def run_until_settled(ctx, rounds: int = 8):
    for _ in range(rounds):
        select.run(ctx)
        cutout.run(ctx, batch=5)
        gen.run(ctx, batch=5)
        export.run(ctx, batch=5)
    return {r["listing_id"]: r for r in ctx.db.q("select * from assets order by listing_id")}


def seed(ctx):
    stats = scrape.ingest(ctx, "fb_marketplace", FB)
    assert stats["inserted"] == 3
    assert tag.run(ctx) == 3


# ---------------------------------------------------------------- happy path
def test_full_pipeline_ends_with_three_ready_assets(ctx):
    seed(ctx)
    assets = run_until_settled(ctx)
    assert [a["status"] for a in assets.values()] == ["ready", "ready", "ready"]
    for a in assets.values():
        assert a["provider"] == "tripo" and a["is_approx_model"] is False
        assert a["usdz_url"].endswith(f"usdz/{a['listing_id']}-v1.usdz") and a["glb_url"].endswith("-v1.glb")
        assert float(a["final_h_in"]) == 24.0 and a["locked_by"] is None and a["last_error"] is None
        rep = validate_usdz(ctx.storage.get(a["usdz_url"]), expect_h_in=24, require_texture=True)
        assert rep.ok, rep.errors
    # embeddings were written, details are complete
    d = ctx.db.q("select eligible_3d, embedding is not null as emb, content_hash, dims_from_text from listing_details")
    assert all(r["eligible_3d"] and r["emb"] and r["content_hash"] and not r["dims_from_text"] for r in d)
    # every status change left an event for the pipeline board
    flow = [(e["from_status"], e["to_status"]) for e in ctx.db.q(
        "select from_status, to_status from asset_events where listing_id = %s and from_status is distinct from to_status order by id",
        (list(assets)[0],))]
    assert flow == [(None, "queued"), ("queued", "cutout"), ("cutout", "gen_pending"), ("gen_pending", "gen_done"),
                    ("gen_done", "exporting"), ("exporting", "ready")]
    assert ctx.db.q("select 1 from error_log") == []


def test_rerunning_every_stage_is_idempotent(ctx):
    seed(ctx)
    run_until_settled(ctx)
    before = ctx.db.one("select (select count(*) from listings) l, (select count(*) from listing_details) d, "
                        "(select count(*) from assets) a, (select count(*) from asset_events) e")
    import worker.storage as st
    files_before = sorted(p.name for p in st.LOCAL_DIR.rglob("*.*"))
    calls = ctx.gemini.tag_calls
    scrape.ingest(ctx, "fb_marketplace", FB)             # same records again
    tag.run(ctx)
    run_until_settled(ctx, rounds=2)
    after = ctx.db.one("select (select count(*) from listings) l, (select count(*) from listing_details) d, "
                       "(select count(*) from assets) a, (select count(*) from asset_events) e")
    assert after == before
    assert ctx.gemini.tag_calls == calls                 # never tagged twice
    files_after = sorted(p.name for p in st.LOCAL_DIR.rglob("*.*"))
    assert files_after == files_before                   # deterministic blob paths: no duplicate files


def test_same_content_is_never_sent_to_gemini_twice(ctx):
    scrape.ingest(ctx, "fb_marketplace", FB[:1])
    tag.run(ctx)
    twin = {**FB[0], "product_id": "999000111", "url": "https://www.facebook.com/marketplace/item/999000111"}
    scrape.ingest(ctx, "fb_marketplace", [twin])
    tag.run(ctx)
    assert ctx.gemini.tag_calls == 1
    rows = ctx.db.q("select model_used from listing_details order by listing_id")
    assert [r["model_used"] for r in rows] == ["fake-vision", "cache:fake-vision"]


# ---------------------------------------------------------------- provider chain and fallbacks
def test_provider_chain_falls_through_to_generic(ctx):
    """listing A: tripo ok. B: tripo job fails -> meshy ok. C: tripo quota, meshy invalid GLB -> generic."""
    seed(ctx)
    ctx._providers = [
        FakeProvider("tripo", ["ok", "fail", ProviderError("429", quota=True, quota_kind="day", retry_after=3600)]),
        FakeProvider("meshy", ["lamp", "invalid"]),
    ]
    assets = run_until_settled(ctx)
    by_provider = sorted((a["provider"], a["status"], a["is_approx_model"]) for a in assets.values())
    assert by_provider == [("generic", "fallback_ready", True), ("meshy", "ready", False), ("tripo", "ready", False)]
    generic = next(a for a in assets.values() if a["provider"] == "generic")
    assert set(generic["gen_state"]["tried"]) >= {"meshy"}
    assert validate_usdz(ctx.storage.get(generic["usdz_url"]), expect_h_in=24).ok
    # footprint of the generic model is stretched to the listing's W x D
    assert (float(generic["final_w_in"]), float(generic["final_d_in"])) == (20.0, 16.0)
    # the tripo key that hit its quota is cooling down in the shared ledger
    cool = ctx.db.q("select provider, cooldown_until from provider_state where provider like 'tripo:%%'")
    assert cool and cool[0]["cooldown_until"] is not None
    codes = {r["code"] for r in ctx.db.q("select code from error_log")}
    assert {"provider_failed", "quota"} <= codes


def test_no_providers_configured_means_generic_for_everything(ctx):
    seed(ctx)
    ctx._providers = []
    assets = run_until_settled(ctx)
    assert {a["status"] for a in assets.values()} == {"fallback_ready"}
    assert all(a["is_approx_model"] and a["provider"] == "generic" for a in assets.values())


def test_real_3d_is_reserved_for_pinned_listings_and_upgrades_later(ctx, monkeypatch):
    monkeypatch.setenv("REAL_3D_FOR", "pinned")
    seed(ctx)
    assets = run_until_settled(ctx)
    assert {a["provider"] for a in assets.values()} == {"generic"}
    assert ctx.providers[0].submitted == 0               # no credits spent
    lid = list(assets)[0]
    ctx.db.x("update listings set demo_pin = true where id = %s", (lid,))
    assets = run_until_settled(ctx)
    assert assets[lid]["provider"] == "tripo" and assets[lid]["status"] == "ready"
    assert assets[lid]["version"] == 2 and assets[lid]["usdz_url"].endswith("-v2.usdz")     # new file name: no stale AR cache
    assert ctx.providers[0].submitted == 1


def test_pinned_fallback_is_retried_later_but_not_forever(ctx, monkeypatch):
    from worker.stages import select
    monkeypatch.setenv("REAL_3D_FOR", "pinned")
    seed(ctx)
    run_until_settled(ctx)
    lid = ctx.db.one("select min(listing_id) id from assets")["id"]
    ctx.db.x("update listings set demo_pin = true where id = %s", (lid,))
    # every real provider was busy: it fell back again right after the first upgrade
    ctx.db.x("""update assets set status = 'fallback_ready', provider = 'generic',
                gen_state = '{"upgrade": true, "upgrades": 1}'::jsonb, updated_at = now() where listing_id = %s""", (lid,))
    select.run(ctx)
    assert ctx.db.one("select status from assets where listing_id = %s", (lid,))["status"] == "fallback_ready"  # too soon
    ctx.db.x("update assets set updated_at = now() - interval '31 minutes' where listing_id = %s", (lid,))
    select.run(ctx)
    a = ctx.db.one("select status, gen_state from assets where listing_id = %s", (lid,))
    assert a["status"] == "gen_pending" and a["gen_state"]["upgrades"] == 2
    ctx.db.x("""update assets set status = 'fallback_ready', provider = 'generic', updated_at = now() - interval '2 hours',
                gen_state = '{"upgrade": true, "upgrades": 6}'::jsonb where listing_id = %s""", (lid,))
    select.run(ctx)
    assert ctx.db.one("select status from assets where listing_id = %s", (lid,))["status"] == "fallback_ready"  # gave up


def test_job_lost_in_a_restart_is_resubmitted_to_the_same_provider(ctx):
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")
    hf = FakeProvider("hf", ["lost", "ok"])
    ctx._providers = [hf, FakeProvider("meshy", ["ok"])]
    a = list(run_until_settled(ctx).values())[0]
    assert (a["provider"], a["status"]) == ("hf", "ready")          # not handed to meshy, not the generic model
    assert hf.submitted == 2 and ctx._providers[1].submitted == 0


def test_exporter_rejection_moves_to_next_provider(ctx):
    """A provider GLB that parses but has no meshes passes gen and is rejected by the exporter."""
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")
    import struct
    js = b'{"asset":{"version":"2.0"},"meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],"accessors":[{"count":3}]}  '
    js = js[:len(js) - len(js) % 4]
    broken = struct.pack("<III", 0x46546C67, 2, 20 + len(js)) + struct.pack("<II", len(js), 0x4E4F534A) + js

    class Broken(FakeProvider):
        def poll(self, job_id, key):
            return PollResult("done", glb=broken)

    ctx._providers = [Broken("tripo", ["ok"]), FakeProvider("meshy", ["ok"])]
    assets = run_until_settled(ctx)
    a = list(assets.values())[0]
    assert (a["provider"], a["status"]) == ("meshy", "ready")
    assert "tripo" in a["gen_state"]["tried"]
    assert ctx.db.one("select count(*) n from error_log where code = 'export_invalid'")["n"] == 1


def test_running_job_is_polled_across_runs_and_times_out(ctx):
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")
    slow = FakeProvider("tripo", ["never"])
    slow.timeout_s = 0                                   # times out on the second poll
    ctx._providers = [slow]
    select.run(ctx); cutout.run(ctx)
    gen.run(ctx)
    a = ctx.db.one("select * from assets")
    assert a["status"] == "gen_pending" and a["provider_job"].startswith("tripo:") and a["locked_by"]
    assert ":key-" not in a["provider_job"]              # only the key hash is stored, never the key
    slow.timeout_s = 360
    gen.run(ctx)
    assert ctx.db.one("select provider_job from assets")["provider_job"] is not None     # still running
    slow.timeout_s = -1
    gen.run(ctx)                                         # timed out -> generic
    a = ctx.db.one("select * from assets")
    assert (a["status"], a["provider"]) == ("gen_done", "generic")
    assert "timed out" in ctx.db.one("select message from error_log where code='provider_failed'")["message"]


def test_one_concurrent_job_per_key(ctx):
    seed(ctx)
    busy = FakeProvider("tripo", ["never", "never", "never"])
    ctx._providers = [busy]
    select.run(ctx); cutout.run(ctx, batch=5)
    gen.run(ctx, batch=5)
    gen.run(ctx, batch=5)
    assert busy.submitted == 1                           # 1 key -> 1 job; the others wait instead of going generic
    rows = ctx.db.q("select status, provider_job is not null as running from assets")
    assert sorted(r["running"] for r in rows) == [False, False, True]
    assert all(r["status"] == "gen_pending" for r in rows)


# ---------------------------------------------------------------- cutout / tagging failures
def test_bad_mask_is_dead_lettered_with_a_reason(ctx, monkeypatch):
    import worker.stages.cutout as cutout_mod
    seed(ctx)

    def tiny(_ctx, photo):
        img = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
        ImageDraw.Draw(img).rectangle([0, 0, 40, 40], fill=(1, 1, 1, 255))       # 1% coverage
        return img
    monkeypatch.setattr(cutout_mod, "remove_background", tiny)
    select.run(ctx); cutout.run(ctx, batch=5)
    rows = ctx.db.q("select status, last_error from assets")
    assert all(r["status"] == "failed" and "under 8%" in r["last_error"] for r in rows)
    assert ctx.db.one("select count(*) n from asset_events where to_status='failed'")["n"] == 3
    assert ctx.db.one("select count(*) n from error_log where code='bad_mask'")["n"] == 3
    cutout.run(ctx, batch=5)                             # dead-lettered: not picked up again
    assert ctx.db.one("select max(attempts) m from assets")["m"] == 1


def test_crop_and_pad_thresholds():
    img = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle([50, 20, 149, 179], fill=(9, 9, 9, 255))       # 100 x 160 = 40%
    png, cov = cutout.crop_and_pad(img)
    out = Image.open(io.BytesIO(png))
    assert abs(cov - 0.40) < 0.01
    assert out.size == (192, 192)                        # square, long side 160 padded 10% each side
    assert out.getpixel((2, 2))[3] == 0 and out.getpixel((96, 96))[3] == 255
    full = Image.new("RGBA", (50, 50), (1, 1, 1, 255))
    with pytest.raises(cutout.BadMask, match="over 95%"):
        cutout.crop_and_pad(full)


def test_transient_download_error_retries_then_dead_letters(ctx, monkeypatch):
    import worker.stages.cutout as cutout_mod
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")

    def down(url, **kw):
        raise ProviderError("download 503", retryable=True)
    monkeypatch.setattr(cutout_mod, "fetch_bytes", down)
    select.run(ctx)
    for _ in range(5):
        cutout.run(ctx)
        ctx.db.x("update assets set next_attempt_at = null")     # skip the backoff wait
    a = ctx.db.one("select * from assets")
    assert a["status"] == "failed" and a["attempts"] == 3        # 3 attempts total, then dead-letter
    retries = ctx.db.q("select note from asset_events where to_status='queued' and note like 'retry%%'")
    assert len(retries) == 2


def test_tagging_stops_on_quota_and_recovers(ctx):
    scrape.ingest(ctx, "fb_marketplace", FB)
    ctx.gemini.fail_with = QuotaExceeded("gemini", "all keys at cap")
    assert tag.run(ctx) == 0
    assert ctx.gemini.tag_calls == 1                     # stopped after the first quota hit
    assert ctx.db.q("select 1 from listing_details") == []
    ctx.gemini.fail_with = None
    assert tag.run(ctx) == 3


def test_tagging_config_error_stops_the_batch_without_parking_listings(ctx):
    scrape.ingest(ctx, "fb_marketplace", FB)
    ctx.gemini.fail_with = ProviderError("gemini 404: model is no longer available", status=404)
    assert tag.run(ctx) == 0
    assert ctx.gemini.tag_calls == 1
    assert ctx.db.q("select 1 from listing_details") == []


def test_unusable_model_output_is_parked_after_three_tries(ctx):
    scrape.ingest(ctx, "fb_marketplace", FB[:1])
    ctx.gemini.fail_with = ValueError("tag JSON failed schema validation")
    for _ in range(3):
        tag.run(ctx)
    d = ctx.db.one("select category, eligible_3d, model_used from listing_details")
    assert d == {"category": "other", "eligible_3d": False, "model_used": "none:tag_invalid"}
    calls = ctx.gemini.tag_calls
    tag.run(ctx)
    assert ctx.gemini.tag_calls == calls                 # parked: not retried forever


def test_dead_photo_links_are_recorded_not_retried(ctx, monkeypatch):
    import worker.stages.tag as tag_mod
    scrape.ingest(ctx, "fb_marketplace", FB[:1])

    def gone(url, **kw):
        raise ProviderError("download 403 (gone)", status=403)
    monkeypatch.setattr(tag_mod, "fetch_bytes", gone)
    assert tag.run(ctx) == 0
    assert ctx.db.one("select model_used from listing_details")["model_used"] == "none:photo_unavailable"
    assert ctx.gemini.tag_calls == 0


# ---------------------------------------------------------------- queue mechanics
def test_stale_locks_are_reclaimed(ctx):
    seed(ctx)
    select.run(ctx)
    lid = ctx.db.one("select listing_id from assets order by updated_at limit 1")["listing_id"]
    # another worker claimed it and died 11 minutes ago
    ctx.db.x("update assets set status='cutout', locked_by='dead:1', locked_at=now() - interval '11 minutes' where listing_id=%s", (lid,))
    ctx.db.x("update assets set status='exporting', locked_by='dead:1', locked_at=now() - interval '2 minutes' "
             "where listing_id=(select max(listing_id) from assets)")
    assert ctx.db.reclaim_stale("cutout", "queued", 10) == 1
    assert ctx.db.reclaim_stale("exporting", "gen_done", 10) == 0        # only 2 minutes old: still owned
    assert ctx.db.one("select status, locked_by from assets where listing_id=%s", (lid,)) == {"status": "queued", "locked_by": None}


def test_claim_skips_locked_rows_and_orders_pinned_first(ctx):
    seed(ctx)
    ids = [r["id"] for r in ctx.db.q("select id from listings order by id")]
    ctx.db.x("update listings set demo_pin = true where id = %s", (ids[2],))
    select.run(ctx)
    first = ctx.db.claim("queued", "cutout")
    assert first["listing_id"] == ids[2] and first["attempts"] == 1
    second = ctx.db.claim("queued", "cutout")
    assert second["listing_id"] != ids[2]
    assert ctx.db.release_locks() == 2
    assert ctx.db.one("select count(*) n from assets where locked_by is not null")["n"] == 0


def test_select_orders_pinned_then_near_then_newest(ctx):
    seed(ctx)
    ids = [r["id"] for r in ctx.db.q("select id from listings order by id")]
    ctx.db.x("update listings set lat = 34.05, lng = -118.24, posted_at = now() where id = %s", (ids[0],))   # far (LA), newest
    ctx.db.x("update listings set posted_at = now() - interval '5 days' where id = %s", (ids[1],))            # near, old
    ctx.db.x("update listings set demo_pin = true, posted_at = now() - interval '30 days' where id = %s", (ids[2],))
    select.run(ctx)
    order = [r["listing_id"] for r in ctx.db.q("select listing_id from assets order by updated_at")]
    assert order == [ids[2], ids[1], ids[0]]
    assert select.run(ctx) == 0                          # idempotent


def test_inactive_and_ineligible_listings_are_not_queued(ctx):
    seed(ctx)
    ids = [r["id"] for r in ctx.db.q("select id from listings order by id")]
    ctx.db.x("update listings set is_active = false where id = %s", (ids[0],))
    ctx.db.x("update listing_details set eligible_3d = false where listing_id = %s", (ids[1],))
    select.run(ctx)
    assert [r["listing_id"] for r in ctx.db.q("select listing_id from assets")] == [ids[2]]


def test_manual_glb_upload_is_exported_and_re_exported_with_orient_override(ctx):
    """/admin sets glb_url + provider='manual' + status='gen_done'; later sets orient_override and gen_done again."""
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")
    lid = ctx.db.one("select id from listings")["id"]
    url = ctx.storage.put(f"manual/{lid}.glb", messy_table_glb(), "model/gltf-binary")
    ctx.db.x("insert into assets (listing_id, status, provider, glb_url) values (%s, 'gen_done', 'manual', %s)", (lid, url))
    ctx.db.x("update listing_details set dims_from_text = true, dims_source = 'listing_text' where listing_id = %s", (lid,))
    export.run(ctx)
    a = ctx.db.one("select * from assets")
    assert (a["status"], a["provider"], a["orientation_used"], a["version"]) == ("ready", "manual", "z+90", 1)
    assert a["gen_state"]["raw_glb_url"] == url and a["glb_url"] != url
    # human says: keep it as generated
    ctx.db.x("update assets set orient_override = 'identity', status = 'gen_done' where listing_id = %s", (lid,))
    export.run(ctx)
    b = ctx.db.one("select * from assets")
    assert (b["status"], b["orientation_used"], b["version"]) == ("ready", "identity", 2)
    assert b["usdz_url"].endswith("-v2.usdz")
    assert float(b["final_w_in"]) != float(a["final_w_in"])      # really re-exported from the raw model


def test_listing_text_dims_are_downgraded_when_the_model_is_off_by_more_than_2in(ctx):
    seed(ctx)
    ctx.db.x("delete from listings where id <> (select min(id) from listings)")
    # listing says 30 x 16 x 24 but the generated model is 20 x 16 x 24
    ctx.db.x("update listing_details set w_in = 30, dims_source = 'listing_text', dims_from_text = true")
    run_until_settled(ctx)
    d = ctx.db.one("select dims_source, dims_from_text from listing_details")
    assert d == {"dims_source": "estimated", "dims_from_text": True}
    assert ctx.db.one("select status from assets")["status"] == "ready"
