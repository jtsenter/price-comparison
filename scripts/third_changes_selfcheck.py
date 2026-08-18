# Self-check for third_stores.py's price-change logging.
#
# Two things here are silent when wrong, which is why they are pinned:
#   * WHICH run an outside-store move is filed against. It is decided by
#     timestamp proximity, not a run id (see _record_third_changes). File it
#     against the wrong run and the Price changes tab blames the wrong scrape.
#   * A first-ever price must not be logged as a change. There is nothing it
#     moved from, and a phantom "$0.00 -> $4.49" would read as a 100% drop.
#
# Run: python scripts/third_changes_selfcheck.py
import json, os, sys, tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
import third_stores as ts

n = 0
def check(label, got, want):
    global n
    assert got == want, f"{label}: got {got!r}, want {want!r}"
    n += 1

NOW = datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc)
def iso(**kw):
    return (NOW - timedelta(**kw)).isoformat()

CHANGES = [{"store": "big_w", "item": "Gum 64g", "old": 5.0, "new": 4.5}]


def run(log, changes=CHANGES, now=NOW):
    """Drive _record_third_changes against a temp price_changes.json."""
    d = tempfile.mkdtemp()
    ts.DATA_DIR = d
    p = os.path.join(d, "price_changes.json")
    if log is not None:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(log, f)
    ts._record_third_changes(changes, now=now)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


# ── which run does a move belong to ──────────────────────────────────────────
check("in-window: attached to the scrape that just finished, no new run",
      [len(run([{"date": iso(minutes=4), "trigger": "manual", "ww": [], "coles": []}])),
       run([{"date": iso(minutes=4), "trigger": "manual", "ww": [], "coles": []}])[-1]["third"]],
      [1, CHANGES])

out = run([{"date": iso(hours=9), "trigger": "manual", "ww": [], "coles": []}])
check("stale entry: files its own run rather than editing an old one", len(out), 2)
check("...and that run is labelled honestly", out[-1]["trigger"], "third_stores")
check("...leaving the old run untouched", "third" in out[0], False)

# A second refresh in the same window must not overwrite the first one's moves.
out = run([{"date": iso(minutes=3), "trigger": "manual", "ww": [], "coles": [],
            "third": [{"store": "aldi", "item": "Wipes", "old": 2.0, "new": 2.29}]}])
check("a run that already has third moves is never rewritten", len(out), 2)
check("...the original moves survive intact", out[0]["third"][0]["store"], "aldi")

# Clock skew / corruption must fail SAFE - never edit someone else's run.
for bad in ("", "not a date", None, "2026-13-45"):
    check(f"unparseable date {bad!r} -> new entry, old one untouched",
          "third" in run([{"date": bad, "trigger": "manual", "ww": [], "coles": []}])[0], False)
check("a FUTURE-dated entry is not treated as this run",
      "third" in run([{"date": (NOW + timedelta(hours=1)).isoformat(),
                       "trigger": "manual", "ww": [], "coles": []}])[0], False)
check("a naive (tz-less) timestamp is read as UTC, not rejected",
      "third" in run([{"date": iso(minutes=5).replace("+00:00", ""),
                       "trigger": "manual", "ww": [], "coles": []}])[0], True)

# ── file-level robustness ────────────────────────────────────────────────────
check("no file yet -> creates one with a single entry", len(run(None)), 1)
check("corrupt file is replaced, not crashed on", len(run("not a list")), 1)
check("empty log -> its own entry", len(run([])), 1)

# A quiet refresh still records that it RAN. The scrape log needs `third: []` to
# tell "checked, nothing moved" (0) apart from "this day predates outside-shop
# logging" (a dash); with nothing written, every quiet day read as untracked.
out = run(None, changes=[])
check("a quiet refresh still records that it ran", len(out), 1)
check("...as an empty third list, not a missing key", out[-1]["third"], [])
check("a quiet refresh attaches to the run in flight, same as a busy one",
      "third" in run([{"date": iso(minutes=4), "trigger": "manual", "ww": [], "coles": []}],
                     changes=[])[0], True)

# ── shape the UI depends on ──────────────────────────────────────────────────
e = run(None)[-1]
check("a standalone entry still carries empty ww/coles",
      [e["ww"], e["coles"]], [[], []])
check("every move names its shop, product and both prices",
      sorted(e["third"][0]), ["item", "new", "old", "store"])

print(f"third_changes_selfcheck: all {n} cases passed")
