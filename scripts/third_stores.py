"""Refresh third-store prices (Chemist Warehouse / Big W / Priceline).

Runs on the SELF-HOSTED runner as the last leg of the scrape pipeline
(scrape.yml calls it after the archived sweep). That location is the whole
point: from an ordinary fetch Big W answers 403 at the edge and Priceline
serves a Cloudflare challenge shell, but the runner drives a real Chromium
with the same persistent profile that already carries Coles past Incapsula -
the one environment with a realistic chance at all three shops.

Reads docs/data/third_store.json, visits each entry's product page, and
updates `price` + `checked` ONLY when a real price was parsed. A failed or
blocked fetch leaves the stored price untouched and stamps
`status: "unreachable <date>"` instead - stale-but-honest beats fresh-but-
invented. A successful fetch clears any previous status/note.

Parsing is per-store, pure, and self-checked (third_stores_selfcheck.py):
  chemist_warehouse - server-rendered __NEXT_DATA__ (proven live twice)
  big_w / priceline - JSON-LD Product offers, then itemprop/og meta fallback
"""
import asyncio, json, os, re, sys
from datetime import date, datetime, timedelta, timezone

DATA_DIR   = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
THIRD_PATH = os.path.join(DATA_DIR, "third_store.json")
# Same persistent profile as scraper.py, so bot-check trust cookies are shared.
PROFILE_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "pricewatch-pw-profile")
PAGE_TIMEOUT_MS = 30_000
MAX_PRICE = 200.0   # sanity ceiling: a parsed "price" above this is a parse bug


# ── pure parsers (self-checked) ──────────────────────────────────────────────

def parse_cw_price(html: str):
    """Chemist Warehouse product page -> float price, or None."""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return None
    try:
        pp = json.loads(m.group(1))["props"]["pageProps"]["product"]
        return _plausible(pp["prices"][0]["price"]["value"]["amount"])
    except Exception:
        return None


