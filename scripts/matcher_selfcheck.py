"""Self-check for matcher.pick_best_match - the scraper's highest-risk logic.

Run: python scripts/matcher_selfcheck.py
pick_best_match decides which store search result becomes an item's price. A wrong
pick silently poisons the data (the "Reese's WW $37.99 vs Coles $3" class of bug),
so this locks the scoring dimensions - exact match, ranking beyond index 0,
rejection threshold, form penalty, organic-tier penalty, size penalty - against
regressions when the thresholds get tuned. Expected values were confirmed against
the current implementation; each reflects intended behaviour, not a snapshot of a bug.
"""
from matcher import pick_best_match


def R(*names):
    return [{"name": n} for n in names]


def _run():
    n = 0

    def check(label, got, want):
        nonlocal n
        n += 1
        assert got == want, f"{label}: got {got!r}, want {want!r}"

    def pick_name(q, results):
        best, _conf = pick_best_match(q, results)
        return best["name"] if best else None

    def conf(q, results):
        return pick_best_match(q, results)[1]

    # Exact match wins with high confidence.
    check("exact pick",
          pick_name("Woolworths Full Cream Milk 2L",
                    R("Woolworths Full Cream Milk 2L", "Woolworths Skim Milk 2L")),
          "Woolworths Full Cream Milk 2L")
    check("exact confidence",
          conf("Woolworths Full Cream Milk 2L", R("Woolworths Full Cream Milk 2L")),
          "high")

    # Best of the list is chosen - NOT blindly index 0.
    check("ranks past index 0",
          pick_name("Chicken Thigh Fillets",
                    R("Toilet Paper 12pk", "Woolworths RSPCA Chicken Thigh Fillets 1kg")),
          "Woolworths RSPCA Chicken Thigh Fillets 1kg")

    # A completely unrelated product is rejected entirely.
    check("unrelated rejected",
          pick_best_match("Bananas", R("Homebrand Toilet Paper 12pk")),
          (None, "none"))

    # Organic is a different product: prefer the tier that matches the query.
    check("non-organic query prefers plain",
          pick_name("Truss Tomatoes", R("Organic Truss Tomatoes", "Truss Tomatoes")),
          "Truss Tomatoes")
    check("organic query prefers organic",
          pick_name("Organic Carrots 1kg",
                    R("Woolworths Carrots 1kg", "Woolworths Organic Carrots 1kg")),
          "Woolworths Organic Carrots 1kg")

    # Same product, wildly different size: the closer size ranks higher.
    check("size ranking",
          pick_name("Woolworths Full Cream Milk 2L",
                    R("Woolworths Full Cream Milk 250ml", "Woolworths Full Cream Milk 2L")),
          "Woolworths Full Cream Milk 2L")

    # Form mismatch (FRESH query vs COOKED result) fails the stricter threshold.
    check("form mismatch rejected",
          pick_best_match("Salmon Fillets Fresh", R("Smoked Salmon 200g")),
          (None, "none"))

    # Chicken cut is a hard discriminator: a thigh query must NEVER latch onto a
    # breast result even though the names are otherwise near-identical (both are
    # form UNKNOWN and share "chicken ... fillet"). Both real bugs this locks:
    check("thigh query rejects breast-only results",
          pick_best_match("Lilydale Free Range Chicken Thigh Fillets Small Pack 545g",
                          R("Lilydale Free Range Chicken Breast Fillet 600g")),
          (None, "none"))
    check("thigh query skips breast, takes the real thigh",
          pick_name("Coles RSPCA Approved Free Range Chicken Thigh Large Pack",
                    R("Macro RSPCA Approved Chicken Breast Free Range Single",
                      "Coles RSPCA Approved Free Range Chicken Thigh Large Pack")),
          "Coles RSPCA Approved Free Range Chicken Thigh Large Pack")
    # A product naming two cuts shares a token, so it still matches a query for either.
    check("multi-cut result still matches its family member",
          pick_name("Chicken Thigh Cutlets",
                    R("Woolworths Chicken Thigh & Wing Portions 1kg")),
          "Woolworths Chicken Thigh & Wing Portions 1kg")

    # A bare/generic query ("Milk") must NOT latch onto a specific variant.
    check("generic query stays unmatched",
          pick_best_match("Milk 2L", R("Woolworths Full Cream Milk 250ml")),
          (None, "none"))

    # Empty result list.
    check("empty results", pick_best_match("anything", []), (None, "none"))

    print(f"matcher_selfcheck: all {n} cases passed")


if __name__ == "__main__":
    _run()
