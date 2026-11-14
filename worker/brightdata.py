"""Bright Data client (spec 6.1). Verified against the live API on Nov 14, 2026 (see NOTES.md):

  POST /datasets/v3/trigger?dataset_id=..&type=discover_new&discover_by=..&limit_per_input=N  -> {snapshot_id}
  GET  /datasets/v3/progress/{snapshot_id}                                                  -> {status: running|ready|failed}
  GET  /datasets/v3/snapshot/{snapshot_id}?format=json                                      -> [records]
  POST /datasets/v3/scrape?dataset_id=..   (synchronous, <= 20 URLs only)
  POST /request {zone, url, format: raw}   (Web Unlocker)

Batches over 20 URLs always use the async trigger / poll / download flow. Nothing here ever
runs while a judge is waiting: the web app reads Neon only.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import get_settings
from .limits import ProviderError, classify_http

log = logging.getLogger("worker.brightdata")
API = "https://api.brightdata.com"


class BrightData:
    def __init__(self, token: str | None = None, client: httpx.Client | None = None):
        self.token = token if token is not None else get_settings().bd_token
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, connect=15))

    def _headers(self) -> dict[str, str]:
        if not self.token:
            raise ProviderError("BRIGHTDATA_API_TOKEN is not set")
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    def _req(self, method: str, path: str, **kw: Any) -> httpx.Response:
        try:
            r = self.client.request(method, f"{API}{path}", headers=self._headers(), **kw)
        except httpx.HTTPError as e:
            raise ProviderError(f"brightdata network error: {e}", retryable=True) from e
        if r.status_code >= 400:
            raise classify_http(r.status_code, r.text, r.headers.get("retry-after"), "brightdata")
        return r

    def trigger(self, dataset_id: str, inputs: list[dict], *, discover_by: str | None = None,
                limit_per_input: int | None = None, limit_total: int | None = None) -> str:
        params: dict[str, Any] = {"dataset_id": dataset_id, "include_errors": "true"}
        if discover_by:
            params.update(type="discover_new", discover_by=discover_by)
        if limit_per_input:
            params["limit_per_input"] = limit_per_input
        if limit_total:
            params["limit_multiple_results"] = limit_total
        r = self._req("POST", "/datasets/v3/trigger", params=params, json=inputs)
        try:
            sid = r.json().get("snapshot_id")
        except ValueError:
            sid = None
        if not sid:
            # the API answers 200 with a plain-text reason for some rejections
            raise ProviderError(f"brightdata trigger rejected: {r.text[:200]}")
        return sid

    def progress(self, snapshot_id: str) -> dict:
        return self._req("GET", f"/datasets/v3/progress/{snapshot_id}").json()

    def download(self, snapshot_id: str) -> list[dict]:
        r = self._req("GET", f"/datasets/v3/snapshot/{snapshot_id}", params={"format": "json"}, timeout=180)
        try:
            data = r.json()
        except ValueError as e:
            raise ProviderError(f"brightdata snapshot is not JSON: {r.text[:200]}") from e
        if isinstance(data, dict):
            if data.get("status") in ("running", "building", "starting"):
                raise ProviderError("snapshot not ready", retryable=True)
            raise ProviderError(f"unexpected snapshot payload: {str(data)[:200]}")
        return data

    def scrape_sync(self, dataset_id: str, inputs: list[dict], timeout: float = 90) -> list[dict]:
        """Synchronous scrape: 20 URLs or fewer only (spec 6.1)."""
        if len(inputs) > 20:
            raise ValueError("scrape_sync is for <= 20 inputs; use trigger/progress/download")
        r = self._req("POST", "/datasets/v3/scrape", params={"dataset_id": dataset_id, "format": "json"},
                      json=inputs, timeout=timeout)
        try:
            data = r.json()
        except ValueError:
            return []
        if isinstance(data, dict):
            if data.get("snapshot_id"):       # took too long: the API fell back to async
                raise ProviderError(f"sync scrape went async: {data['snapshot_id']}", retryable=False)
            return [data]
        return data

    def unlock(self, url: str, zone: str | None = None, timeout: float = 90) -> str:
        """Web Unlocker fetch of one page (Craigslist)."""
        zone = zone or get_settings().bd_zone
        if not zone:
            raise ProviderError("BD_UNLOCKER_ZONE is not set")
        r = self._req("POST", "/request", json={"zone": zone, "url": url, "format": "raw"}, timeout=timeout)
        return r.text
