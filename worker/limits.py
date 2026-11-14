"""Shared rate-limit module (spec section 5). Mirrored by web/lib/limits.ts.

- acquire(provider, per_minute, per_day, keys=...) increments provider_usage atomically
  (upsert on the current minute/day window), raises QuotaExceeded when a cap is hit and
  returns the key to use. Multi-key providers rotate in order, skipping keys in cooldown.
- cooldown(): on 429 / quota errors (Gemini daily -> next midnight Pacific, Gemini minute -> 65 s,
  HF -> first_use_today + 24h, Tripo/Meshy -> what the response says, default 15 min).
- with_retry(): exponential backoff + jitter (1s, 2s, 4s, 8s, max 5 tries), retryable errors only.
- circuit breaker: 5 consecutive failures opens the breaker for 10 minutes.

State lives in Neon (provider_usage / provider_state) so the worker and web share one ledger.
The clock, sleep and rng are injectable so tests run on a mock clock.
"""
from __future__ import annotations

import hashlib
import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Protocol, Sequence, TypeVar
from zoneinfo import ZoneInfo

log = logging.getLogger("worker.limits")
T = TypeVar("T")

try:
    PACIFIC = ZoneInfo("America/Los_Angeles")
except Exception:  # Windows without tzdata: fixed offset is close enough for a cooldown
    PACIFIC = timezone(timedelta(hours=-8))

BREAKER_THRESHOLD = 5
BREAKER_OPEN_SEC = 600
BACKOFF_BASE_SEC = 1.0
MAX_TRIES = 5
DEFAULT_COOLDOWN_SEC = 15 * 60
GEMINI_MINUTE_COOLDOWN_SEC = 65


class QuotaExceeded(Exception):
    """Every key for this provider is at its cap, cooling down, or breaker-open."""

    def __init__(self, provider: str, reason: str = "quota"):
        super().__init__(f"{provider}: {reason}")
        self.provider = provider
        self.reason = reason


