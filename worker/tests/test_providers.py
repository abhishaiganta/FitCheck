"""Each provider's request shape and error mapping, on recorded responses (httpx.MockTransport)."""
from __future__ import annotations

import json

import httpx
import pytest

from worker.brightdata import BrightData
from worker.limits import Limits, ProviderError, QuotaExceeded
from worker.providers import View, build_chain
from worker.providers.hf import _map_error as hf_map_error
from worker.providers.meshy import Meshy
from worker.providers.tripo import Tripo
from worker.stages.verify import is_gone
from worker.tests.fixtures_glb import upright_lamp_glb

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
GLB = upright_lamp_glb()


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ---------------------------------------------------------------- Tripo
def tripo_ok(req: httpx.Request) -> httpx.Response:
    p = req.url.path
    if p.endswith("/upload/sts"):
        return httpx.Response(200, json={"code": 0, "data": {"image_token": "tok-1"}})
    if p.endswith("/task") and req.method == "POST":
        body = json.loads(req.content)
        tripo_ok.bodies.append(body)
        return httpx.Response(200, json={"code": 0, "data": {"task_id": "task-9"}})
    if p.endswith("/task/task-9"):
        tripo_ok.polls += 1
        if tripo_ok.polls < 2:
            return httpx.Response(200, json={"code": 0, "data": {"status": "running", "progress": 40}})
        return httpx.Response(200, json={"code": 0, "data": {"status": "success", "output": {"pbr_model": "https://cdn.tripo/m.glb"}}})
    if req.url.host == "cdn.tripo":
        return httpx.Response(200, content=GLB)
    return httpx.Response(404)


def test_tripo_single_image_flow():
    tripo_ok.bodies, tripo_ok.polls = [], 0
    t = Tripo(["k1"], client(tripo_ok))
    job = t.submit([View(PNG)], "k1")
    assert job == "task-9"
    assert tripo_ok.bodies[0]["type"] == "image_to_model"
    assert tripo_ok.bodies[0]["file"] == {"type": "png", "file_token": "tok-1"}
    assert t.poll(job, "k1").state == "running"
    done = t.poll(job, "k1")
    assert done.state == "done" and done.glb == GLB


def test_tripo_multiview_slots_are_front_left_back_right():
    tripo_ok.bodies, tripo_ok.polls = [], 0
    t = Tripo(["k1"], client(tripo_ok))
    t.submit([View(PNG, "back"), View(PNG, "front")], "k1")
    body = tripo_ok.bodies[0]
    assert body["type"] == "multiview_to_model"
    assert [bool(f) for f in body["files"]] == [True, False, True, False]
    # without a front view Tripo's multiview is not usable: single image instead
    t.submit([View(PNG, "side"), View(PNG, "three_quarter")], "k1")
    assert tripo_ok.bodies[1]["type"] == "image_to_model"


def test_tripo_no_credit_is_a_quota_error_with_a_long_cooldown():
    # recorded live on Nov 14, 2026 with a zero-balance key
    t = Tripo(["k1"], client(lambda r: httpx.Response(200, json={"code": 0, "data": {"image_token": "t"}})
                             if r.url.path.endswith("/upload/sts")
                             else httpx.Response(403, json={"code": 2010, "message": "You don't have enough credit to create this task"})))
    with pytest.raises(ProviderError) as e:
        t.submit([View(PNG)], "k1")
    assert e.value.quota and e.value.retry_after == 6 * 3600 and not e.value.retryable


def test_tripo_bad_key_and_server_error_mapping():
    bad = Tripo(["k"], client(lambda r: httpx.Response(401, json={"code": 1002, "message": "Authentication failed"})))
    with pytest.raises(ProviderError) as e:
        bad.submit([View(PNG)], "k")
    assert e.value.quota                       # the key is parked, the chain moves on
    down = Tripo(["k"], client(lambda r: httpx.Response(502, text="bad gateway")))
    with pytest.raises(ProviderError) as e:
        down.submit([View(PNG)], "k")
    assert e.value.retryable and not e.value.quota


def test_tripo_failed_task_and_network_error():
    t = Tripo(["k"], client(lambda r: httpx.Response(200, json={"code": 0, "data": {"status": "failed"}})))
    assert t.poll("x", "k").state == "failed"

    def boom(req):
        raise httpx.ConnectTimeout("timeout")
    with pytest.raises(ProviderError) as e:
        Tripo(["k"], client(boom)).poll("x", "k")
    assert e.value.retryable


