"""limits.acquire windows, cooldown and rotation on a mock clock (spec section 9), plus retry and breaker."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from worker.limits import (BREAKER_THRESHOLD, Limits, MemoryStore, PgStore, ProviderError, QuotaExceeded,
                           classify_http, floor_window, key_hash, next_midnight_pacific, provider_name)


def make(clock, store=None):
    return Limits(store or MemoryStore(), clock=clock, sleep=clock.sleep, rng=lambda: 0.0)


# ---------------------------------------------------------------- windows
def test_per_minute_cap_then_new_window(clock):
    lim = make(clock)
    for _ in range(3):
        assert lim.acquire("brightdata", per_minute=3).key is None
    with pytest.raises(QuotaExceeded):
        lim.acquire("brightdata", per_minute=3)
    clock.advance(seconds=31)            # 12:01:01 -> next minute window
    assert lim.acquire("brightdata", per_minute=3)


def test_per_day_cap_resets_at_midnight_pacific(clock):
    lim = make(clock)
    lim.acquire("x", per_day=2)
    lim.acquire("x", per_day=2)
    with pytest.raises(QuotaExceeded):
        lim.acquire("x", per_day=2)
    clock.advance(hours=11)              # 23:00 Pacific, same day
    with pytest.raises(QuotaExceeded):
        lim.acquire("x", per_day=2)
    clock.advance(hours=2)               # 01:00 Pacific next day
    assert lim.acquire("x", per_day=2)


def test_a_rejected_call_does_not_consume_the_other_window(clock):
    store = MemoryStore()
    lim = make(clock, store)
    lim.acquire("x", per_minute=1, per_day=10)
    with pytest.raises(QuotaExceeded):
        lim.acquire("x", per_minute=1, per_day=10)
    assert store.usage("x", "day", floor_window(clock(), "day")) == 1


def test_day_window_is_the_pacific_day():
    t = datetime(2026, 11, 15, 7, 30, tzinfo=timezone.utc)      # 23:30 Pacific on the 14th
    assert floor_window(t, "day") == datetime(2026, 11, 14, 8, 0, tzinfo=timezone.utc)
    assert next_midnight_pacific(t) == datetime(2026, 11, 15, 8, 0, 5, tzinfo=timezone.utc)


# ---------------------------------------------------------------- rotation + cooldown
def test_rotation_moves_to_next_key_at_cap(clock):
    lim = make(clock)
    keys = ["k1", "k2", "k3"]
    used = [lim.acquire("gemini", per_minute=2, keys=keys).key for _ in range(6)]
    assert used == ["k1", "k1", "k2", "k2", "k3", "k3"]
    with pytest.raises(QuotaExceeded):
        lim.acquire("gemini", per_minute=2, keys=keys)


def test_cooldown_skips_key_until_it_expires(clock):
    lim = make(clock)
    keys = ["k1", "k2"]
    lim.cooldown(provider_name("gemini", "k1"), kind="minute")          # 65 s
    assert lim.acquire("gemini", per_minute=5, keys=keys).key == "k2"
    clock.advance(seconds=64)
    assert lim.acquire("gemini", per_minute=5, keys=keys).key == "k2"
    clock.advance(seconds=2)
    assert lim.acquire("gemini", per_minute=5, keys=keys).key == "k1"


def test_gemini_daily_cooldown_lasts_until_midnight_pacific(clock):
    lim = make(clock)
    until = lim.cooldown(provider_name("gemini", "k1"), kind="day")
    assert until == next_midnight_pacific(clock())
    clock.advance(hours=11)
    with pytest.raises(QuotaExceeded):
        lim.acquire("gemini", per_minute=5, keys=["k1"])
    clock.advance(hours=1, minutes=1)
    assert lim.acquire("gemini", per_minute=5, keys=["k1"]).key == "k1"


def test_hf_quota_window_is_24h_from_first_use(clock):
    lim = make(clock)
    tok = ["hf_a"]
    for _ in range(3):
        lim.acquire("hf", per_day=3, keys=tok, daily_window_from_first_use=True)
    with pytest.raises(QuotaExceeded):
        lim.acquire("hf", per_day=3, keys=tok, daily_window_from_first_use=True)
    clock.advance(hours=23, minutes=59)      # crosses midnight, still inside the 24 h window
    with pytest.raises(QuotaExceeded):
        lim.acquire("hf", per_day=3, keys=tok, daily_window_from_first_use=True)
    clock.advance(minutes=2)
    assert lim.acquire("hf", per_day=3, keys=tok, daily_window_from_first_use=True)


def test_hf_cooldown_is_first_use_plus_24h(clock):
    lim = make(clock)
    first = clock()
    lim.acquire("hf", per_day=3, keys=["hf_a"], daily_window_from_first_use=True)
    clock.advance(hours=5)
    until = lim.cooldown(provider_name("hf", "hf_a"))
    assert until == first + timedelta(hours=24)


def test_retry_after_from_the_response_wins(clock):
    lim = make(clock)
    until = lim.cooldown("tripo:abc", retry_after=120)
    assert until == clock() + timedelta(seconds=120)
    assert lim.cooldown("meshy:abc") == clock() + timedelta(minutes=15)      # default


def test_no_keys_configured_raises(clock):
    with pytest.raises(QuotaExceeded):
        make(clock).acquire("meshy", keys=[])


def test_key_hash_never_leaks_the_key():
    assert "secret" not in provider_name("gemini", "secret-key-value")
    assert len(key_hash("secret-key-value")) == 8


# ---------------------------------------------------------------- retry + breaker
def test_backoff_is_1_2_4_8_then_gives_up(clock):
    lim = make(clock)
    calls = []

    def boom():
        calls.append(1)
        raise ProviderError("503", retryable=True)

    with pytest.raises(ProviderError):
        lim.with_retry(boom, pname="p")
    assert len(calls) == 5
    assert clock.slept == [1.0, 2.0, 4.0, 8.0]


def test_non_retryable_and_quota_errors_are_not_retried(clock):
    lim = make(clock)
    n = {"a": 0, "b": 0}

    def bad_request():
        n["a"] += 1
        raise ProviderError("400", retryable=False)

    def quota():
        n["b"] += 1
        raise ProviderError("429", quota=True)

    with pytest.raises(ProviderError):
        lim.with_retry(bad_request)
    with pytest.raises(ProviderError):
        lim.with_retry(quota)
    assert n == {"a": 1, "b": 1} and clock.slept == []


def test_retry_succeeds_after_transient_failures(clock):
    lim = make(clock)
    state = {"n": 0}

    def flaky():
        state["n"] += 1
        if state["n"] < 3:
            raise ProviderError("502", retryable=True)
        return "ok"

    assert lim.with_retry(flaky) == "ok"
    assert clock.slept == [1.0, 2.0]


def test_circuit_breaker_opens_after_5_failures_for_10_minutes(clock):
    lim = make(clock)
    name = provider_name("tripo", "k")
    opened = [lim.failure(name) for _ in range(BREAKER_THRESHOLD)]
    assert opened == [False, False, False, False, True]
    assert lim.cooling(name) == clock() + timedelta(minutes=10)
    with pytest.raises(QuotaExceeded):
        lim.acquire("tripo", per_minute=10, keys=["k"])
    clock.advance(minutes=10, seconds=1)
    assert lim.cooling(name) is None
    assert lim.acquire("tripo", per_minute=10, keys=["k"]).key == "k"


def test_success_resets_the_failure_count(clock):
    lim = make(clock)
    for _ in range(4):
        lim.failure("p")
    lim.success("p")
    assert not lim.failure("p")
    assert lim.cooling("p") is None


def test_call_rotates_keys_on_quota_error(clock):
    lim = make(clock)
    seen = []

    def fn(key):
        seen.append(key)
        if key == "k1":
            raise ProviderError("429 per day", quota=True, quota_kind="day")
        return f"ok:{key}"

    assert lim.call("gemini", fn, keys=["k1", "k2"], per_minute=10) == "ok:k2"
    assert seen == ["k1", "k2"]
    # k1 is now cooling until midnight Pacific; the next call goes straight to k2
    assert lim.call("gemini", fn, keys=["k1", "k2"], per_minute=10) == "ok:k2"
    assert seen == ["k1", "k2", "k2"]


def test_call_raises_quota_exceeded_when_every_key_is_out(clock):
    lim = make(clock)

    def fn(key):
        raise ProviderError("429", quota=True, quota_kind="minute")

    with pytest.raises(QuotaExceeded):
        lim.call("gemini", fn, keys=["k1", "k2"], per_minute=10)


# ---------------------------------------------------------------- error mapping
@pytest.mark.parametrize("status,body,retryable,quota", [
    (429, "rate limited", False, True),
    (500, "oops", True, False),
    (503, "unavailable", True, False),
    (408, "timeout", True, False),
    (400, "bad input", False, False),
    (404, "gone", False, False),
    (402, "payment required", False, True),
    (403, "insufficient credits", False, True),
])
def test_classify_http(status, body, retryable, quota):
    e = classify_http(status, body, None, "x")
    assert (e.retryable, e.quota) == (retryable, quota)


def test_classify_http_reads_retry_after():
    assert classify_http(429, "slow down", "42", "x").retry_after == 42


# ---------------------------------------------------------------- Postgres store (shared ledger)
def test_pg_store_atomic_caps_and_cooldown(db, clock):
    lim = Limits(PgStore(db), clock=clock, sleep=clock.sleep, rng=lambda: 0.0)
    keys = ["k1", "k2"]
    used = [lim.acquire("gemini", per_minute=2, per_day=3, keys=keys).key for _ in range(4)]
    assert used == ["k1", "k1", "k2", "k2"]
    with pytest.raises(QuotaExceeded):
        lim.acquire("gemini", per_minute=2, per_day=3, keys=keys)
    rows = db.q("select provider, window_kind, count from provider_usage order by 1, 2")
    assert [(r["window_kind"], r["count"]) for r in rows] == [("day", 2), ("minute", 2), ("day", 2), ("minute", 2)]
    clock.advance(minutes=1)
    assert lim.acquire("gemini", per_minute=2, per_day=3, keys=keys).key == "k1"     # day count 3
    clock.advance(minutes=1)
    assert lim.acquire("gemini", per_minute=2, per_day=3, keys=keys).key == "k2"     # k1 at its daily cap
    lim.cooldown(provider_name("gemini", "k2"), kind="minute")
    clock.advance(minutes=1)
    with pytest.raises(QuotaExceeded):
        lim.acquire("gemini", per_minute=2, per_day=3, keys=keys)
    st = db.one("select * from provider_state where provider = %s", (provider_name("gemini", "k2"),))
    assert st["cooldown_until"] is not None


def test_pg_store_hf_first_use_window(db, clock):
    lim = Limits(PgStore(db), clock=clock, sleep=clock.sleep)
    for _ in range(3):
        lim.acquire("hf", per_day=3, keys=["t"], daily_window_from_first_use=True)
    with pytest.raises(QuotaExceeded):
        lim.acquire("hf", per_day=3, keys=["t"], daily_window_from_first_use=True)
    clock.advance(hours=24, seconds=1)
    assert lim.acquire("hf", per_day=3, keys=["t"], daily_window_from_first_use=True)
