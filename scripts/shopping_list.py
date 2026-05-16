import pandas as pd
from datetime import datetime, timedelta
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
    "Woolworths Natural Greek Style Yoghurt": "Woolworths Greek Style Yoghurt",
    "Woolworths Short Cut Bacon": "Woolworths Shortcut Bacon",
    "Corn Sweet": "Woolworths Corn Sweet",
}

FUZZY_THRESHOLD = 85


def clean_name(name: str) -> str:
    if not isinstance(name, str):
        return ""
    name = name.strip()
    # Strip trailing NULL artifacts
    name = name.replace(" NULL", "").replace("NULL", "").strip()
    return KNOWN_NAME_CHANGES.get(name, name)


def detect_fuzzy_changes(items: list[str], flag_path: str) -> dict:
    """Find pairs of items that are likely the same product under different names."""
    flagged = {}
    for i, a in enumerate(items):
        for b in items[i + 1 :]:
            score = fuzz.token_sort_ratio(a, b)
            if score >= FUZZY_THRESHOLD and a != b:
                key = f"{a} → {b}"
                flagged[key] = score
    if flagged:
        with open(flag_path, "w") as f:
            json.dump(flagged, f, indent=2)
    elif os.path.exists(flag_path):
        os.remove(flag_path)
    return flagged


def get_active_shopping_list(excel_path: str, days_window: int = 90) -> list[str]:
    df = pd.read_excel(excel_path, sheet_name="Data")
    df["Item"] = df["Item"].apply(clean_name)
    df = df[df["Item"] != ""]
    df["Date"] = pd.to_datetime(df["Date"])

    cutoff = datetime.now() - timedelta(days=days_window)
    recent = df[df["Date"] >= cutoff]

    active_items = sorted(recent["Item"].unique().tolist())
    return active_items


if __name__ == "__main__":
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else "shopping_list.xlsx"
    items = get_active_shopping_list(path)
    print(f"{len(items)} active items:")
    for item in items:
        print(f"  - {item}")
