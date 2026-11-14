"""Image-to-3D provider chain (spec 6.4): Tripo -> Meshy (only if keys) -> Hugging Face -> generic.

Every provider has the same two-step, resumable interface so a slow job never blocks the worker:
    submit(images, key) -> job id        poll(job id, key) -> PollResult
plus the blocking convenience wrapper the spec asks for:
    generate_glb(cutout_png_url) -> glb bytes   (5 s polling, per-provider timeout)
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

import httpx

from ..config import Settings
from ..limits import Limits, ProviderError, QuotaExceeded
from ..storage import fetch_bytes

POLL_SEC = 5


@dataclass
class View:
    png: bytes
    angle: str = "front"     # front | side | back | three_quarter


@dataclass
class PollResult:
    state: str               # running | done | failed
    glb: bytes | None = None
    progress: int | None = None
    error: str | None = None


class Provider:
    name = "base"
    timeout_s = 360
    per_minute: int | None = 10
    per_day: int | None = None
    daily_window_from_first_use = False
    supports_multi = False

    def __init__(self, keys: list[str], client: httpx.Client | None = None):
        self.keys = keys
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, connect=15))

    @property
    def configured(self) -> bool:
        return bool(self.keys)

    def submit(self, views: list[View], key: str) -> str:
        raise NotImplementedError

    def poll(self, job_id: str, key: str) -> PollResult:
        raise NotImplementedError

    def lease(self, limits: Limits, busy: set[str] | None = None):
        """Reserve a key that is not cooling down, not at its cap, and not already running a job
        (1 concurrent job per key). Raises QuotaExceeded when none is free."""
        from ..limits import key_hash
        free = [k for k in self.keys if not busy or key_hash(k) not in busy]
        if not free:
            raise QuotaExceeded(self.name, "busy")
        return limits.acquire(self.name, self.per_minute, self.per_day, free,
                              daily_window_from_first_use=self.daily_window_from_first_use)

    def generate_glb(self, cutout_png_url: str, limits: Limits | None = None,
                     sleep: Callable[[float], None] = time.sleep) -> bytes:
        """Blocking helper: one image in, GLB bytes out. Used by tools and tests; the gen stage uses
        submit/poll so it can return between polls."""
        limits = limits or Limits()
        lease = self.lease(limits)
        png = fetch_bytes(cutout_png_url, self.client)
        job = self.submit([View(png)], lease.key)
        deadline = time.monotonic() + self.timeout_s
        while time.monotonic() < deadline:
            res = self.poll(job, lease.key)
            if res.state == "done" and res.glb:
                return res.glb
            if res.state == "failed":
                raise ProviderError(f"{self.name} job failed: {res.error}")
            sleep(POLL_SEC)
        raise ProviderError(f"{self.name} job timed out after {self.timeout_s}s", retryable=False)


def build_chain(s: Settings) -> list[Provider]:
    """Real providers, in PROVIDER_ORDER (default: spec order tripo,meshy,hf). Providers without keys are
    left out. The generic fallback is handled by the gen stage itself.

    Nov 14: Tripo's API balance is 0 and Meshy has 2 generations left, while HF TRELLIS works for free
    (~1 min, good quality), so `PROVIDER_ORDER=hf,meshy,tripo` saves the paid credits for when HF is busy."""
    import os

    from .hf import HuggingFace
    from .meshy import Meshy
    from .tripo import Tripo

    make = {
        "tripo": lambda: Tripo(s.tripo_keys) if s.tripo_keys else None,
        "meshy": lambda: Meshy(s.meshy_keys) if s.meshy_keys else None,
        "hf": lambda: HuggingFace(s.hf_tokens, s.hf_space, per_day=s.hf_per_day) if s.hf_tokens else None,
    }
    order = [p.strip().lower() for p in os.getenv("PROVIDER_ORDER", "tripo,meshy,hf").split(",") if p.strip()]
    chain: list[Provider] = []
    for name in dict.fromkeys(order + ["tripo", "meshy", "hf"]):   # any provider not named goes last
        if name in make and (p := make[name]()) is not None:
            chain.append(p)
    return chain
