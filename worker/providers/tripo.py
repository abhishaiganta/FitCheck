"""Tripo3D (primary provider). API v2: upload image -> create task -> poll task.

  POST /v2/openapi/upload/sts   multipart file            -> data.image_token
  POST /v2/openapi/task         {type: image_to_model | multiview_to_model, ...} -> data.task_id
  GET  /v2/openapi/task/{id}    -> data.status, data.output.pbr_model | model
"""
from __future__ import annotations

import httpx

from ..limits import ProviderError, classify_http
from ..storage import fetch_bytes
from . import PollResult, Provider, View

API = "https://api.tripo3d.ai/v2/openapi"
# Tripo error codes that mean "this key cannot run jobs right now"
QUOTA_CODES = {2010: 6 * 3600, 2000: 60, 2018: 6 * 3600}   # no credit, rate limited, quota


def _err(r: httpx.Response) -> ProviderError:
    try:
        body = r.json()
    except ValueError:
        body = {}
    code = body.get("code")
    msg = f"tripo {r.status_code} code={code}: {body.get('message') or r.text[:160]}"
    if code in QUOTA_CODES or "credit" in msg.lower():
        return ProviderError(msg, quota=True, quota_kind="day", retry_after=QUOTA_CODES.get(code, 6 * 3600),
                             status=r.status_code)
    if r.status_code in (401, 403) and code in (1001, 1002, 1003, None):
        return ProviderError(msg, quota=True, quota_kind="day", retry_after=24 * 3600, status=r.status_code)  # bad key
    return classify_http(r.status_code, msg, r.headers.get("retry-after"), "tripo")


class Tripo(Provider):
    name = "tripo"
    timeout_s = 360
    supports_multi = True

    def _h(self, key: str) -> dict:
        return {"Authorization": f"Bearer {key}"}

    def _json(self, r: httpx.Response) -> dict:
        if r.status_code >= 400:
            raise _err(r)
        body = r.json()
        if body.get("code") not in (0, None):
            raise _err(r)
        return body.get("data") or {}

    def _req(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            return self.client.request(method, url, **kw)
        except httpx.HTTPError as e:
            raise ProviderError(f"tripo network error: {e}", retryable=True) from e

    def _upload(self, png: bytes, key: str) -> str:
        r = self._req("POST", f"{API}/upload/sts", headers=self._h(key), files={"file": ("cutout.png", png, "image/png")})
        token = self._json(r).get("image_token")
        if not token:
            raise ProviderError("tripo upload returned no image_token")
        return token

    def submit(self, views: list[View], key: str) -> str:
        by_angle = {v.angle: v for v in views}
        if len(views) >= 2 and "front" in by_angle and ("side" in by_angle or "back" in by_angle):
            # multiview order is fixed: [front, left, back, right]; missing views are empty objects
            slots = [by_angle.get("front"), by_angle.get("side"), by_angle.get("back"), None]
            files = [{"type": "png", "file_token": self._upload(v.png, key)} if v else {} for v in slots]
            body = {"type": "multiview_to_model", "files": files, "texture": True, "pbr": True}
        else:
            body = {"type": "image_to_model", "file": {"type": "png", "file_token": self._upload(views[0].png, key)},
                    "texture": True, "pbr": True}
        r = self._req("POST", f"{API}/task", headers=self._h(key), json=body)
        task = self._json(r).get("task_id")
        if not task:
            raise ProviderError("tripo returned no task_id")
        return task

    def poll(self, job_id: str, key: str) -> PollResult:
        r = self._req("GET", f"{API}/task/{job_id}", headers=self._h(key))
        data = self._json(r)
        status = data.get("status")
        if status == "success":
            out = data.get("output") or {}
            url = out.get("pbr_model") or out.get("model") or out.get("base_model")
            if not url:
                return PollResult("failed", error="success without a model url")
            return PollResult("done", glb=fetch_bytes(url, self.client, max_mb=80, timeout=120))
        if status in ("failed", "cancelled", "banned", "expired", "unknown"):
            return PollResult("failed", error=f"task {status}")
        return PollResult("running", progress=data.get("progress"))
