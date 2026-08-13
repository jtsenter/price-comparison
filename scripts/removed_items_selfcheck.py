"""Self-check for the permanent-delete gate (docs/data/removed_items.json).

The browser can purge every JSON file, but it CANNOT edit shopping_list.xlsx.
So the only thing stopping a deleted product coming back is the scraper reading
this tombstone file. That is a silent failure mode - a regression here shows up
days later as a resurrected product, exactly like the "Plum Red" incident - so
the three gates are asserted directly against scraper.py's source.

Gates:
  1. purchase_history  - drops the name from BOTH the active and archived lists
  2. url_overrides     - a leftover pin must not re-add it
  3. existing_map      - carry-forward must not restore it from latest.json

Run: python scripts/removed_items_selfcheck.py
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "scraper.py")
DATA = os.path.join(ROOT, "docs", "data", "removed_items.json")


def _run():
    n = 0
    src = open(SRC, encoding="utf-8").read()

    # ── the file itself ──────────────────────────────────────────────────────
    assert os.path.exists(DATA), "docs/data/removed_items.json is missing - the gate has no input"
    names = json.load(open(DATA, encoding="utf-8"))
    assert isinstance(names, list), "removed_items.json must be a JSON array of names"
    assert all(isinstance(x, str) and x for x in names), "every entry must be a non-empty string"
    assert len(names) == len(set(names)), "removed_items.json contains duplicates"
    n += 4

    # ── the scraper actually loads it ────────────────────────────────────────
    assert "removed_items.json" in src, "scraper.py never reads removed_items.json"
    assert re.search(r"removed_set\s*:\s*set\[str\]\s*=\s*set\(\)", src), "removed_set not initialised"
    n += 2

    # ── gate 1: the shopping list (via purchase_history) ─────────────────────
    assert re.search(
        r"purchase_history\s*=\s*\{[^}]*if\s+k\s+not\s+in\s+removed_set", src
    ), "gate 1 missing: purchase_history is not filtered by removed_set"
    assert "archived_set -= removed_set" in src, "gate 1 missing: archived_set is not filtered"
    n += 2

    # ── gate 2: url_overrides manual adds ────────────────────────────────────
    # This used to grep the inline `manually_added = [...]` comprehension. That
    # selection now lives in _pinned_additions(), so exercise the function: a
    # behavioural check survives refactoring and proves more than the text did.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from scraper import _pinned_additions
    _ov = {"Deleted": {"ww_url": "u"}, "Kept": {"ww_url": "u"}}
    assert _pinned_additions(_ov, set(), {"Deleted"}) == ["Kept"], \
        "gate 2 missing: a pinned URL can still resurrect a deleted item"
    assert _pinned_additions(_ov, set(), {"Deleted", "Kept"}) == [], \
        "gate 2 missing: removed_set must win over every pin"
    # The call site must still be passing the tombstone set in.
    assert re.search(r"_pinned_additions\(\s*\n?\s*_url_ov,\s*shopping_set,\s*removed_set", src), \
        "gate 2 missing: scrape() does not pass removed_set to _pinned_additions"
    n += 3

    # ── gate 3: carry-forward from latest.json ───────────────────────────────
    assert re.search(r"for\s+_rm\s+in\s+removed_set:\s*\n\s*existing_map\.pop\(_rm,\s*None\)", src), \
        "gate 3 missing: existing_map carry-forward can restore a deleted item"
    n += 1

    # ── the UI half writes the same file ─────────────────────────────────────
    app = open(os.path.join(ROOT, "docs", "app.js"), encoding="utf-8").read()
    assert "docs/data/removed_items.json" in app, "app.js never writes the tombstone file"
    assert "deleteItemsForever" in app, "the delete action is missing from app.js"
    # The tombstone must be written BEFORE the other purges, so a mid-way failure
    # still leaves the item blocked rather than resurrecting it.
    i_tomb = app.index("docs/data/removed_items.json")
    i_latest = app.index("docs/data/latest.json", app.index("async function deleteItemsForever"))
    assert i_tomb < i_latest, "tombstone must be written before the other purges"
    n += 3

    # utils.js merges the file into the in-memory set the sync filters read
    utils = open(os.path.join(ROOT, "docs", "utils.js"), encoding="utf-8").read()
    assert "function mergeRemovedItems" in utils and "function loadRemovedItems" in utils, \
        "utils.js does not merge removed_items.json into REMOVED_ITEMS"
    n += 1

    print(f"removed_items_selfcheck: all {n} cases passed ({len(names)} tombstoned name(s))")


if __name__ == "__main__":
    _run()