def parse_jsonld_price(html: str):
    """Any page with a JSON-LD Product block -> float price, or None.
    Handles offers as a dict, a list, or an AggregateOffer (lowPrice)."""
    for m in re.finditer(
            r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except Exception:
            continue
        for node in data if isinstance(data, list) else [data]:
            if not isinstance(node, dict):
                continue
            graph = node.get("@graph")
            nodes = graph if isinstance(graph, list) else [node]
            for n in nodes:
                if not isinstance(n, dict) or n.get("@type") not in ("Product", ["Product"]):
                    continue
                offers = n.get("offers")
                for off in offers if isinstance(offers, list) else [offers]:
                    if not isinstance(off, dict):
                        continue
                    p = _plausible(off.get("price") or off.get("lowPrice"))
                    if p is not None:
                        return p
    return None


def parse_meta_price(html: str):
    """itemprop/og/product meta price tags -> float price, or None."""
    for pat in (r'itemprop="price"[^>]*content="([\d.]+)"',
                r'property="product:price:amount"[^>]*content="([\d.]+)"',
                r'property="og:price:amount"[^>]*content="([\d.]+)"'):
        m = re.search(pat, html)
        if m:
            p = _plausible(m.group(1))
            if p is not None:
                return p
    return None


def _plausible(v):
    try:
        p = float(v)
    except (TypeError, ValueError):
        return None
    return p if 0 < p <= MAX_PRICE else None


PARSERS = {
    # ordered: most reliable first for that store
    "chemist_warehouse": (parse_cw_price, parse_jsonld_price, parse_meta_price),
    "big_w":             (parse_jsonld_price, parse_meta_price),
    "priceline":         (parse_jsonld_price, parse_meta_price),
    # ALDI serves a normal server-rendered page with a JSON-LD Product block and
    # answers a plain fetch (200, no challenge) - checked live 2026-08-13. No new
    # parser needed, it reuses the same one Big W and Priceline use.
    "aldi":              (parse_jsonld_price, parse_meta_price),
    # Kmart carries a JSON-LD Product whose offers are an AggregateOffer
    # (lowPrice/highPrice over the click-and-collect and delivery offers), which
    # parse_jsonld_price already reads - checked live 2026-08-17. Like Big W it
    # answers 403 to a plain fetch and needs the runner's real browser.
    "kmart":             (parse_jsonld_price, parse_meta_price),
}


SAME_RUN_HOURS = 2   # see _record_third_changes


def _belongs_to_run(iso: str, now=None) -> bool:
    """Was this price_changes entry written by the scrape leg of the run we are
    finishing? Timestamp proximity is the only signal available - the entry
    carries no run id. Anything unparseable is a NO, so a malformed date can
    never cause someone else's run to be edited."""
    try:
        when = datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return False
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return timedelta(0) <= now - when <= timedelta(hours=SAME_RUN_HOURS)


def _record_third_changes(changes: list, now=None) -> None:
    """Fold outside-store price moves into price_changes.json, so the Price
    changes tab covers every shop rather than only the two supermarkets.

    Written onto the run that just finished rather than appended as a run of its
    own: scrape.yml calls this script as the LAST LEG of the same workflow run,
    so a separate entry would draw a second, almost-always-quiet "run" in the UI
    that never happened.
    ponytail: "the same run" is a 2-hour window on the newest entry, because the
    entry carries no run id. Run this script standalone more than 2h after a
    scrape and it files its own entry instead - the honest fallback, not a wrong
    attribution. The upgrade path is threading a run id through scrape.yml.

    Unlike the supermarket legs, a refresh that moved nothing writes NOTHING.
    The quiet-runs-are-data argument doesn't hold here: an outside price is
    hand-seeded and often unreachable, so "no change" mostly means "could not
    check", which is already recorded per entry as `status`."""
    if not changes:
        return
    path = os.path.join(DATA_DIR, "price_changes.json")
    log = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                log = json.load(f)
        except Exception:
            log = []
    if not isinstance(log, list):
        log = []
    last = log[-1] if log else None
    if isinstance(last, dict) and "third" not in last and _belongs_to_run(last.get("date"), now):
        last["third"] = changes
    else:
        log.append({
            "date": (now or datetime.now(timezone.utc)).isoformat(),
            "trigger": "third_stores",
            "ww": [], "coles": [], "third": changes,
        })
    with open(path, "w", encoding="utf-8") as f:
        json.dump(log, f, separators=(",", ":"))


def parse_price_for(store: str, html: str):
    for fn in PARSERS.get(store, ()):
        p = fn(html)
        if p is not None:
            return p
    return None


# ── the refresh run ──────────────────────────────────────────────────────────

async def refresh() -> int:
    with open(THIRD_PATH, encoding="utf-8") as f:
        doc = json.load(f)

    entries = [e for k, v in doc.items() if k != "_readme" and isinstance(v, list)
               for e in v if isinstance(e, dict) and e.get("url")]
    if not entries:
        print("third_stores: nothing to refresh")
        return 0

    from playwright.async_api import async_playwright
    today = date.today().isoformat()
    updated = failed = 0
    changes: list = []   # {store,item,old,new} -> price_changes.json

    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(PROFILE_DIR, headless=True)
        page = await ctx.new_page()
        for e in entries:
            store = e.get("store", "?")
            try:
                await page.goto(e["url"], timeout=PAGE_TIMEOUT_MS, wait_until="domcontentloaded")
                # JS-challenge pages resolve a beat after domcontentloaded; give
                # a real render a chance before reading the DOM.
                await page.wait_for_timeout(2500)
                html = await page.content()
                price = parse_price_for(store, html)
            except Exception as ex:
                print(f"  [{store}] {e.get('name','?')[:40]}: {type(ex).__name__}")
                price = None
            if price is not None:
                old = e.get("price")
                e["price"], e["checked"] = round(price, 2), today
                e.pop("status", None)
                e.pop("note", None)
                updated += 1
                # A first-ever price is not a "change" - there is nothing it
                # moved from, and recording one would draw a phantom drop from $0.
                if old is not None and round(float(old), 2) != round(price, 2):
                    changes.append({"store": store, "item": e.get("name", ""),
                                    "old": round(float(old), 2), "new": round(price, 2)})
                print(f"  [{store}] {e.get('name','?')[:40]}: "
                      f"{'$%.2f' % old if old else 'no price'} -> ${price:.2f}")
            else:
                # keep the old price; record that this attempt could not confirm it
                e["status"] = f"unreachable {today}"
                failed += 1
                print(f"  [{store}] {e.get('name','?')[:40]}: unreachable, keeping "
                      f"{'$%.2f' % e['price'] if e.get('price') else 'no price'}")
        await ctx.close()

    with open(THIRD_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    _record_third_changes(changes)
    print(f"third_stores: {updated} updated, {failed} unreachable of {len(entries)}"
          f", {len(changes)} price change(s) logged")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(refresh()))
