# Self-check for third_stores.py's pure parsers. The failure mode this guards
# is silent: a parser that mis-reads a page doesn't crash, it writes a wrong
# price into third_store.json with today's checked date on it.
# Run: python scripts/third_stores_selfcheck.py
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from third_stores import (parse_cw_price, parse_jsonld_price, parse_meta_price,
                          parse_price_for, _plausible, _round_robin_by_store,
                          _append_third_history, THIRD_HISTORY_HEARTBEAT_DAYS)

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
check("router unknown store", parse_price_for("iga", CW), None)
# Kmart quotes an AggregateOffer, not a bare price - the shape its live page
# actually serves, so the router must resolve it through parse_jsonld_price.
check("router kmart reads AggregateOffer",
      parse_price_for("kmart", '<script type="application/ld+json">'
                      '{"@type":"Product","offers":{"@type":"AggregateOffer",'
                      '"lowPrice":5,"highPrice":5}}</script>'), 5.0)
check("router bigw uses jsonld",
      parse_price_for("big_w", '<script type="application/ld+json">'
                      '{"@type":"Product","offers":{"price":16}}</script>'), 16.0)

# ── request spreading ────────────────────────────────────────────────────────
# Big W 403s under a burst (measured: a dozen rapid requests and every Big W URL
# 403d, including ones that had answered 200 minutes before; they recovered on
# their own). Interleaving the shops keeps consecutive requests off one host.
# The risk in reordering is losing or duplicating an entry, so that is what these
# pin - the spreading itself is a best-effort, the completeness is not.
def _mk(store, i):
    return {"store": store, "url": f"https://{store}/{i}"}

_src = [_mk("big_w", 1), _mk("big_w", 2), _mk("big_w", 3),
        _mk("chemist_warehouse", 1), _mk("chemist_warehouse", 2), _mk("kmart", 1)]
_out = _round_robin_by_store(_src)
check("every entry survives the reorder", len(_out), len(_src))
check("no entry is duplicated or invented",
      sorted(e["url"] for e in _out), sorted(e["url"] for e in _src))
check("a shop's own entries keep their file order",
      [e["url"] for e in _out if e["store"] == "big_w"],
      ["https://big_w/1", "https://big_w/2", "https://big_w/3"])
check("consecutive same-host requests are reduced, not increased",
      sum(1 for a, b in zip(_out, _out[1:]) if a["store"] == b["store"]) <=
      sum(1 for a, b in zip(_src, _src[1:]) if a["store"] == b["store"]), True)
check("the first three requests hit three different shops",
      len({e["store"] for e in _out[:3]}), 3)
check("an empty list is fine", _round_robin_by_store([]), [])
check("one shop only degrades to file order",
      [e["url"] for e in _round_robin_by_store([_mk("kmart", 1), _mk("kmart", 2)])],
      ["https://kmart/1", "https://kmart/2"])
check("a missing store key does not drop the entry",
      len(_round_robin_by_store([{"url": "u"}, _mk("kmart", 1)])), 2)

print(f"third_stores_selfcheck: all {n} cases passed")

# ── Outside-shop price history ──────────────────────────────────────────────
# These shops used to store one number and the day it was read, so the
# price-history chart could draw Woolworths and Coles but had nothing for
# Chemist Warehouse or Priceline, and the deal engine - which judges a price
# against its own past - could never see them at all. Now they keep a series,
# on the same append rule the supermarket histories use.

_e = {"store": "priceline", "price": 2.75}
_append_third_history(_e, 2.75, "2026-08-29")
check("a first price starts the series", _e["history"], [{"date": "2026-08-29", "price": 2.75}])

# A move is always worth a point.
_append_third_history(_e, 2.50, "2026-08-30")
check("a price move appends", [h["price"] for h in _e["history"]], [2.75, 2.50])

# An unchanged price the next day is NOT a new point - that is what the weekly
# heartbeat is for, and a point per run would bury real moves in noise.
_append_third_history(_e, 2.50, "2026-08-31")
check("an unchanged price the next day does not append", len(_e["history"]), 2)

# ...but after a week of no movement, record one so a flat price reads as
# observed rather than as a gap in the data.
_append_third_history(_e, 2.50, "2026-09-06")
check("a flat price still gets a weekly heartbeat", len(_e["history"]), 3)
check("the heartbeat carries the same price", _e["history"][-1]["price"], 2.50)

# Two runs on one day (the archived sweep and a manual refresh both call this)
# must not stack two points on the same date - that draws a vertical line.
_append_third_history(_e, 2.40, "2026-09-06")
check("a same-day re-run overwrites rather than stacks", len(_e["history"]), 3)
check("...and the later read wins", _e["history"][-1]["price"], 2.40)

# Junk in the stored file must not crash the run or survive into the series.
_bad = {"history": [{"date": None, "price": 1}, {"price": 2}, "nonsense",
                    {"date": "2026-08-01", "price": 3.00}]}
_append_third_history(_bad, 3.50, "2026-08-29")
check("malformed history rows are dropped, valid ones kept",
      [h["price"] for h in _bad["history"]], [3.00, 3.50])

# An entry that has never carried a history key is the normal case on the first
# run after this shipped; it must not throw.
_fresh = {"store": "big_w", "price": 9.20}
_append_third_history(_fresh, 9.20, "2026-08-29")
check("an entry with no history key is seeded, not skipped", len(_fresh["history"]), 1)

check("the heartbeat is a week", THIRD_HISTORY_HEARTBEAT_DAYS, 7)

print(f"third_stores_selfcheck: all {n} cases passed (incl. outside-shop history)")
