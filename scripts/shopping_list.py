import pandas as pd
from thefuzz import fuzz
import json
import os

KNOWN_NAME_CHANGES = {
    "Woolworths Natural Greek Style Yoghurt": "Woolworths Greek Style Yoghurt",
    "Home Chef Quiche Lorraine Chilled Meal": "Hedy's Fresh Quiche Lorraine Chilled Meal",
    "Home Chef Quiche Spinach & Feta Chilled Meal": "Hedy's Fresh Quiche Spinach & Feta Chilled Meal",
    "Woolworths Freshwater Basa Fillets Thawed": "Woolworths Basa Fillets Boneless With Skin Off",
    "Eat Later Hass Avocado": "Hass Avocado",
    "Hass Avocado": "Hass Avocado",
    "Radish Fresh": "Fresh Radish Bunch",
    "Woolworths Short Cut Bacon": "Woolworths Shortcut Bacon",
    "Corn Sweet": "Woolworths Corn Sweet",
    # Same product recorded under an older prefix-less name - merge the history
    # into the current "Woolworths …" name so it shows as one item.
    "Capsicum Green": "Woolworths Capsicum Green",
    # All name variants of WW product 95171 (fresh Tasmanian Atlantic skin-on
    # fillets) map to one canonical name so their split purchase history merges
    # into a single item instead of showing as duplicates.
    "Salmon Tasmanian Atlantic Fillets Skin On": "Woolworths Fresh Tasmanian Atlantic Skin On Salmon Fillets",
    "Woolworths Salmon Tasmanian Atlantic Fillets Skin On": "Woolworths Fresh Tasmanian Atlantic Skin On Salmon Fillets",
    # 2026-07-02 dedup: URL-level duplicates (same store product under two list
    # names). Alias → kept name; Excel history merges under the kept name and
    # _purge_alias_items drops lingering alias rows from scraper output.
    "Balconi Mix Max Spgnckes Cocoa": "Balconi Mix Max Cake Cocoa 350g",
    "Basa Thawed Freshwater Basa Fillets": "Woolworths Basa Fillets Boneless With Skin Off",
    "Vevelle 2 Ply White Toilet Tissue": "Vevelle White 2 Ply Toilet Tissue",
    "Woolworths Whole Milk Full Cream Milk": "Woolworths Full Cream Milk",
    "Snickers Milk Chocolate Party Share Bag": "Snickers Milk Chocolate Party Share Bag 20 Pieces",
    "Strike 2 Ply Paper Towel 2 Ply": "Strike Paper Towels Embossed 2 Ply",
    "Woolworths Green Asparagus Bunch Green": "Woolworths Asparagus Green Bunch",
    "Woolworths Lamb Mince": "Lamb Mince",
    "Woolworths Red Onions": "Woolworths Red Onions Bag",
    "Arnold's Farm Granola Pink Lady Apple & Cinnamon": "Sam's Pantry Granola Pink Lady Apple & Cinnamon",
    "Eat Now Hass Avocado": "Hass Avocado",
    "Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone In 500g - 650g": "Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone-In",
    "Coles RSPCA Approved Chicken Thigh Cutlets": "Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone-In",
    "Macro Grass Fed Australian Lamb Mince 450g (15% fat)": "Macro Grass Fed Australian Lamb Mince 450g",
    "El- Amin's Halal Lamb Mince | 500g": "El-Amin's Halal Lamb Mince 500g",
    "Woolworths Basa Portions 260g": "Woolworths Basa Fillets Boneless With Skin Off",
    "I&J Frozen Basa Fillets 750g": "Woolworths Basa Fillets Boneless With Skin Off",
    "Coles Frozen Basa Fillet": "Woolworths Basa Fillets Boneless With Skin Off",
    "Coles 3 Star Lamb Mince 500g": "Lamb Mince",
    "Coles RSPCA Approved Free Range Chicken Breast Fillet Small Pack 600g": "Woolworths RSPCA Approved Chicken Breast Fillet",
    "Coles RSPCA Approved Chicken Drumsticks 2kg": "Woolworths RSPCA Approved Chicken Drumsticks",
    "Tassal Salmon Portions Skin On 300g": "Woolworths Salmon Portions Skin On",
    "El-Amin's Beef Lean Mince 500g": "Woolworths Lean Beef Mince",
    # 2026-08-08: dishwashing tablets became a per-tablet category, and a category
    # member needs its pack count IN the name (groupMetric reads packCountOf on
    # the list_item first). Renaming here keeps the existing purchase history
    # attached instead of stranding it under the countless old name.
    # WW 184248, a 100 pack - this is the product the receipts are for. It was
    # briefly aliased to the 30pk (183866), a different product entirely.
    "Shine Dishwashing Tablets": "Shine Dishwashing Tablets 100pk",
    # Same reason, for the per-bag garbage bag category (WW 367232 is a 20 pack).
    "Armada Evergreen Garbage Bags Extra Large": "Armada Evergreen Garbage Bags Extra Large 20pk",
}

