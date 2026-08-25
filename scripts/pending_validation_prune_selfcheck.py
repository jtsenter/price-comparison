"""A pending_validation flag must survive until a run that ACTUALLY re-examines
that exact item resolves it - not merely because the item was PRESENT in that
run's output.

The bug this pins down, confirmed in this repo's own commit history:

  chore: update prices           (trigger=manual)          pending_validation: 1  [Cavendish Bananas]
  chore: update archived prices  (trigger=scrape_archived)  pending_validation: 0

The archived sweep never looked at Cavendish Bananas - it only scrapes the ~36
archived items - but it cleared the flag anyway. Cause: the "auto-resolve a
stale flag when its item scrapes cleanly" step measured "scraped this run" from
items_output AFTER the carry-forward pass had already appended the ENTIRE
non-archived catalog into it (every scrape run preserves everything it didn't
touch, or the item would vanish from the table). So "in items_output" stopped
meaning "scraped this run" and started meaning "scraped this run OR merely
carried forward untouched" - and an archived-only sweep carries forward almost
everything, so it wiped almost every stale flag on its very next commit.

Run: python scripts/pending_validation_prune_selfcheck.py
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _prune_resolved_pending_validation  # noqa: E402

n = 0
failures = []


def check(label, cond, detail=""):
    global n
    n += 1
    if cond:
        print(f"  ok  {label}")
    else:
        failures.append(label)
        print(f"  FAIL {label}" + (f"\n       {detail}" if detail else ""))


def by_item(pv_list):
    return {e["item"]: e for e in pv_list}


# ── THE regression, at the user's own scale (4 flagged items) ───────────────
existing_pv = {
    "Cavendish Bananas":  {"item": "Cavendish Bananas",  "reason": ["30pct_change"]},
    "Lamb Mince 500g":    {"item": "Lamb Mince 500g",    "reason": ["30pct_change"]},
    "Chia Seeds 400g":    {"item": "Chia Seeds 400g",    "reason": ["30pct_change"]},
    "Aero Peppermint":    {"item": "Aero Peppermint",    "reason": ["30pct_change"]},
}
# An archived-only sweep: it scraped 36 archived items, none of which are the
# four flagged ones above.
archived_freshly_scraped = {"Christmas Pudding 900g", "Easter Eggs Variety Pack"}

result = _prune_resolved_pending_validation(existing_pv, [], archived_freshly_scraped)
check(
    "an archived-only sweep does not touch flags on non-archived items",
    len(result) == 4 and by_item(result).keys() == existing_pv.keys(),
    f"got {sorted(by_item(result).keys())}",
)

# A single-item refresh of an unrelated product (e.g. the Bamba Osem fix): must
# not touch the four either.
single_item_scraped = {"Osem Snacks Bamba With Peanuts"}
result2 = _prune_resolved_pending_validation(existing_pv, [], single_item_scraped)
check(
    "a single-item refresh of something else leaves every flag alone",
    len(result2) == 4,
    f"got {len(result2)}",
)

# ── The self-healing case this logic exists FOR must still work ─────────────
# Cavendish Bananas gets genuinely rescraped in the next full run and the price
# has settled back to normal - no new validation entry for it this time.
full_run_scraped = set(existing_pv.keys()) | {"Milk 2L", "Bread Rolls 6pk"}
result3 = _prune_resolved_pending_validation(existing_pv, [], full_run_scraped)
check(
    "an item genuinely rescraped clean this run DOES drop its stale flag",
    "Cavendish Bananas" not in by_item(result3),
    f"still present: {by_item(result3).keys()}",
)
check(
    "that clean re-scrape resolves ALL four, since all four were rescraped",
    len(result3) == 0,
    f"got {len(result3)}",
)

# ── A fresh re-flag always wins, whether or not the item was already pending ─
new_flag_same_item = [{"item": "Cavendish Bananas", "reason": ["outside_history"]}]
result4 = _prune_resolved_pending_validation(existing_pv, new_flag_same_item, full_run_scraped)
check(
    "a NEW validation entry replaces the old one for that item, not both",
    by_item(result4)["Cavendish Bananas"]["reason"] == ["outside_history"],
    f"got {by_item(result4).get('Cavendish Bananas')}",
)
check(
    "the other three, rescraped clean, still drop",
    len(result4) == 1,
    f"got {len(result4)}",
)

new_flag_unseen_item = [{"item": "Tahini Neri 300g", "reason": ["30pct_change"]}]
result5 = _prune_resolved_pending_validation({}, new_flag_unseen_item, set())
check(
    "a brand-new flag is added even with no prior pending_validation and no scrape set",
    by_item(result5).keys() == {"Tahini Neri 300g"},
)

# ── Edges ─────────────────────────────────────────────────────────────────────
check("everything empty produces nothing", _prune_resolved_pending_validation({}, [], set()) == [])
check(
    "an item flagged and then immediately re-flagged in the same run keeps the new one",
    by_item(_prune_resolved_pending_validation(
        {}, [{"item": "X", "reason": ["a"]}, {"item": "X", "reason": ["b"]}], set()
    ))["X"]["reason"] == ["b"],
)

# ── Source-shape guard: the call site must pass the PRE-carry-forward set ───
SRC = io.open(os.path.join(os.path.dirname(__file__), "scraper.py"), encoding="utf-8").read()
check(
    "the call site passes scraped_names (captured before carry-forward), not items_output",
    "_prune_resolved_pending_validation(existing_pv, new_validation_entries, scraped_names)" in SRC,
    "passing a post-carry-forward set is exactly how the bug got in",
)
check(
    "the old inline recompute-from-items_output pattern is gone",
    'scraped_this_run = {i["list_item"] for i in items_output}' not in SRC,
)
check(
    "scraped_names is captured before the carry-forward loop actually appends anything",
    SRC.index('scraped_names = {i["list_item"] for i in items_output}')
        < SRC.index("items_output.append(ex)"),
    "if scraped_names were captured AFTER the carry-forward append, it would just be items_output again",
)

print()
if failures:
    print(f"pending_validation_prune_selfcheck: {len(failures)} FAILED")
    sys.exit(1)
print(f"pending_validation_prune_selfcheck: all {n} assertions passed")
