import json, re, sys
from pathlib import Path

data_path = Path("docs/data/latest.json")
data = json.loads(data_path.read_text())

pv = data.get("pending_validation", [])
if not pv:
    print("pending_validation is already empty. Nothing to do.")
    sys.exit(0)

# Deduplicate by item name — keep first occurrence only
seen = {}
for entry in pv:
    name = entry["item"]
    if name not in seen:
        seen[name] = entry

print(f"Unique items to approve: {len(seen)}")

# Build approved_prices from deduplicated entries
approved = {}
for name, entry in seen.items():
    approved[name] = {
        "ww_price": entry["ww_price"],
        "coles_price": entry["coles_price"],
        "approved_date": entry.get("flagged_date", "2026-05-31")
    }

data["approved_prices"] = approved
data["pending_validation"] = []

data_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
print(f"Done. approved_prices has {len(approved)} entries. pending_validation cleared.")
