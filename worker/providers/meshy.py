"""Meshy (only in the chain when MESHY_API_KEYS is set).

  POST /openapi/v1/image-to-3d        {image_url (https or data URI), ai_model, should_texture, ...} -> {result: id}
  POST /openapi/v1/multi-image-to-3d  {image_urls: [front, ...], ...}                               -> {result: id}
  GET  /openapi/v1/{image-to-3d|multi-image-to-3d}/{id} -> status PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED,
                                                          progress, model_urls.glb
402 = insufficient credits or free plan (task creation needs a paid plan): the key is cooled down.
A textured image-to-3D task costs 30 credits (docs.meshy.ai/en/api/pricing, Nov 2026).
"""
from __future__ import annotations

import base64
import io
import os

import httpx

from ..limits import ProviderError, classify_http
from ..storage import fetch_bytes
from . import PollResult, Provider, View

API = "https://api.meshy.ai/openapi/v1"


def _err(r: httpx.Response) -> ProviderError:
    try:
        msg = r.json().get("message") or r.text[:200]
    except ValueError:
        msg = r.text[:200]
    if r.status_code == 402:
        return ProviderError(f"meshy 402: {msg}", quota=True, quota_kind="day", retry_after=12 * 3600, status=402)
    if r.status_code in (401, 403):
        return ProviderError(f"meshy {r.status_code}: {msg}", quota=True, quota_kind="day", retry_after=24 * 3600,
                             status=r.status_code)
    return classify_http(r.status_code, str(msg), r.headers.get("retry-after"), "meshy")


# Meshy runs its own background removal and composites transparent pixels onto white first, so a white chair
# back on a transparent cutout vanished. Flatten onto mid gray: it contrasts with white and black items alike.
MESHY_BG = (128, 128, 128)


def flatten(png: bytes, bg: tuple[int, int, int] = MESHY_BG) -> bytes:
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(png))
        if im.mode not in ("RGBA", "LA", "PA") and "transparency" not in im.info:
            return png
        im = im.convert("RGBA")
    except Exception:  # noqa: BLE001 - not an image we can read: send it as is and let Meshy judge
        return png
    out = Image.new("RGB", im.size, bg)
    out.paste(im, mask=im.getchannel("A"))
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(flatten(png)).decode()


class Meshy(Provider):
    name = "meshy"
    timeout_s = 360
    supports_multi = True

    def __init__(self, keys, client=None):
        super().__init__(keys, client)
        self.ai_model = os.getenv("MESHY_AI_MODEL", "latest")
        self.polycount = int(os.getenv("MESHY_TARGET_POLYCOUNT", "30000"))

    def _h(self, key: str) -> dict:
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def _req(self, method: str, url: str, key: str, **kw) -> dict:
        try:
            r = self.client.request(method, url, headers=self._h(key), **kw)
        except httpx.HTTPError as e:
            raise ProviderError(f"meshy network error: {e}", retryable=True) from e
        if r.status_code >= 400:
            raise _err(r)
        return r.json()

    def submit(self, views: list[View], key: str) -> str:
        common = {"ai_model": self.ai_model, "should_texture": True, "enable_pbr": False, "should_remesh": True,
                  "topology": "triangle", "target_polycount": self.polycount, "target_formats": ["glb"]}
        if len(views) >= 2:
            # the first image is the front view; never more than 4
            ordered = sorted(views, key=lambda v: {"front": 0, "three_quarter": 1, "side": 2, "back": 3}.get(v.angle, 9))[:4]
            body = self._req("POST", f"{API}/multi-image-to-3d", key,
                             json={**common, "image_urls": [data_uri(v.png) for v in ordered]})
            kind = "multi-image-to-3d"
        else:
            body = self._req("POST", f"{API}/image-to-3d", key, json={**common, "image_url": data_uri(views[0].png)})
            kind = "image-to-3d"
        task = body.get("result")
        if not task:
            raise ProviderError(f"meshy returned no task id: {str(body)[:120]}")
        return f"{kind}/{task}"

    def poll(self, job_id: str, key: str) -> PollResult:
        body = self._req("GET", f"{API}/{job_id}", key)
        status = body.get("status")
        if status == "SUCCEEDED":
            url = (body.get("model_urls") or {}).get("glb")
            if not url:
                return PollResult("failed", error="succeeded without a glb url")
            return PollResult("done", glb=fetch_bytes(url, self.client, max_mb=80, timeout=120))
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            err = (body.get("task_error") or {}).get("message") or status
            return PollResult("failed", error=str(err)[:200])
        return PollResult("running", progress=body.get("progress"))
