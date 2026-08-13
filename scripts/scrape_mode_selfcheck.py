"""Self-check for quick vs full scrape selection.

Run: python scripts/scrape_mode_selfcheck.py

Two things here fail silently rather than loudly:
  * a quick run that skips an item whose price DOES still move - the page then
    shows a stale number for a week and nothing complains;
  * argv drift, where an unrecognised mode string quietly becomes "quick" and
    the weekly full sweep never actually happens.
Both are asserted below. The ISO-week half of the rule lives in utils.js and is
covered by scrape_mode_selfcheck.js.
"""
import sys, os, json
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
import scraper

def day(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).date().isoformat()

def item(name, series):
    return {"list_item": name,
            "ww_price_history": [{"date": d, "price": p} for d, p in series],
            "price_history": [], "coles_price_history": []}

# 1. A price frozen well past the cutoff is skipped.
frozen = item("Frozen", [(day(700), 3.0), (day(500), 3.0), (day(300), 3.0), (day(1), 3.0)])
assert "Frozen" in scraper._quick_skip_set([frozen]), "a long-frozen price should be skipped"

# 2. A price that moved recently is NOT skipped.
moved = item("Moved", [(day(700), 3.0), (day(400), 3.0), (day(60), 3.0), (day(20), 4.0)])
assert "Moved" not in scraper._quick_skip_set([moved]), "a recently changed price must be checked"

# 3. The case the whole design turns on: an item that swings on a cycle is NOT
#    stale just because it is sitting still today. Skipping these would mean
#    missing the next swing, which is the only reason to scrape at all.
cyclic = item("Cyclic", [(day(240), 9.0), (day(180), 6.0), (day(120), 9.0),
                         (day(60), 6.0), (day(20), 9.0)])
assert "Cyclic" not in scraper._quick_skip_set([cyclic]), "a cycling price must keep being checked"

# 4. Anything we cannot judge is scraped. Cheaper to check than to be wrong.
assert scraper._quick_skip_set([item("Thin", [(day(300), 2.0), (day(10), 2.0)])]) == set(), \
    "too little history must fall through to being scraped"
assert scraper._quick_skip_set([{"list_item": "Empty"}]) == set(), "no history at all -> scrape it"
assert scraper._quick_skip_set([]) == set()
assert scraper._quick_skip_set(None) == set()
# Undated rows cannot place a change in time, so they must not create a skip.
undated = {"list_item": "Undated", "price_history": [{"price": 5} for _ in range(6)],
           "ww_price_history": [], "coles_price_history": []}
assert scraper._quick_skip_set([undated]) == set(), "undated history must not be treated as settled"

# 5. Exactly at the boundary the item is still watched (the gate is "older than").
edge = item("Edge", [(day(400), 1.0), (day(300), 1.0), (day(200), 1.0),
                     (day(int(scraper.QUICK_STALE_MONTHS * 30.44) - 3), 2.0)])
assert "Edge" not in scraper._quick_skip_set([edge]), "just inside the window must be checked"

# 6. Real data: a quick run has to be a genuine saving AND still cover most of
#    the catalogue. If either end drifts, this fails rather than quietly turning
#    "quick" into "everything" or into "almost nothing".
here = os.path.dirname(__file__)
items = json.load(open(os.path.join(here, "..", "docs", "data", "latest.json")))["items"]
skip = scraper._quick_skip_set(items)
frac = len(skip) / len(items)
assert 0.05 < frac < 0.60, f"quick skips {frac:.0%} of the catalogue - out of sensible range"
assert scraper.QUICK_STALE_MONTHS >= 3, "too short a window would skip items mid-cycle"

# ── Pinned items must not undo the quick filter ─────────────────────────────
# The bug: this selection runs AFTER the quick filter and picks items "not
# currently on the list", so every settled item the filter had just dropped was
# immediately eligible again. With most of the catalogue pinned, a quick run
# went 181 -> 163 -> 295 and took the full 16 minutes while printing that it had
# skipped 49.
_pa = scraper._pinned_additions
_OV = {"Settled": {"ww_url": "u"}, "Moving": {"ww_url": "u"},
       "Listed": {"ww_url": "u"}, "Deleted": {"ww_url": "u"},
       "NoUrl": {}, "undefined": {"ww_url": "u"}}

assert _pa(_OV, {"Listed"}, {"Deleted"}, {"Settled"}) == ["Moving"], \
    "quick must add only pins that are unlisted, undeleted and not settled"
# A FULL run passes no skip set and must keep every pin - this is the half that
# proves the fix did not quietly shrink full scrapes too.
assert _pa(_OV, {"Listed"}, {"Deleted"}) == ["Settled", "Moving"], \
    "a full run must keep pinned items the quick filter would have dropped"
assert "NoUrl" not in _pa(_OV, set(), set()), "a pin with no URL is not scrapable"
assert "undefined" not in _pa(_OV, set(), set()), "the literal 'undefined' key is not an item"
assert _pa({}, set(), set()) == [] and _pa(None, set(), set()) == [], \
    "no overrides file means nothing to add"

# On the REAL data, with the real pin file: passing the skip set must actually
# hold items back. Comparing quick-with-guard against quick-without-guard is the
# comparison that matters - against a FULL run both look the same, because there
# the settled items are still on the list and so are never "additions" at all.
_ov_real = json.load(open(os.path.join(here, "..", "docs", "data", "url_overrides.json")))
_names = {i["list_item"] for i in items}
_after_filter = _names - skip
_without = len(_pa(_ov_real, _after_filter, set()))          # the old behaviour
_with = len(_pa(_ov_real, _after_filter, set(), skip))       # the fix
assert _with < _without, (
    f"the quick filter is being undone: pins add back {_without} items without "
    f"the guard and {_with} with it - these must differ")
# And the guard must cost a full run nothing.
assert _pa(_ov_real, _names, set()) == _pa(_ov_real, _names, set(), set()), \
    "an empty skip set must leave a full run's pin list identical"

# ── Category refresh: the dispatch string must be SPLIT into real names ─────
# Regression guard for a bug that failed SILENTLY. A category's refresh button
# sends every member in one pipe-separated dispatch; the scrape branch used to
# hand that whole string to the store search as if it were one product name.
# Woolworths answered HTTP 400, nothing got priced, and the run still reported
# success - so a 6-product category just stayed blank, with no error anywhere.
_rt = scraper._refresh_targets
assert _rt("A 60pk|B 180pk|C 360pk") == ["A 60pk", "B 180pk", "C 360pk"], \
    "a category refresh must split into its members"
assert _rt("Bread 750g") == ["Bread 750g"], \
    "a plain single-item refresh is a one-entry list"
assert _rt(" A | B ") == ["A", "B"], "names must be trimmed"
assert _rt("A||B|") == ["A", "B"], "empty segments must be dropped, not scraped as blanks"
assert _rt("") == [] and _rt(None) == [], "no item at all means nothing to scrape"

# The structural half of the fix: the scrape branch must never hand the raw
# dispatch string to _scrape_single_item again. The split above can be perfect
# and the bug is still back if that call is reintroduced.
import inspect
import re as _re
_BAD_CALL = "_scrape_single_item" + r"\(\s*\n?\s*single_item\b"
assert not _re.search(_BAD_CALL, inspect.getsource(scraper.scrape)), \
    "scrape() must scrape each split NAME, never the raw pipe-joined dispatch string"

print(f"scrape_mode_selfcheck: 12/12 OK  (quick skips {len(skip)}/{len(items)}"
      f" = {frac:.0%}, scrapes {len(items) - len(skip)})")

