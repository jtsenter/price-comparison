"""
One-off script: merge duplicate items in latest.json.

Pair 1: "Vevelle 2 Ply White Toilet Tissue" + "Vevelle White 2 Ply Toilet Tissue"
  Keep: "Vevelle White 2 Ply Toilet Tissue", merge price_history from both, drop the other.

Pair 2: "Woolworths Red Onions" + "Woolworths Red Onions Bag"
  Keep: "Woolworths Red Onions Bag", merge price_history from both, drop the other.

Merge rules:
  - Combine price_history from both, deduplicate by date (same date = keep higher price)
  - Sort by date ascending
  - All other fields (woolworths, coles, ww/coles_price_history, etc.) kept from the KEPT item
  - Dropped item removed entirely from the items array
"""

import json
from pathlib import Path

data_path = Path("docs/data/latest.json")
data = json.loads(data_path.read_text(encoding="utf-8"))
items = data["items"]

def find_item(name):
    for i, item in enumerate(items):
        if item["list_item"] == name:
            return i, item
    return None, None

def merge_price_history(hist_a, hist_b):
    """Merge two price_history arrays: deduplicate by date, keep higher price on conflict."""
    by_date = {}
    for e in (hist_a or []) + (hist_b or []):
        d = e.get("date")
        if not d:
            continue
        if d not in by_date or e.get("price", 0) > by_date[d].get("price", 0):
            by_date[d] = e
    return sorted(by_date.values(), key=lambda e: e.get("date", ""))

pairs = [
    {
        "keep":  "Vevelle White 2 Ply Toilet Tissue",
        "drop":  "Vevelle 2 Ply White Toilet Tissue",
    },
    {
        "keep":  "Woolworths Red Onions Bag",
        "drop":  "Woolworths Red Onions",
    },
]

for pair in pairs:
    keep_name = pair["keep"]
    drop_name = pair["drop"]

    ki, keep_item = find_item(keep_name)
    di, drop_item = find_item(drop_name)

    if keep_item is None:
        print(f"  SKIP: '{keep_name}' not found in latest.json")
        continue
    if drop_item is None:
        print(f"  SKIP: '{drop_name}' not found in latest.json — already merged?")
        continue

    before = len(keep_item.get("price_history") or [])
    merged = merge_price_history(
        keep_item.get("price_history"),
        drop_item.get("price_history"),
    )
    items[ki]["price_history"] = merged

    # Remove the dropped item
    items.pop(di if di < ki else di)  # adjust index if drop comes after keep

    print(f"Merged '{drop_name}' into '{keep_name}'")
    print(f"  price_history: {before} + {len(drop_item.get('price_history') or [])} entries "
          f"-> {len(merged)} after dedup")

data["items"] = items
data_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"\nDone. {len(items)} items remaining in latest.json.")
