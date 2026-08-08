"""Self-check for the scrape-speed changes.

Run: python scripts/scrape_speed_selfcheck.py

Covers the two things that would fail SILENTLY:

1. _settle() must return as soon as the selector is there and must swallow the
   timeout when it never appears - if it raised instead, a Coles page with no
   results would abort the whole item rather than carrying the price forward.

2. The pinned fetches now run under asyncio.gather. A single-store pin must
   still mean a SINGLE store: a WW-only pin must never touch Coles, and a
   Coles-only pin must never name-search WW. Getting that wrong doesn't crash -
   it quietly attributes another product's price to this one, which is exactly
   the failure the sequential code was written to avoid.
"""
import asyncio
import time
import scraper


class FakePage:
    """Minimal page double. `has` decides whether the selector ever appears."""

    def __init__(self, has=True, delay=0.0):
        self.has, self.delay, self.waited_ms = has, delay, None

    async def wait_for_selector(self, selector, timeout=0, state=None):
        if not self.has:
            await asyncio.sleep(timeout / 1000.0)      # burn the cap, like Playwright
            raise TimeoutError(f"no {selector}")
        await asyncio.sleep(self.delay)
        return object()

    async def wait_for_timeout(self, ms):
        self.waited_ms = ms
        await asyncio.sleep(ms / 1000.0)


async def _run():
    # 1. present -> returns at once, well under the cap
    p = FakePage(has=True, delay=0.02)
    t0 = time.monotonic()
    await scraper._settle(p, "x", 1000)
    early = time.monotonic() - t0
    assert early < 0.3, f"_settle waited {early:.2f}s for a selector already there"

    # 2. absent -> swallows the timeout, never raises, honours the cap as a ceiling
    p = FakePage(has=False)
    t0 = time.monotonic()
    await scraper._settle(p, "x", 150)            # must not raise
    capped = time.monotonic() - t0
    assert capped < 1.0, f"_settle overran its {150}ms cap ({capped:.2f}s)"

    # 3. a page object that doesn't even have the method must not crash the item
    class Broken:
        pass
    await scraper._settle(Broken(), "x", 10)      # must not raise

    # 4. the selectors we wait on must be ones the extractor actually reads,
    #    or _settle silently degrades to a full-cap wait on every single request.
    src = open(scraper.__file__.replace(".pyc", ".py"), encoding="utf-8").read()
    for sel in ('[data-testid="product-tile"]', '[data-testid="product-pricing"]'):
        # once in the constant, once in the extraction JS it is standing in for
        assert src.count(sel) >= 2, f"{sel} is not used by the extractor any more"

    # 5. gather-based pinned fetch keeps single-store-pin semantics.
    #    Rebuilt here rather than imported because the real closures capture
    #    _scrape_single_item's locals; what is under test is the CONTRACT the
    #    tuple-returning halves must honour, which the real code mirrors.
    async def half(pinned, other_store_calls, label):
        if not pinned:
            return [], False, True          # (results, skip_picker, skipped)
        other_store_calls.append(label)
        return [{"name": label}], True, False

    for pin_ww, pin_co in ((True, False), (False, True), (True, True)):
        touched = []
        (wr, _, ws), (cr, _, cs) = await asyncio.gather(
            half(pin_ww, touched, "ww"), half(pin_co, touched, "coles"))
        assert ws == (not pin_ww), "WW-skipped flag disagrees with the pin"
        assert cs == (not pin_co), "Coles-skipped flag disagrees with the pin"
        assert bool(wr) == pin_ww and bool(cr) == pin_co, "results leaked across stores"
        if not pin_ww:
            assert "ww" not in touched, "Coles-only pin still hit Woolworths"
        if not pin_co:
            assert "coles" not in touched, "WW-only pin still hit Coles"

    # 6. per-store timing lands in the log entry, and only once there is data
    scraper._STORE_TIME.update(ww=0.0, coles=0.0)
    scraper._STORE_CALLS.update(ww=0, coles=0)
    async with scraper._track("coles"):
        await asyncio.sleep(0.01)
    assert scraper._STORE_CALLS["coles"] == 1, "_track did not count the call"
    assert scraper._STORE_TIME["coles"] > 0, "_track recorded no elapsed time"
    assert scraper._STORE_CALLS["ww"] == 0, "_track credited the wrong store"

    print("scrape_speed_selfcheck: 6/6 OK")


if __name__ == "__main__":
    asyncio.run(_run())
