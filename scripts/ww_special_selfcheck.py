"""Self-check for WW public-special vs member-price handling in _parse_ww_products.

Regression guard for the 2026-07-07 bug: the search path took WasPrice whenever
WasPrice > Price "regardless of the EDR flag", which inflated every PUBLIC special
to its struck-through was-price (Mix Max scraped $7.70 when the public special was
$5.80). Only a MEMBER-exclusive deal (IsEdrSpecial/IsPmDelivery) should revert to
the public WasPrice; a public special (IsOnSpecial, no member flag) keeps its Price.

Run: python scripts/ww_special_selfcheck.py
"""
import scraper


def _price(product):
    out = scraper._parse_ww_products([product])
    assert out, f"no result for {product.get('Name')}"
    return out[0]["price"]


def _run():
    base = {"Name": "X", "CupPrice": None, "CupString": "", "Stockcode": 1}

    # Public special (IsOnSpecial, no member flag): KEEP the lower Price.
    assert _price({**base, "Price": 5.8, "WasPrice": 7.7, "IsOnSpecial": True,
                   "IsEdrSpecial": False, "IsPmDelivery": False}) == 5.8

    # Member Everyday-Rewards special: revert to the public WasPrice.
    assert _price({**base, "Price": 5.8, "WasPrice": 7.7, "IsEdrSpecial": True}) == 7.7
    # Member Prices-Member (PM) deal: revert too.
    assert _price({**base, "Price": 5.8, "WasPrice": 7.7, "IsPmDelivery": True}) == 7.7
    # Legacy flag names still honoured if present.
    assert _price({**base, "Price": 5.8, "WasPrice": 7.7, "IsEveryDayRewards": True}) == 7.7

    # Regular item, no WasPrice: unchanged.
    assert _price({**base, "Price": 3.3, "WasPrice": None}) == 3.3
    # WasPrice present but NOT higher (odd data): never inflate; keep Price.
    assert _price({**base, "Price": 4.0, "WasPrice": 3.5, "IsEdrSpecial": True}) == 4.0
    # Public special where the member flags are explicitly null (the real API shape).
    assert _price({**base, "Price": 5.9, "WasPrice": 7.6, "IsOnSpecial": True,
                   "IsEdrSpecial": False, "IsPmDelivery": False,
                   "IsEveryDayRewards": None, "IsPmDeals": None}) == 5.9

    print("ww_special_selfcheck: all cases passed")


if __name__ == "__main__":
    _run()
