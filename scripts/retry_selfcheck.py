"""Self-check for search_with_retry (Fix A: retry-on-empty).

Run: python scripts/retry_selfcheck.py
Asserts the retry wrapper: returns on first hit, retries once on empty, and
gives up after exhausting retries. Patches asyncio.sleep so it runs instantly.
"""
import asyncio
import scraper


async def _run():
    _real_sleep = asyncio.sleep
    scraper.asyncio.sleep = lambda *_a, **_k: _real_sleep(0)  # skip real backoff

    calls = {"n": 0}

    async def hit(page, query):
        calls["n"] += 1
        return [{"name": "x"}]

    async def miss(page, query):
        calls["n"] += 1
        return []

    async def miss_then_hit(page, query):
        calls["n"] += 1
        return [] if calls["n"] == 1 else [{"name": "recovered"}]

    # 1. First attempt succeeds → no retry, exactly one call.
    calls["n"] = 0
    r = await scraper.search_with_retry(hit, None, "q", retries=1)
    assert r and calls["n"] == 1, f"expected 1 call, got {calls['n']}"

    # 2. Empty then hit → retry recovers it, two calls.
    calls["n"] = 0
    r = await scraper.search_with_retry(miss_then_hit, None, "q", retries=1)
    assert r and r[0]["name"] == "recovered" and calls["n"] == 2, f"got {r}, calls={calls['n']}"

    # 3. Persistent empty with retries=1 → two attempts, then [].
    calls["n"] = 0
    r = await scraper.search_with_retry(miss, None, "q", retries=1)
    assert r == [] and calls["n"] == 2, f"expected [] after 2 calls, got {r}, calls={calls['n']}"

    # 4. retries=0 → exactly one attempt (default behaviour unchanged).
    calls["n"] = 0
    r = await scraper.search_with_retry(miss, None, "q")
    assert r == [] and calls["n"] == 1, f"expected 1 call at retries=0, got {calls['n']}"

    print("retry_selfcheck: all 4 cases passed")


if __name__ == "__main__":
    asyncio.run(_run())
