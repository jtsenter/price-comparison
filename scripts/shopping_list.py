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
    if flagged:
        with open(flag_path, "w") as f:
            json.dump(flagged, f, indent=2)
    elif os.path.exists(flag_path):
        os.remove(flag_path)
    return flagged


def get_purchase_history(excel_path: str, min_trips: int = 2) -> dict:
    """
    Returns {item_name: {trip_count, price_history: [{date, price}]}}
    for items bought in at least min_trips distinct shopping dates.
    """
    df = pd.read_excel(excel_path, sheet_name="Data")
    df["Item"] = df["Item"].apply(clean_name)
    df = df[df["Item"] != ""]
    df["Date"] = pd.to_datetime(df["Date"])

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
