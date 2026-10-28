"""Self-check for keep_validation_decisions.reconcile().

Run: python scripts/keep_validation_decisions_selfcheck.py

The 2026-10-28 incident in miniature: you fix Tuna's link and confirm
WaterWipes while a scrape runs; the scrape's merge puts both cards back and
wipes the approval. reconcile() must restore your decisions - and must NOT
hide a flag the scrape raised that you have not seen.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keep_validation_decisions import reconcile  # noqa: E402

TUNA = {"item": "Tuna", "ww_suspicious": False, "coles_suspicious": True, "coles_price": 2.2}
WIPES = {"item": "Wipes", "ww_suspicious": True, "ww_price": 29.5, "coles_suspicious": False}
OK = []


def ok(msg):
    OK.append(msg)
    print("  ok ", msg)


base = {"pending_validation": [TUNA, WIPES], "approved_prices": {}}
theirs = {"approved_prices": {"Wipes": {"ww": 29.5}}}          # you cleared both, approved Wipes
ours = {"pending_validation": [TUNA, WIPES], "approved_prices": {}}  # scrape's stale snapshot

new, notes = reconcile(base, theirs, ours)
assert "pending_validation" not in new, new.get("pending_validation")
ok("cards you cleared during the scrape stay cleared")
assert new["approved_prices"] == {"Wipes": {"ww": 29.5}}
ok("an approval you made during the scrape is kept")
assert ours["pending_validation"] == [TUNA, WIPES]
ok("inputs are not mutated")

# The scrape found a DIFFERENT price for Tuna than the card you cleared: that is
# a new question you have not been asked. It must survive.
newer = dict(TUNA, coles_price=3.9)
new, _ = reconcile(base, theirs, {"pending_validation": [newer, WIPES]})
assert new["pending_validation"] == [newer], new.get("pending_validation")
ok("a new flag with different prices is kept for you to see")

# A card the scrape raised that did not exist when it started: keep it.
fresh = {"item": "Eggs", "ww_suspicious": True, "ww_price": 8.0}
new, _ = reconcile(base, base, {"pending_validation": [TUNA, WIPES, fresh]})
assert [e["item"] for e in new["pending_validation"]] == ["Tuna", "Wipes", "Eggs"]
ok("nothing you did not touch is changed")

# "Not sold at Coles" clears one store of a two-store card: keep YOUR version.
both = {"item": "Butter", "ww_suspicious": True, "ww_price": 7.0, "coles_suspicious": True, "coles_price": 4.5}
mine = dict(both, coles_suspicious=False)
new, _ = reconcile({"pending_validation": [both]}, {"pending_validation": [mine]}, {"pending_validation": [both]})
assert new["pending_validation"] == [mine], new["pending_validation"]
ok("clearing one store of a two-store card is kept")

print(f"\nkeep_validation_decisions_selfcheck: {len(OK)} checks passed")
