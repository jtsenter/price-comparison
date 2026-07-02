"""Self-check for _coles_product_page_js()'s MAX_PRODUCT_PRICE interpolation.

Run: python scripts/coles_price_ceiling_selfcheck.py
Guards against the ceiling drifting back into a hardcoded magic number inside the
injected JS (previously "v < 50" duplicated the intent of MAX_PRODUCT_PRICE without
ever reading it, so raising the constant silently did nothing to the real ceiling).
"""
import scraper


def _run():
    js = scraper._coles_product_page_js()
    assert '__MAX_PRODUCT_PRICE__' not in js, "placeholder left unsubstituted"
    assert f'v < {scraper.MAX_PRODUCT_PRICE}' in js, "ceiling in JS doesn't match MAX_PRODUCT_PRICE"
    assert 'v < 50' not in js, "a hardcoded 50 ceiling crept back in"
    print("coles_price_ceiling_selfcheck: all cases passed")


if __name__ == "__main__":
    _run()
