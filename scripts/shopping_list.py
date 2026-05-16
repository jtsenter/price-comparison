import pandas as pd
from thefuzz import fuzz
import json
import os

KNOWN_NAME_CHANGES = {
    "Woolworths Natural Greek Style Yoghurt": "Woolworths Greek Style Yoghurt",
    "Home Chef Quiche Lorraine Chilled Meal": "Hedy's Fresh Quiche Lorraine Chilled Meal",
    "Home Chef Quiche Spinach & Feta Chilled Meal": "Hedy's Fresh Quiche Spinach & Feta Chilled Meal",
    "Aptamil Gold Stage 2 Follow On Baby Formula 6-12M": "Aptamil Gold+ 2 Baby Follow-On Formula From 6 To 12 Months",
    "Woolworths Freshwater Basa Fillets Thawed": "Woolworths Basa Fillets Boneless With Skin Off",
    "Eat Later Hass Avocado": "Hass Avocado",
    "Hass Avocado": "Hass Avocado",
    "Radish Fresh": "Fresh Radish Bunch",
    "Woolworths Short Cut Bacon": "Woolworths Shortcut Bacon",
    "Corn Sweet": "Woolworths Corn Sweet",
}

FUZZY_THRESHOLD = 85


def clean_name(name: str) -> str:
    if not isinstance(name, str):
        return ""
    name = name.strip().replace(" NULL", "").replace("NULL", "").strip()
    return KNOWN_NAME_CHANGES.get(name, name)


def detect_fuzzy_changes(items: list[str], flag_path: str) -> dict:
    """Find pairs of items that are likely the same product under different names."""
    flagged = {}
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            score = fuzz.token_sort_ratio(a, b)
            if score >= FUZZY_THRESHOLD and a != b:
                flagged[f"{a} → {b}"] = score
    if flagged:
        with open(flag_path, "w") as f:
            json.dump(flagged, f, indent=2)
    elif os.path.exists(flag_path):
        os.remove(flag_path)
    return flagged


def get_active_shopping_list(excel_path: str, min_trips: int = 4) -> list[str]:
    """
    Return items purchased in at least min_trips distinct shopping trips across all history.
    Default min_trips=4 means 'more than 3 times'.
    Items are sorted alphabetically.
    """
    df = pd.read_excel(excel_path, sheet_name="Data")
    df["Item"] = df["Item"].apply(clean_name)
    df = df[df["Item"] != ""]
    df["Date"] = pd.to_datetime(df["Date"])

    # Count how many distinct shopping trips each item appears in
    trip_counts = df.groupby("Item")["Date"].nunique()
    frequent = trip_counts[trip_counts >= min_trips].index
    return sorted(frequent.tolist())


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "shopping_list.xlsx"
    min_trips = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    items = get_active_shopping_list(path, min_trips=min_trips)
    print(f"{len(items)} items purchased in {min_trips}+ trips:")
    for item in items:
        print(f"  - {item}")