# Resolve alias chains (A→B plus B→C would leave A pointing at a name that itself
# renames - one clean_name() pass would then split A's history from C's). Fixpoint
# here means a single dict lookup is always final. Self-maps (X→X) terminate naturally.
for _k in list(KNOWN_NAME_CHANGES):
    _v, _hops = KNOWN_NAME_CHANGES[_k], 0
    while _v in KNOWN_NAME_CHANGES and KNOWN_NAME_CHANGES[_v] != _v and _hops < 10:
        _v, _hops = KNOWN_NAME_CHANGES[_v], _hops + 1
    KNOWN_NAME_CHANGES[_k] = _v

FUZZY_THRESHOLD = 85


def clean_name(name: str) -> str:
    if not isinstance(name, str):
        return ""
    # Normalize non-breaking spaces and other whitespace variants
    name = name.replace("\xa0", " ").strip()
    name = name.replace(" NULL", "").replace("NULL", "").strip()
    return KNOWN_NAME_CHANGES.get(name, name)


def detect_fuzzy_changes(items: list[str], flag_path: str) -> dict:
    flagged = {}
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            score = fuzz.token_sort_ratio(a, b)
            if score >= FUZZY_THRESHOLD and a != b:
                flagged[f"{a} → {b}"] = score
    with open(flag_path, "w") as f:
        json.dump(flagged, f, indent=2)
    return flagged


def get_purchase_history(excel_path: str, min_trips: int = 2) -> dict:
    """
    Returns {item_name: {trip_count, price_history: [{date, price}]}}
    for items bought in at least min_trips distinct shopping dates.
    """
    if not os.path.exists(excel_path):
        raise FileNotFoundError(f"Shopping list not found: {excel_path}")
    try:
        df = pd.read_excel(excel_path, sheet_name="Data")
    except Exception as e:
        raise RuntimeError(f"Could not read shopping list ({excel_path}): {e}") from e
    df["Item"] = df["Item"].apply(clean_name)
    df = df[df["Item"] != ""]

    # SheetJS round-trips strip Excel date cell types, leaving plain floats
    # (e.g. 46020.0 for a 2026 date).  pd.to_datetime interprets those as
    # nanoseconds, yielding 1970-01-01.  Convert via the Excel epoch instead.
    _EXCEL_EPOCH = pd.Timestamp("1899-12-30")

    def _parse_date(val):
        if pd.isna(val):
            return pd.NaT
        if isinstance(val, pd.Timestamp):
            return val
        try:
            n = float(val)
            if 1.0 <= n <= 73050.0:           # Excel serials: 1900-01-01 … 2099-12-31
                return _EXCEL_EPOCH + pd.Timedelta(days=n)
        except (ValueError, TypeError):
            pass
        return pd.to_datetime(val, errors="coerce")

    df["Date"] = df["Date"].apply(_parse_date)

    trip_counts = df.groupby("Item")["Date"].nunique()
    frequent = trip_counts[trip_counts >= min_trips].index
    df_freq = df[df["Item"].isin(frequent)]

    result = {}
    for item, grp in df_freq.groupby("Item"):
        grp_sorted = grp.sort_values("Date")
        prices = []
        for _, row in grp_sorted.iterrows():
            val = row.get("Unit price")
            if pd.notna(val) and float(val) > 0:
                prices.append({
                    "date": row["Date"].strftime("%Y-%m-%d"),
                    "price": round(float(val), 2),
                })
        result[item] = {
            "trip_count": int(trip_counts[item]),
            "price_history": prices,
        }
    return result


def get_active_shopping_list(excel_path: str, min_trips: int = 2) -> list[str]:
    return sorted(get_purchase_history(excel_path, min_trips).keys())


if __name__ == "__main__":
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "shopping_list.xlsx"
    min_trips = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    history = get_purchase_history(path, min_trips)
    print(f"{len(history)} items bought in {min_trips}+ trips:")
    for item, data in sorted(history.items(), key=lambda x: -x[1]["trip_count"]):
        print(f"  {data['trip_count']:3}×  {item}")
