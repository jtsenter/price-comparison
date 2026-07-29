"""A pinned Coles URL that yields no price must NOT adopt another product's price.

The bug this pins down: when a pinned product goes "Currently unavailable" it
drops out of Coles search, so the old code kept the TOP SEARCH RESULT - a
sibling pack - and set _skip_picker_co, bypassing the matcher that would
otherwise have rejected it. Two real cases:

  Lilydale Chicken Thigh Fillets Small Pack 545g  ->  showed the 900g BULK price
  Coles RSPCA Free Range Chicken Thigh Cutlets    ->  showed the non-free-range one

Both products still exist and are simply out of stock, so the honest answer is
"no price", not a different product's price.

Source-level check: this branch is deep inside a Playwright coroutine, so we
assert on the shape of the code rather than standing up a browser.

Run: python scripts/pinned_fallback_selfcheck.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = io.open(os.path.join(HERE, "scraper.py"), encoding="utf-8").read()

failures = []


def check(label, ok, detail=""):
    if ok:
        print(f"  ok  {label}")
    else:
        failures.append(label)
        print(f"  FAIL {label}" + (f"\n       {detail}" if detail else ""))


# Isolate the pinned-Coles fallback block.
start = SRC.find("Coles pinned URL failed")
check("pinned-Coles fallback block exists", start != -1)
block = SRC[start:start + 1800] if start != -1 else ""

check(
    "no longer falls back to the top search result",
    "using top search result" not in block,
    "the top hit is a DIFFERENT product whenever the pinned one is unavailable",
)

check(
    "an unmatched pinned slug clears the results",
    re.search(r"else:\s*\n\s*print\(f?\"\s*Coles: pinned product not in search results[^\n]*\n\s*coles_results = \[\]", block)
    is not None,
    "must yield no price rather than a sibling pack's price",
)

# The matcher bypass is what made the wrong price un-catchable downstream, so it
# must now be reachable ONLY on a confirmed slug match.
m = re.search(r"if _co_hit:(.*?)else:", block, re.S)
check("matcher bypass sits inside the slug-matched branch", m is not None and "_skip_picker_co = True" in m.group(1))

after_else = block[m.end():] if m else block
check(
    "matcher bypass is NOT set on the unmatched path",
    "_skip_picker_co = True" not in after_else.split("\n\n")[0],
    "bypassing the matcher on a guessed product is how the wrong price got in",
)

check(
    "slug match still wins when the pinned product IS in the results",
    "matched by pinned slug" in block and "coles_results = [_co_hit]" in block,
)

# Guard the sibling case that produced the two real-world bugs: matching must be
# on the FULL slug, not a loose substring, or "…-bulk-900g" would match "…-545g".
check(
    "slug comparison uses the full pinned slug",
    "_pinned_slug in r.get('url', '')" in block,
)

print()
if failures:
    print(f"pinned_fallback_selfcheck: {len(failures)} FAILED")
    sys.exit(1)
print("pinned_fallback_selfcheck: all assertions passed")