# ---------------------------------------------------------------- Meshy
def test_meshy_single_and_multi_image_requests():
    seen = []

    def h(req):
        if req.method == "POST":
            seen.append((req.url.path, json.loads(req.content)))
            return httpx.Response(202, json={"result": "0193-task"})
        if req.url.host == "assets.meshy.ai":
            return httpx.Response(200, content=GLB)
        return httpx.Response(200, json={"status": "SUCCEEDED", "progress": 100,
                                         "model_urls": {"glb": "https://assets.meshy.ai/x/model.glb"}})

    m = Meshy(["k"], client(h))
    job = m.submit([View(PNG)], "k")
    assert job == "image-to-3d/0193-task"
    path, body = seen[0]
    assert path.endswith("/openapi/v1/image-to-3d")
    assert body["image_url"].startswith("data:image/png;base64,") and body["should_texture"] is True
    assert body["target_formats"] == ["glb"]
    assert m.poll(job, "k").glb == GLB

    job2 = m.submit([View(PNG, "side"), View(PNG, "front")], "k")
    assert job2.startswith("multi-image-to-3d/")
    assert len(seen[1][1]["image_urls"]) == 2            # front first


@pytest.mark.parametrize("status,body,quota,retryable", [
    (402, {"message": "Insufficient credits"}, True, False),
    (401, {"message": "Invalid API key"}, True, False),
    (429, {"message": "Too many requests"}, True, False),
    (500, {"message": "oops"}, False, True),
    (400, {"message": "Invalid values: AIModel must be one of [...]"}, False, False),
])
def test_meshy_error_mapping(status, body, quota, retryable):
    m = Meshy(["k"], client(lambda r: httpx.Response(status, json=body)))
    with pytest.raises(ProviderError) as e:
        m.submit([View(PNG)], "k")
    assert (e.value.quota, e.value.retryable) == (quota, retryable)


def test_meshy_failed_task_reports_the_reason():
    m = Meshy(["k"], client(lambda r: httpx.Response(200, json={"status": "FAILED", "task_error": {"message": "NSFW"}})))
    res = m.poll("image-to-3d/x", "k")
    assert res.state == "failed" and res.error == "NSFW"
    running = Meshy(["k"], client(lambda r: httpx.Response(200, json={"status": "IN_PROGRESS", "progress": 55})))
    assert running.poll("image-to-3d/x", "k").progress == 55


# ---------------------------------------------------------------- blocking wrapper + chain
def test_generate_glb_polls_until_done(clock):
    tripo_ok.bodies, tripo_ok.polls = [], 0

    def h(req):
        if req.url.host == "blob.example":
            return httpx.Response(200, content=PNG)
        return tripo_ok(req)

    t = Tripo(["k1"], client(h))
    lim = Limits(clock=clock, sleep=clock.sleep)
    assert t.generate_glb("https://blob.example/cutout/1.png", lim, sleep=clock.sleep) == GLB
    assert clock.slept == [5]                     # polled every 5 s


def test_generate_glb_times_out(clock, monkeypatch):
    import worker.providers as prov
    t = Tripo(["k1"], client(lambda r: httpx.Response(200, content=PNG) if r.url.host == "blob.example" else
                             httpx.Response(200, json={"code": 0, "data": {"image_token": "t", "task_id": "j", "status": "running"}})))
    t.timeout_s = 12
    fake = {"t": 0.0}
    monkeypatch.setattr(prov.time, "monotonic", lambda: fake["t"])

    def sleep(s):
        fake["t"] += s
    with pytest.raises(ProviderError, match="timed out"):
        t.generate_glb("https://blob.example/c.png", Limits(clock=clock), sleep=sleep)


def test_one_job_per_key(clock):
    from worker.limits import key_hash
    t = Tripo(["k1", "k2"])
    lim = Limits(clock=clock)
    assert t.lease(lim, busy={key_hash("k1")}).key == "k2"
    with pytest.raises(QuotaExceeded) as e:
        t.lease(lim, busy={key_hash("k1"), key_hash("k2")})
    assert e.value.reason == "busy"


def test_provider_order_env_puts_free_hf_first(monkeypatch):
    from worker.config import Settings
    s = Settings()
    s.tripo_keys, s.meshy_keys, s.hf_tokens = ["t"], ["m"], ["h"]
    monkeypatch.setenv("PROVIDER_ORDER", "hf,meshy")             # tripo not named -> appended last
    assert [p.name for p in build_chain(s)] == ["hf", "meshy", "tripo"]
    monkeypatch.setenv("PROVIDER_ORDER", "bogus, HF ")
    assert [p.name for p in build_chain(s)] == ["hf", "tripo", "meshy"]