class ProviderError(Exception):
    """Typed provider failure. retryable=True for network / 429 / 5xx."""

    def __init__(self, message: str, *, retryable: bool = False, quota: bool = False,
                 quota_kind: str | None = None, retry_after: float | None = None, status: int | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.quota = quota
        self.quota_kind = quota_kind      # 'minute' | 'day' | None
        self.retry_after = retry_after
        self.status = status


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def provider_name(provider: str, key: str | None) -> str:
    return f"{provider}:{key_hash(key)}" if key else provider


def next_midnight_pacific(now: datetime) -> datetime:
    local = now.astimezone(PACIFIC)
    nxt = (local + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
    return nxt.astimezone(timezone.utc)


def floor_window(now: datetime, kind: str) -> datetime:
    now = now.astimezone(timezone.utc)
    if kind == "minute":
        return now.replace(second=0, microsecond=0)
    # 'day' windows follow the Pacific day, because Gemini daily caps reset at midnight Pacific
    local = now.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0)
    return local.astimezone(timezone.utc)


# --------------------------------------------------------------------------- stores
class Store(Protocol):
    def try_incr(self, provider: str, windows: list[tuple[str, datetime, int]]) -> bool: ...
    def get_state(self, provider: str) -> dict | None: ...
    def set_cooldown(self, provider: str, until: datetime | None, note: str | None) -> None: ...
    def touch_first_use(self, provider: str, now: datetime, reset_after_sec: float) -> datetime: ...
    def usage(self, provider: str, kind: str, window_start: datetime) -> int: ...


class MemoryStore:
    """In-process store for unit tests and for running without a database."""

    def __init__(self) -> None:
        self.counts: dict[tuple[str, str, datetime], int] = {}
        self.state: dict[str, dict] = {}

    def try_incr(self, provider, windows):
        for kind, start, cap in windows:
            if cap is not None and self.counts.get((provider, kind, start), 0) >= cap:
                return False
        for kind, start, _ in windows:
            self.counts[(provider, kind, start)] = self.counts.get((provider, kind, start), 0) + 1
        return True

    def get_state(self, provider):
        return self.state.get(provider)

    def set_cooldown(self, provider, until, note):
        self.state.setdefault(provider, {"provider": provider, "first_use_today": None})
        self.state[provider].update(cooldown_until=until, note=note)

    def touch_first_use(self, provider, now, reset_after_sec):
        st = self.state.setdefault(provider, {"provider": provider, "cooldown_until": None, "note": None,
                                              "first_use_today": None})
        fu = st.get("first_use_today")
        if fu is None or (now - fu).total_seconds() >= reset_after_sec:
            st["first_use_today"] = now
        return st["first_use_today"]

    def usage(self, provider, kind, window_start):
        return self.counts.get((provider, kind, window_start), 0)


class PgStore:
    """provider_usage / provider_state in Neon. All increments are atomic single statements in one tx."""

    def __init__(self, db) -> None:
        self.db = db

    def try_incr(self, provider, windows):
        try:
            with self.db.tx() as conn:
                for kind, start, cap in windows:
                    cur = conn.execute(
                        """insert into provider_usage (provider, window_start, window_kind, count)
                           values (%s, %s, %s, 1)
                           on conflict (provider, window_kind, window_start)
                           do update set count = provider_usage.count + 1
                           where provider_usage.count < %s
                           returning count""",
                        (provider, start, kind, cap if cap is not None else 2_000_000_000))
                    if cur.fetchone() is None:
                        raise _CapHit()
            return True
        except _CapHit:
            return False

    def get_state(self, provider):
        return self.db.one("select * from provider_state where provider = %s", (provider,))

    def set_cooldown(self, provider, until, note):
        self.db.x("""insert into provider_state (provider, cooldown_until, note) values (%s,%s,%s)
                     on conflict (provider) do update set cooldown_until = excluded.cooldown_until, note = excluded.note""",
                  (provider, until, note))

    def touch_first_use(self, provider, now, reset_after_sec):
        row = self.db.one(
            """insert into provider_state (provider, first_use_today) values (%s, %s)
               on conflict (provider) do update set first_use_today =
                 case when provider_state.first_use_today is null
                        or provider_state.first_use_today <= %s - make_interval(secs => %s)
                      then excluded.first_use_today else provider_state.first_use_today end
               returning first_use_today""",
            (provider, now, now, reset_after_sec))
        return row["first_use_today"]

    def usage(self, provider, kind, window_start):
        row = self.db.one("select count from provider_usage where provider=%s and window_kind=%s and window_start=%s",
                          (provider, kind, window_start))
        return row["count"] if row else 0


class _CapHit(Exception):
    pass


# --------------------------------------------------------------------------- limiter
@dataclass
class Lease:
    provider: str          # ledger name, e.g. 'gemini:1a2b3c4d'
    key: str | None        # the API key to use (None for single-credential providers)


class Limits:
    def __init__(self, store: Store | None = None, *, clock: Callable[[], datetime] | None = None,
                 sleep: Callable[[float], None] = time.sleep, rng: Callable[[], float] = random.random):
        self.store: Store = store or MemoryStore()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.sleep = sleep
        self.rng = rng
        self._fails: dict[str, int] = {}
        self._breaker_until: dict[str, datetime] = {}

    # ---- availability ----------------------------------------------------
    def cooling(self, pname: str) -> datetime | None:
        now = self.clock()
        b = self._breaker_until.get(pname)
        if b and b > now:
            return b
        st = self.store.get_state(pname)
        cu = st.get("cooldown_until") if st else None
        if cu and cu > now:
            return cu
        return None

    def acquire(self, provider: str, per_minute: int | None = None, per_day: int | None = None,
                keys: Sequence[str] | None = None, *, daily_window_from_first_use: bool = False) -> Lease:
        """Reserve one call. Tries keys in order; raises QuotaExceeded if none is usable."""
        now = self.clock()
        candidates: list[str | None] = list(keys) if keys else [None]
        if keys is not None and not keys:
            raise QuotaExceeded(provider, "no keys configured")
        reasons = []
        for key in candidates:
            pname = provider_name(provider, key)
            until = self.cooling(pname)
            if until:
                reasons.append(f"{pname} cooling until {until.isoformat(timespec='seconds')}")
                continue
            windows: list[tuple[str, datetime, int]] = []
            if per_day is not None:
                if daily_window_from_first_use:      # HF: quota resets 24h after first use
                    start = self.store.touch_first_use(pname, now, 24 * 3600)
                else:
                    start = floor_window(now, "day")
                windows.append(("day", start, per_day))
            if per_minute is not None:
                windows.append(("minute", floor_window(now, "minute"), per_minute))
            if not windows:
                windows.append(("day", floor_window(now, "day"), None))  # still count usage
            if self.store.try_incr(pname, windows):
                return Lease(pname, key)
            reasons.append(f"{pname} at cap")
        raise QuotaExceeded(provider, "; ".join(reasons) or "quota")

    # ---- outcomes ---------------------------------------------------------
    def success(self, pname: str) -> None:
        self._fails[pname] = 0

    def failure(self, pname: str) -> bool:
        """Count a failure. Returns True if this opened the circuit breaker."""
        n = self._fails.get(pname, 0) + 1
        self._fails[pname] = n
        if n >= BREAKER_THRESHOLD:
            until = self.clock() + timedelta(seconds=BREAKER_OPEN_SEC)
            self._breaker_until[pname] = until
            self._fails[pname] = 0
            try:
                self.store.set_cooldown(pname, until, "circuit breaker: 5 consecutive failures")
            except Exception as e:
                log.warning("could not persist breaker for %s: %s", pname, e)
            log.warning("circuit breaker OPEN for %s until %s", pname, until)
            return True
        return False

    def cooldown(self, pname: str, *, kind: str | None = None, retry_after: float | None = None,
                 note: str | None = None) -> datetime:
        """Put a provider/key on cooldown after a 429 or quota error."""
        now = self.clock()
        base = pname.split(":")[0]
        if retry_after is not None and retry_after > 0:
            until = now + timedelta(seconds=retry_after)
        elif base == "gemini" and kind == "day":
            until = next_midnight_pacific(now)
        elif base == "gemini":
            until = now + timedelta(seconds=GEMINI_MINUTE_COOLDOWN_SEC)
        elif base == "hf":
            st = self.store.get_state(pname)
            fu = (st or {}).get("first_use_today") or now
            until = fu + timedelta(hours=24)
            if until <= now:
                until = now + timedelta(hours=24)
        else:
            until = now + timedelta(seconds=DEFAULT_COOLDOWN_SEC)
        self.store.set_cooldown(pname, until, note or f"quota ({kind or 'rate'})")
        log.warning("%s cooling down until %s (%s)", pname, until.isoformat(timespec="seconds"), note or kind)
        return until

    # ---- retry ------------------------------------------------------------
    def with_retry(self, fn: Callable[[], T], *, pname: str | None = None, tries: int = MAX_TRIES,
                   is_retryable: Callable[[Exception], bool] | None = None) -> T:
        """Exponential backoff + jitter: 1s, 2s, 4s, 8s (max 5 tries). Quota errors are never retried here:
        they raise immediately so the caller can cool the key down and rotate."""
        retryable = is_retryable or default_retryable
        last: Exception | None = None
        for attempt in range(tries):
            try:
                out = fn()
                if pname:
                    self.success(pname)
                return out
            except Exception as e:  # noqa: BLE001 - classified below
                last = e
                if isinstance(e, ProviderError) and e.quota:
                    raise
                if not retryable(e) or attempt == tries - 1:
                    if pname:
                        self.failure(pname)
                    raise
                delay = BACKOFF_BASE_SEC * (2 ** attempt) + self.rng() * 0.5
                log.info("retry %d/%d in %.1fs after %s", attempt + 1, tries - 1, delay, e)
                self.sleep(delay)
        raise last  # pragma: no cover

    def call(self, provider: str, fn: Callable[[str | None], T], *, keys: Sequence[str] | None = None,
             per_minute: int | None = None, per_day: int | None = None,
             daily_window_from_first_use: bool = False, tries: int = MAX_TRIES) -> T:
        """acquire -> call with retry -> on quota error cool that key and rotate to the next one."""
        n = len(keys) if keys else 1
        last: Exception | None = None
        for _ in range(n):
            lease = self.acquire(provider, per_minute, per_day, keys,
                                 daily_window_from_first_use=daily_window_from_first_use)
            try:
                return self.with_retry(lambda: fn(lease.key), pname=lease.provider, tries=tries)
            except ProviderError as e:
                last = e
                if e.quota:
                    self.cooldown(lease.provider, kind=e.quota_kind, retry_after=e.retry_after, note=str(e)[:200])
                    continue
                raise
        raise QuotaExceeded(provider, f"all keys exhausted: {last}")


def default_retryable(e: Exception) -> bool:
    if isinstance(e, ProviderError):
        return e.retryable
    try:
        import httpx
        if isinstance(e, (httpx.TransportError, httpx.TimeoutException)):
            return True
    except Exception:  # pragma: no cover
        pass
    return isinstance(e, (TimeoutError, ConnectionError))


def classify_http(status: int, body: str = "", retry_after: str | None = None, provider: str = "") -> ProviderError:
    """Map an HTTP failure to a typed error (spec 14: retry only network / 429 / 5xx)."""
    ra: float | None = None
    try:
        ra = float(retry_after) if retry_after else None
    except ValueError:
        ra = None
    snippet = (body or "")[:300]
    low = snippet.lower()
    if status == 429 or "resource_exhausted" in low or "quota" in low and status in (403, 429):
        kind = "day" if ("per day" in low or "perday" in low or "daily" in low) else "minute"
        return ProviderError(f"{provider} {status} quota: {snippet}", quota=True, quota_kind=kind,
                             retry_after=ra, status=status)
    if status in (402,) or "insufficient" in low or "not enough credit" in low or "no credit" in low:
        return ProviderError(f"{provider} {status} out of credits: {snippet}", quota=True, quota_kind="day",
                             retry_after=ra or 6 * 3600, status=status)
    if status >= 500 or status == 408:
        return ProviderError(f"{provider} {status}: {snippet}", retryable=True, status=status)
    return ProviderError(f"{provider} {status}: {snippet}", retryable=False, status=status)
