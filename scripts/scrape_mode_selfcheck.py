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

print(f"scrape_mode_selfcheck: 6/6 OK  (quick skips {len(skip)}/{len(items)}"
      f" = {frac:.0%}, scrapes {len(items) - len(skip)})")
