"""Re-apply Validate-page decisions that a scrape's merge just overwrote.

Run by the workflow straight after `git pull --no-rebase -X ours origin main`.

A scrape writes latest.json from the snapshot it checked out at start. If you
confirm a price or fix a link on the Validate page while it runs, your change
lands on main first, and the scrape's merge (`-X ours`, whole file - latest.json
is one line) then puts its stale snapshot back over it. Fixing a link loses this
race EVERY time: the fix starts its own re-scrape before it clears the card.
Seen 2026-10-28: Tuna and WaterWipes reappeared in Validate minutes after being
cleared, and the WaterWipes approval was wiped, so the next scrape would have
flagged it a third time.

Three-way, using the merge's own parents:
  base   = merge-base of the two parents (what the scrape started from)
  theirs = main as it was (holds your decisions)
  ours   = the merged file on disk (the scrape's version)
Restores, for latest.json only:
  * pending_validation - an entry you resolved since `base` is removed again,
    unless the scrape raised a DIFFERENT flag for that item (new prices), which
    you have not seen yet and must keep.
  * approved_prices - your confirmations since `base` are put back.
Prices and histories are left to the scrape: they self-heal on the next run
once the approval is kept.

Commits the correction when it changes anything; otherwise does nothing.
"""
import json
import os
import subprocess
import sys

P = "docs/data/latest.json"


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8")


def at(ref):
    r = subprocess.run(["git", "show", f"{ref}:{P}"], capture_output=True)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None


def flag(e):
    """What a validation entry actually asks: which prices, at which stores."""
    return (e.get("ww_suspicious"), e.get("ww_price") if e.get("ww_suspicious") else None,
            e.get("coles_suspicious"), e.get("coles_price") if e.get("coles_suspicious") else None)


def reconcile(base, theirs, ours):
    """Pure: returns (new_ours, notes). Never mutates its inputs."""
    ours = json.loads(json.dumps(ours))
    notes = []

    pv_base = {e["item"]: e for e in base.get("pending_validation") or []}
    pv_theirs = {e["item"]: e for e in theirs.get("pending_validation") or []}
    keep = []
    for e in ours.get("pending_validation") or []:
        b = pv_base.get(e["item"])
        resolved = b is not None and (e["item"] not in pv_theirs or flag(pv_theirs[e["item"]]) != flag(b))
        if resolved and flag(e) == flag(b):
            notes.append(f"kept your decision on {e['item']}")
            # you may have cleared one store and left the other (e.g. "not sold here")
            if e["item"] in pv_theirs:
                keep.append(pv_theirs[e["item"]])
            continue
        keep.append(e)
    if keep:
        ours["pending_validation"] = keep
    else:
        ours.pop("pending_validation", None)

    ap_base = base.get("approved_prices") or {}
    ap_theirs = theirs.get("approved_prices") or {}
    ap = ours.setdefault("approved_prices", {})
    for item, v in ap_theirs.items():
        if ap_base.get(item) != v and ap.get(item) != v:
            ap[item] = v
            notes.append(f"kept your approval of {item}")
    if not ap:
        ours.pop("approved_prices", None)
    return ours, notes


def main():
    parents = git("log", "-1", "--format=%P").stdout.split()
    if len(parents) != 2 or not os.path.exists(P):
        return 0  # fast-forward or nothing pulled: no overwrite possible
    mb = git("merge-base", parents[0], parents[1]).stdout.strip()
    base, theirs = at(mb), at(parents[1])
    if not base or not theirs:
        return 0
    raw = open(P, encoding="utf-8", newline="").read()
    new, notes = reconcile(base, theirs, json.loads(raw))
    if not notes:
        return 0
    open(P, "w", encoding="utf-8", newline="").write(
        json.dumps(new, ensure_ascii=False, separators=(",", ":")) + raw[len(raw.rstrip("\r\n")):])
    for n in notes:
        print(n)
    git("add", P)
    git("commit", "-m", "chore: keep Validate decisions made during the scrape")
    return 0


if __name__ == "__main__":
    sys.exit(main())
