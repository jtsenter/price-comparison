"""Self-check for _purge_alias_items() - the final dedup before latest.json is written.

Guards the "phantom repeating price change" bug (found 2026-07-26):

  "Woolworths Australian Grown Carrots  $2.00 -> $1.70"  was reported on the 25th
  AND again on the 26th, while latest.json sat frozen at $2.00 the whole time.

Cause: archived items are pre-populated into items_output from EXISTING data early
in the run (so they survive a stalled run's progress push). Manual runs never skip
archived items, so the same item was then scraped again and appended fresh. That
left two entries for one name. The price-change differ walked both and saw the
FRESH one (logging 2.00 -> 1.70), but this dedup kept the FIRST occurrence - the
stale copy - so latest.json never moved and the next run logged the identical
change again, forever.

The rule that fixes it: when one name appears twice, the FRESHEST entry wins.

Run: python scripts/alias_purge_selfcheck.py
"""
import scraper


def _item(name, price=None, last_scraped=None, archived=None):
    it = {"list_item": name, "woolworths": ({"price": price} if price is not None else None)}
    if last_scraped is not None:
        it["last_scraped"] = last_scraped
    if archived is not None:
        it["archived"] = archived
    return it


def _ww(items, name):
    for i in items:
        if i["list_item"] == name:
            return (i.get("woolworths") or {}).get("price")
    return None


def _run():
    n = 0

    # ── THE REGRESSION: stale pre-populated entry + fresh scraped entry ────────
    # Order matters: the stale copy is appended FIRST (pre-population), the fresh
    # scrape lands later - exactly the order the scraper produces.
    NAME = "Woolworths Australian Grown Carrots"
    out = scraper._purge_alias_items([
        _item(NAME, 2.00, "2026-07-23T23:36:55+00:00", archived=True),   # pre-populated, stale
        _item("Some Other Item", 5.00, "2026-07-26T01:40:00+00:00"),
        _item(NAME, 1.70, "2026-07-26T01:40:35+00:00", archived=True),   # freshly scraped
    ])
    assert len(out) == 2, f"expected one entry per name, got {len(out)}"
    assert _ww(out, NAME) == 1.70, (
        f"stale entry won the dedup (got {_ww(out, NAME)}) - this is the phantom "
        "repeating price-change bug: the differ logs the fresh price but latest.json "
        "keeps the old one, so the same change replays every run"
    )
    n += 2

    # Reverse order (fresh first) must give the same answer - the rule is recency,
    # not position, so it can't be accidentally satisfied by "keep last".
    out = scraper._purge_alias_items([
        _item(NAME, 1.70, "2026-07-26T01:40:35+00:00"),
        _item(NAME, 2.00, "2026-07-23T23:36:55+00:00"),
    ])
    assert len(out) == 1 and _ww(out, NAME) == 1.70, "recency must win regardless of order"
    n += 1

    # A failed re-scrape (no last_scraped / no price) must NOT clobber good
    # carried-forward data - losing a real price is worse than showing a stale one.
    out = scraper._purge_alias_items([
        _item(NAME, 2.00, "2026-07-23T23:36:55+00:00"),
        _item(NAME, None, None),
    ])
    assert len(out) == 1 and _ww(out, NAME) == 2.00, "a priceless duplicate must not win"
    n += 1

    # ── Existing alias behaviour must be untouched ────────────────────────────
    # An alias whose canonical name is also present gets dropped (KNOWN_NAME_CHANGES,
    # which lives in shopping_list.py and reaches scraper via clean_name).
    import shopping_list
    alias, canon = None, None
    for a, c in (shopping_list.KNOWN_NAME_CHANGES or {}).items():
        if a and c and a != c:
            alias, canon = a, c
            break
    if alias:
        out = scraper._purge_alias_items([_item(alias, 1.0), _item(canon, 2.0)])
        names = [i["list_item"] for i in out]
        assert alias not in names and canon in names, f"alias {alias!r} should collapse into {canon!r}"
        n += 1
        # ...but an alias ALONE is kept (dropping it would lose the item entirely).
        out = scraper._purge_alias_items([_item(alias, 1.0)])
        assert len(out) == 1, "a lone alias must be kept, not dropped"
        n += 1

    # Ordinary distinct items pass through untouched, order preserved.
    src = [_item("A", 1.0), _item("B", 2.0), _item("C", 3.0)]
    out = scraper._purge_alias_items(src)
    assert [i["list_item"] for i in out] == ["A", "B", "C"], "distinct items must survive in order"
    n += 1

    print(f"alias_purge_selfcheck: all {n} cases passed")


if __name__ == "__main__":
    _run()
