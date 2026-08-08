# Self-check for third_stores.py's pure parsers. The failure mode this guards
# is silent: a parser that mis-reads a page doesn't crash, it writes a wrong
# price into third_store.json with today's checked date on it.
# Run: python scripts/third_stores_selfcheck.py
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from third_stores import (parse_cw_price, parse_jsonld_price, parse_meta_price,
                          parse_price_for, _plausible)

n = 0
def check(label, got, want):
    global n
    assert got == want, f"{label}: got {got!r}, want {want!r}"
    n += 1

# Chemist Warehouse - the real page shape (nonce attr on the script tag, price
# nested under prices[0].price.value.amount), captured from a live fetch.
CW = ('<script id="__NEXT_DATA__" type="application/json" nonce="xyz">'
      '{"props":{"pageProps":{"product":{"prices":[{"sku":"1","price":'
      '{"value":{"amount":10.19,"currencyCode":"AUD"}}}],"product":{"name":"x"}}}}}'
      '</script>')
check("CW real shape", parse_cw_price(CW), 10.19)
check("CW missing block", parse_cw_price("<html>nope</html>"), None)
check("CW mangled JSON is a miss, not a crash",
      parse_cw_price('<script id="__NEXT_DATA__" a="b">{oops</script>'), None)

# JSON-LD - dict offers, list offers, AggregateOffer, @graph wrapper.
check("JSON-LD dict offer",
      parse_jsonld_price('<script type="application/ld+json">'
                         '{"@type":"Product","offers":{"price":"23.50"}}</script>'), 23.50)
check("JSON-LD list of offers",
      parse_jsonld_price('<script type="application/ld+json">'
                         '{"@type":"Product","offers":[{"price":8},{"price":9}]}</script>'), 8.0)
check("JSON-LD AggregateOffer lowPrice",
      parse_jsonld_price('<script type="application/ld+json">'
                         '{"@type":"Product","offers":{"lowPrice":5.25}}</script>'), 5.25)
check("JSON-LD @graph wrapper",
      parse_jsonld_price('<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},'
                         '{"@type":"Product","offers":{"price":13.30}}]}</script>'), 13.30)
check("JSON-LD non-Product ignored",
      parse_jsonld_price('<script type="application/ld+json">'
                         '{"@type":"BreadcrumbList","offers":{"price":4}}</script>'), None)

# Meta fallbacks.
check("itemprop meta", parse_meta_price('<meta itemprop="price" content="7.90">'), 7.90)
check("og product meta",
      parse_meta_price('<meta property="product:price:amount" content="12.00"/>'), 12.00)
check("no meta", parse_meta_price("<html></html>"), None)

# Plausibility rails: a challenge shell or parse slip must not become a price.
check("zero rejected", _plausible(0), None)
check("negative rejected", _plausible(-4), None)
check("absurd rejected (parse bug ceiling)", _plausible(99999), None)
check("string coerced", _plausible("6.4"), 6.4)
check("garbage rejected", _plausible("challenge"), None)

# Router: store-specific parser order, unknown store is quiet.
check("router CW", parse_price_for("chemist_warehouse", CW), 10.19)
check("router unknown store", parse_price_for("kmart", CW), None)
check("router bigw uses jsonld",
      parse_price_for("big_w", '<script type="application/ld+json">'
                      '{"@type":"Product","offers":{"price":16}}</script>'), 16.0)

print(f"third_stores_selfcheck: all {n} cases passed")
