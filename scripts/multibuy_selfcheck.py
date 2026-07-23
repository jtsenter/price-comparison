"""Self-check for multi-buy extraction + pricing math.

Two stores, two DIFFERENT payload shapes, and getting them confused silently
misprices a basket:
  Woolworths  CentreTag.MultibuyData {Quantity, Price}   Price is the TOTAL
  Coles       pricing.multiBuyPromotion {minQuantity, reward}   reward is PER UNIT

The effective-cost formula is shared by the basket totals and the "buy N more"
nudge, so it lives here as the single source of truth for the Python side and is
mirrored by multiBuyCost() in utils.js (see utils_selfcheck.js).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from scraper import _ww_multi_buy  # noqa: E402


def multi_buy_cost(qty, unit_price, mb):
    """What `qty` units actually cost given multi-buy `mb` ({qty,total}) or None.

    Whole promo blocks price at the deal rate; the remainder pays shelf price.
    """
    if not mb or not mb.get("qty") or mb.get("total") is None or qty < mb["qty"]:
        return round(qty * unit_price, 2)
    blocks, rest = divmod(qty, mb["qty"])
    return round(blocks * mb["total"] + rest * unit_price, 2)


cases = 0


def check(label, got, want):
    global cases
    cases += 1
    assert got == want, f"{label}: got {got!r}, want {want!r}"


# ── WW extraction: Price is the TOTAL, never multiplied ──────────────────────
check("ww centre tag (Chris' Dips 2 for $7)",
      _ww_multi_buy({"CentreTag": {"MultibuyData": {"Quantity": 2, "Price": 7}}}),
      {"qty": 2, "total": 7.0})
check("ww header tag slot",
      _ww_multi_buy({"HeaderTag": {"MultibuyData": {"Quantity": 3, "Price": 10.5}}}),
      {"qty": 3, "total": 10.5})
check("ww no promo", _ww_multi_buy({"CentreTag": {"MultibuyData": None}}), None)
check("ww no tags at all", _ww_multi_buy({}), None)
check("ww qty of 1 is not a multi-buy",
      _ww_multi_buy({"CentreTag": {"MultibuyData": {"Quantity": 1, "Price": 4}}}), None)
check("ww malformed values ignored",
      _ww_multi_buy({"CentreTag": {"MultibuyData": {"Quantity": "x", "Price": None}}}), None)
check("ww tag present but not a dict",
      _ww_multi_buy({"CentreTag": "2 for $7"}), None)

# ── Cost math ────────────────────────────────────────────────────────────────
DIPS = {"qty": 2, "total": 7.0}      # WW Chris' Dips: 2 for $7, shelf $4.50
check("below threshold pays shelf", multi_buy_cost(1, 4.50, DIPS), 4.50)
check("exactly the deal", multi_buy_cost(2, 4.50, DIPS), 7.00)
check("deal + remainder", multi_buy_cost(3, 4.50, DIPS), 11.50)   # 7 + 4.50
check("two whole deals", multi_buy_cost(4, 4.50, DIPS), 14.00)
check("no promo → plain multiply", multi_buy_cost(3, 4.50, None), 13.50)
check("zero qty", multi_buy_cost(0, 4.50, DIPS), 0.0)

# A "deal" that is not actually cheaper must still be applied as the store would
# price it - the app reports reality, it does not second-guess the shelf.
WORSE = {"qty": 2, "total": 12.0}
check("worse-than-shelf promo still priced as the store charges",
      multi_buy_cost(2, 5.00, WORSE), 12.00)

# Coles shape converts to the same {qty,total} before reaching the math.
coles = {"minQuantity": 2, "reward": 3}
coles_norm = {"qty": coles["minQuantity"], "total": round(coles["minQuantity"] * coles["reward"], 2)}
check("coles reward is PER UNIT → total 6", coles_norm, {"qty": 2, "total": 6.0})
check("coles cost for 2", multi_buy_cost(2, 4.60, coles_norm), 6.00)

print(f"multibuy_selfcheck: all {cases} cases passed")
