"""Drives worker/exporter/index.html in headless Chromium (Playwright) and returns USDZ + GLB bytes."""
from __future__ import annotations

import base64
import functools
import http.server
import logging
import threading
from dataclasses import dataclass, field

from .config import WORKER_DIR

log = logging.getLogger("worker.exporter")
EXPORTER_DIR = WORKER_DIR / "exporter"


class ExportError(Exception):
    pass


class _Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
                      ".json": "application/json"}

    def log_message(self, *a):  # noqa: D401 - silence per-request logs
        pass


@dataclass
class ExportResult:
    usdz: bytes
    glb: bytes
    final_w_in: float
    final_d_in: float
    final_h_in: float
    orientation: str
    info: dict = field(default_factory=dict)


class Exporter:
    """Context manager. One Chromium page is reused for every export in a worker run."""

    def __init__(self, timeout_s: float = 180):
        self.timeout_ms = int(timeout_s * 1000)
        self._server: http.server.ThreadingHTTPServer | None = None
        self._pw = None
        self._browser = None
        self._page = None
        self._console: list[str] = []

    def __enter__(self) -> "Exporter":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def start(self) -> None:
        if self._page is not None:
            return
        from playwright.sync_api import sync_playwright

        handler = functools.partial(_Quiet, directory=str(EXPORTER_DIR))
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        port = self._server.server_address[1]
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._page = self._browser.new_page()
        self._page.set_default_timeout(self.timeout_ms)
        self._page.on("console", lambda m: self._console.append(f"{m.type}: {m.text}"[:300]))
        self._page.on("pageerror", lambda e: self._console.append(f"pageerror: {e}"[:300]))
        self._page.goto(f"http://127.0.0.1:{port}/index.html")
        try:
            self._page.wait_for_function("window.exporterReady === true", timeout=30_000)
        except Exception as e:
            raise ExportError(f"exporter page did not load: {e}; console={self._console[-5:]}") from e

    def close(self) -> None:
        for closer in (lambda: self._browser and self._browser.close(), lambda: self._pw and self._pw.stop(),
                       lambda: self._server and self._server.shutdown()):
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass
        self._page = self._browser = self._pw = self._server = None

    def _call(self, fn: str, payload: dict) -> dict:
        self.start()
        self._console.clear()
        try:
            return self._page.evaluate(f"(p) => window.{fn}(p)", payload)
        except Exception as e:  # noqa: BLE001
            msg = str(e).splitlines()[0][:300]
            errs = [c for c in self._console if c.startswith(("error", "pageerror"))][-3:]
            # a crashed page must not poison the next export
            try:
                self._page.reload()
                self._page.wait_for_function("window.exporterReady === true", timeout=30_000)
            except Exception:  # noqa: BLE001
                self.close()
            raise ExportError(f"{fn} failed: {msg} {errs}") from e

    def export_item(self, glb: bytes, *, w_in: float | None, d_in: float | None, h_in: float | None,
                    category: str, dims_source: str = "estimated", orient_override: str | None = None,
                    yaw_deg: float | None = None, max_texture: int = 1024, fit_box: bool = False) -> ExportResult:
        out = self._call("exportItem", {
            "glbB64": base64.b64encode(glb).decode(), "w_in": float(w_in or 0), "d_in": float(d_in or 0),
            "h_in": float(h_in or 0), "category": category, "dims_source": dims_source,
            "orient_override": orient_override, "yaw_deg": float(yaw_deg or 0), "max_texture": max_texture,
            "fit_box": bool(fit_box)})
        return self._result(out)

    def export_set(self, items: list[dict], max_texture: int = 1024) -> ExportResult:
        """items: [{glb: bytes, w_in, d_in, h_in, category, dims_source, x_in, y_in, z_in, yaw_deg}]"""
        payload = []
        for it in items:
            it = dict(it)
            it["glbB64"] = base64.b64encode(it.pop("glb")).decode()
            payload.append(it)
        out = self._call("exportSet", {"items": payload, "max_texture": max_texture})
        return self._result(out)

    def render_png(self, glb: bytes, size: int = 512) -> bytes:
        """Three-quarter preview of a GLB, for human checks during demo curation."""
        b64 = self._call("renderPng", {"glbB64": base64.b64encode(glb).decode(), "size": size})
        return base64.b64decode(b64)

    @staticmethod
    def _result(out: dict) -> ExportResult:
        f = out["final_in"]
        info = {k: v for k, v in out.items() if k not in ("usdzB64", "glbB64", "final_in")}
        return ExportResult(usdz=base64.b64decode(out["usdzB64"]), glb=base64.b64decode(out["glbB64"]),
                            final_w_in=f["w"], final_d_in=f["d"], final_h_in=f["h"],
                            orientation=out.get("orientation", "set"), info=info)
