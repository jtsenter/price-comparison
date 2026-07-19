"""Self-check for categories.guess_category after the 13 -> 10 consolidation.

Run: python scripts/categories_selfcheck.py
Locks the merged buckets (Bakery -> Pantry, Frozen Foods + Ready Meals ->
"Frozen", Personal Care + Baby -> "Baby & Care") and guards
against keyword collisions as new items are added. All bucket names must stay inside
the 10 live categories the UI knows about (KNOWN_CATEGORIES in docs/app.js), or the
item lands on a tab that doesn't exist.

Note: the keyword guesser is deliberately imperfect for genuinely ambiguous names
(e.g. "Pringles Sour Cream Chips" hits the Dairy keyword "cream" before "chips") -
those few are corrected by ITEM_CATEGORY_DEFAULTS in app.js, not here, so they are
not asserted below.
"""
from categories import guess_category, CATEGORY_KEYWORDS

LIVE = {
    "Fruit & Veg", "Meat & Seafood", "Dairy & Eggs", "Pantry", "Sweets",
    "Frozen", "Drinks & Alcohol", "Household",
    "Baby & Care", "Other",
}

CASES = [
    ("Woolworths Full Cream Milk 2L", "Dairy & Eggs"),
    ("Cadbury Dairy Milk Chocolate Block", "Sweets"),
    ("Chicken Thigh Fillets 1kg", "Meat & Seafood"),
    ("Cavendish Bananas", "Fruit & Veg"),
    ("Coca-Cola Classic 1.25L", "Drinks & Alcohol"),
    ("Pasta Penne 500g", "Pantry"),
    ("Vanish Napisan Stain Remover", "Household"),
    ("Mystery Widget XYZ", "Other"),
    # Merged buckets - the whole point of the consolidation:
    ("Helga's Wholemeal Bread 750g", "Pantry"),                 # ex-Bakery
    ("Ben & Jerry's Ice Cream Tub", "Frozen"),    # ex-Frozen Foods
    ("Continental Cup A Soup Chicken", "Pantry"), # shelf-stable, moved out of Frozen
    ("Aptamil Gold Follow-On Formula", "Baby & Care"), # ex-Baby
    ("Dettol Antibacterial Hand Wash", "Baby & Care"), # ex-Personal Care
]


def _run():
    # Every bucket the guesser can emit must be a live UI category.
    assert set(CATEGORY_KEYWORDS) <= LIVE, set(CATEGORY_KEYWORDS) - LIVE

    for name, expected in CASES:
        got = guess_category(name)
        assert got == expected, f"{name!r}: got {got!r}, want {expected!r}"

    print(f"categories_selfcheck: all {len(CASES)} cases passed ({len(CATEGORY_KEYWORDS)} buckets)")


if __name__ == "__main__":
    _run()