def test_chain_order_and_meshy_only_with_keys(monkeypatch):
    from worker.config import Settings
    monkeypatch.delenv("PROVIDER_ORDER", raising=False)
    s = Settings()
    s.tripo_keys, s.meshy_keys, s.hf_tokens = ["t"], [], ["h"]
    assert [p.name for p in build_chain(s)] == ["tripo", "hf"]
    s.meshy_keys = ["m"]
    assert [p.name for p in build_chain(s)] == ["tripo", "meshy", "hf"]
    s.tripo_keys, s.meshy_keys, s.hf_tokens = [], [], []
    assert build_chain(s) == []                   # generic fallback only


def test_hf_error_mapping():
    assert hf_map_error(Exception("You have exceeded your GPU quota (60s requested vs. 0s left)")).quota
    assert hf_map_error(Exception("Connection reset by peer")).retryable
    other = hf_map_error(Exception("ValueError: bad image"))
    assert not other.quota and not other.retryable


# ---------------------------------------------------------------- Bright Data
def test_brightdata_trigger_progress_download():
    calls = []

    def h(req):
        calls.append((req.method, req.url.path, dict(req.url.params)))
        assert req.headers["authorization"] == "Bearer tok"
        if req.url.path == "/datasets/v3/trigger":
            return httpx.Response(200, json={"snapshot_id": "sd_1"})
        if req.url.path == "/datasets/v3/progress/sd_1":
            return httpx.Response(200, json={"status": "ready", "records": 2})
        return httpx.Response(200, json=[{"a": 1}, {"a": 2}])

    bd = BrightData("tok", client(h))
    sid = bd.trigger("gd_x", [{"url": "u"}], discover_by="url", limit_per_input=15)
    assert sid == "sd_1"
    assert calls[0][2] == {"dataset_id": "gd_x", "include_errors": "true", "type": "discover_new",
                           "discover_by": "url", "limit_per_input": "15"}
    assert bd.progress(sid)["status"] == "ready"
    assert bd.download(sid) == [{"a": 1}, {"a": 2}]


def test_brightdata_plain_text_rejection_and_not_ready():
    # recorded live: the API answers 200/4xx with a plain-text reason
    bd = BrightData("tok", client(lambda r: httpx.Response(200, text="Customer is not active")))
    with pytest.raises(ProviderError, match="rejected"):
        bd.trigger("gd_x", [{}], discover_by="keyword")
    nr = BrightData("tok", client(lambda r: httpx.Response(200, json={"status": "running", "message": "Snapshot is not ready yet, try again in 30s"})))
    with pytest.raises(ProviderError) as e:
        nr.download("sd_1")
    assert e.value.retryable


def test_brightdata_sync_scrape_is_capped_at_20_urls():
    bd = BrightData("tok", client(lambda r: httpx.Response(200, json=[])))
    with pytest.raises(ValueError):
        bd.scrape_sync("gd_x", [{"url": str(i)} for i in range(21)])
    assert bd.scrape_sync("gd_x", [{"url": "u"}]) == []


def test_brightdata_needs_a_token_and_a_zone(monkeypatch):
    monkeypatch.setenv("BD_UNLOCKER_ZONE", "")          # worker/.env may set one
    with pytest.raises(ProviderError):
        BrightData("", client(lambda r: httpx.Response(200))).progress("x")
    with pytest.raises(ProviderError, match="ZONE"):
        BrightData("tok", client(lambda r: httpx.Response(200))).unlock("https://x", zone="")


# ---------------------------------------------------------------- verify
def test_is_gone():
    assert is_gone({"error": "This content isn't available right now", "error_code": "dead_page"})
    assert is_gone({"is_sold": True})
    assert not is_gone({"title": "Side table", "is_sold": False})


def test_meshy_flattens_transparent_cutouts_onto_gray():
    import io

    from PIL import Image

    from worker.providers.meshy import MESHY_BG, flatten
    im = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    im.paste((255, 255, 255, 255), (5, 5, 15, 15))                  # a white object on transparency
    buf = io.BytesIO()
    im.save(buf, "PNG")
    out = Image.open(io.BytesIO(flatten(buf.getvalue())))
    assert out.mode == "RGB" and out.getpixel((0, 0)) == MESHY_BG and out.getpixel((10, 10)) == (255, 255, 255)
    assert flatten(b"not an image") == b"not an image"
