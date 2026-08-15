"""Self-check for _compact_history() - the price-history recording rule.

The rule: keep the first point, keep every price CHANGE, and keep an unchanged
"still valid" confirmation only once it is >=7 days after the last KEPT point.

Why this exists: the append-time guard (_should_add_history_entry) was correct in
isolation yet 598 same-price entries <7 days apart still accumulated, because
overlapping scrape runs each booted from a different latest.json snapshot and
both appended for the same day. _compact_history enforces the rule over the whole
array instead, so it must be right about the cases the guard could not see -
above all it must never drop a real price movement.

Run: python history_compact_selfcheck.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scraper import _compact_history  # noqa: E402


def h(*pairs):
    return [{"date": d, "price": p} for d, p in pairs]


def dates(hist):
    return [e["date"] for e in hist]


def check(label, got, want):
    assert got == want, f"{label}\n  got:  {got}\n  want: {want}"
    print(f"  ok  {label}")


print("_compact_history:")

# The reported bug: a week of identical daily prices collapses to the first point.
check(
    "daily unchanged run collapses to first",
    dates(_compact_history(h(
        ("2026-08-08", 3.75), ("2026-08-09", 3.75), ("2026-08-10", 3.75),
        ("2026-08-11", 3.75), ("2026-08-12", 3.75), ("2026-08-13", 3.75),
        ("2026-08-14", 3.75),
    ))),
    ["2026-08-08"],
)

# The whole point of the 7-day confirmation: it must still land.
check(
    "unchanged point >=7 days later is kept as a confirmation",
    dates(_compact_history(h(("2026-08-08", 3.75), ("2026-08-15", 3.75)))),
    ["2026-08-08", "2026-08-15"],
)

check(
    "6 days is not yet a confirmation",
    dates(_compact_history(h(("2026-08-08", 3.75), ("2026-08-14", 3.75)))),
    ["2026-08-08"],
)

# The critical property: never lose a price the item actually sold at.
check(
    "every price change survives, however close together",
    dates(_compact_history(h(
        ("2026-08-08", 3.75), ("2026-08-09", 2.50), ("2026-08-10", 3.75),
    ))),
    ["2026-08-08", "2026-08-09", "2026-08-10"],
)

check(
    "a one-day promo dip between flat weeks is kept",
    dates(_compact_history(h(
        ("2026-08-01", 5.00), ("2026-08-02", 5.00), ("2026-08-03", 3.00),
        ("2026-08-04", 5.00), ("2026-08-05", 5.00),
    ))),
    ["2026-08-01", "2026-08-03", "2026-08-04"],
)

# Same-date duplicates (23 items had these) collapse, last wins.
check(
    "same-date duplicates collapse to one",
    _compact_history([
        {"date": "2026-08-13", "price": 6.0},
        {"date": "2026-08-13", "price": 6.0},
    ]),
    [{"date": "2026-08-13", "price": 6.0}],
)

# Idempotence - a compacted array must survive re-compaction unchanged, or the
# next scrape would keep eroding history that already satisfies the rule.
_once = _compact_history(h(
    ("2026-08-01", 5.00), ("2026-08-02", 5.00), ("2026-08-08", 5.00),
    ("2026-08-09", 4.00), ("2026-08-20", 4.00),
))
check("idempotent", _compact_history(_once), _once)

# Ordering: entries can arrive out of order from a merge; the rule is applied
# chronologically, not in arrival order.
check(
    "out-of-order input is sorted before the rule is applied",
    dates(_compact_history(h(
        ("2026-08-14", 3.75), ("2026-08-08", 3.75), ("2026-08-11", 9.99),
    ))),
    ["2026-08-08", "2026-08-11", "2026-08-14"],
)

# This function DELETES data, so anything it cannot parse must be kept.
check(
    "unparseable price is kept, not dropped",
    len(_compact_history([
        {"date": "2026-08-08", "price": 3.75},
        {"date": "2026-08-09", "price": None},
    ])),
    2,
)
check(
    "unparseable date is kept, not dropped",
    len(_compact_history([
        {"date": "2026-08-08", "price": 3.75},
        {"date": "not-a-date", "price": 3.75},
    ])),
    2,
)

check("empty history stays empty", _compact_history([]), [])

# Multi-buy points carry shelf/mb alongside price - compaction must preserve the
# whole entry, not rebuild a bare {date, price}.
_mb = [{"date": "2026-08-13", "price": 3.75, "shelf": 5.5, "mb": {"qty": 2, "total": 7.5}}]
check("entry fields (shelf/mb) are preserved", _compact_history(_mb), _mb)

print("\nAll history-compaction self-checks passed.")
