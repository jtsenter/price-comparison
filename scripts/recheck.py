"""
recheck.py — Re-examine items with missing prices or suspicious price discrepancies.

For each flagged item:
  - Missing store: re-search with the full name, then a simplified fallback name,
    pick the result with the best fuzzy name score (>= MATCH_THRESHOLD).
  - Both stores present but price diff > DISCREPANCY_THRESHOLD AND low name
    similarity between matched products: re-search both stores, pick best fuzzy match.

Patches latest.json in-place and commits/pushes.
"""

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from playwright.async_api import async_playwright
from thefuzz import fuzz

sys.path.insert(0, os.path.dirname(__file__))
from scraper import (
    search_woolworths, search_coles,
    parse_price, parse_unit_price, resolve_url,
    WOOLWORTHS_BASE, COLES_BASE, DATA_DIR,
)

MATCH_THRESHOLD = 55        # min fuzzy score to accept a result as a match
DISCREPANCY_THRESHOLD = 0.31  # price diff / max_price to trigger re-check
NAME_SIMILARITY_THRESHOLD = 50  # if matched names are this dissimilar, suspect wrong match
REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
LATEST_PATH = os.path.join(DATA_DIR, "latest.json")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def simplify_name(name: str) -> str:
    """Strip brand/store prefixes and size tokens to get a shorter search query."""
    # Remove leading store brands
    for prefix in ("Woolworths ", "Coles ", "Australian ", "Fresh "):
        if name.startswith(prefix):
            name = name[len(prefix):]
    # Remove size/weight tokens at the end (e.g. "500g", "1kg", "2L", "x6")
    name = re.sub(r'\s+\d+(\.\d+)?\s*(g|kg|ml|l|mL|L|ea|pk|pack|x\d+)\b.*$', '', name, flags=re.IGNORECASE)
    return name.strip()


def best_match(query: str, results: list[dict]) -> dict | None:
    """Return the result with the highest fuzzy name-match score, if above threshold."""
    if not results:
        return None
    scored = [
        (fuzz.token_sort_ratio(query.lower(), r["name"].lower()), r)
        for r in results if r.get("name") and r.get("price") is not None
    ]
    if not scored:
        return None
    score, match = max(scored, key=lambda x: x[0])
    print(f"    best match score={score}: {match['name']!r}")
    return match if score >= MATCH_THRESHOLD else None


def name_similarity(a: str | None, b: str | None) -> int:
    if not a or not b:
        return 0
    return fuzz.token_sort_ratio(a.lower(), b.lower())


def flag_items(items: list[dict]) -> list[dict]:
    """Return items that need re-checking."""
    flagged = []
    for item in items:
        ww = item.get("woolworths")
        co = item.get("coles")
        ww_price = ww["price"] if ww else None
        co_price = co["price"] if co else None

        if ww is None or co is None:
            item["_recheck_reason"] = "missing_store"
            flagged.append(item)
            continue

        if ww_price and co_price:
            diff_pct = abs(ww_price - co_price) / max(ww_price, co_price)
            if diff_pct >= DISCREPANCY_THRESHOLD:
                sim = name_similarity(ww.get("name"), co.get("name"))
                if sim < NAME_SIMILARITY_THRESHOLD:
                    item["_recheck_reason"] = f"discrepancy_{round(diff_pct*100)}pct_sim{sim}"
                    flagged.append(item)

    return flagged


async def recheck_item(item: dict, ww_page, coles_page) -> dict:
    """Re-search for the item and return an updated copy, or the original if no improvement."""
    query = item["list_item"]
    reason = item.get("_recheck_reason", "")
    ww_orig = item.get("woolworths")
    co_orig = item.get("coles")
    updated = dict(item)

    print(f"  Reason: {reason}")

    async def search_with_fallback(search_fn, page, q):
        results = await search_fn(page, q)
        m = best_match(q, results)
        if m is None:
            short = simplify_name(q)
            if short and short != q:
                print(f"    Fallback query: {short!r}")
                results2 = await search_fn(page, short)
                m = best_match(q, results2)  # still score against original name
        return m

    if reason == "missing_store" or "discrepancy" in reason:
        need_ww = ww_orig is None or "discrepancy" in reason
        need_co = co_orig is None or "discrepancy" in reason

        ww_new, co_new = await asyncio.gather(
            search_with_fallback(search_woolworths, ww_page, query) if need_ww else asyncio.sleep(0, result=None),
            search_with_fallback(search_coles,     coles_page, query) if need_co else asyncio.sleep(0, result=None),
        )

        if need_ww and ww_new:
            print(f"    WW updated: {ww_new['name']!r} @ ${ww_new['price']}")
            updated["woolworths"] = ww_new
        elif need_ww:
            print(f"    WW: no better match found")

        if need_co and co_new:
            print(f"    Coles updated: {co_new['name']!r} @ ${co_new['price']}")
            updated["coles"] = co_new
        elif need_co:
            print(f"    Coles: no better match found")

        # Recompute cheaper_store and saving
        ww_p = (updated.get("woolworths") or {}).get("price")
        co_p = (updated.get("coles") or {}).get("price")
        if ww_p and co_p:
            if ww_p < co_p:
                updated["cheaper_store"] = "woolworths"
                updated["saving_per_item"] = round(co_p - ww_p, 2)
            elif co_p < ww_p:
                updated["cheaper_store"] = "coles"
                updated["saving_per_item"] = round(ww_p - co_p, 2)
            else:
                updated["cheaper_store"] = "equal"
                updated["saving_per_item"] = 0.0
        elif ww_p:
            updated["cheaper_store"] = "woolworths"
            updated["saving_per_item"] = None
        elif co_p:
            updated["cheaper_store"] = "coles"
            updated["saving_per_item"] = None
        else:
            updated["cheaper_store"] = None
            updated["saving_per_item"] = None

    updated.pop("_recheck_reason", None)
    return updated


async def run_recheck():
    with open(LATEST_PATH) as f:
        data = json.load(f)

    items = data.get("items", [])
    flagged = flag_items(items)

    if not flagged:
        print("No items need re-checking.")
        return

    print(f"\n{len(flagged)} items flagged for re-check:")
    for it in flagged:
        print(f"  [{it['_recheck_reason']}] {it['list_item']}")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            channel="chrome",
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="en-AU",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        ww_page = await ctx.new_page()
        coles_page = await ctx.new_page()

        await ww_page.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=20000)
        await coles_page.goto(COLES_BASE, wait_until="domcontentloaded", timeout=20000)

        item_map = {it["list_item"]: it for it in items}
        fixed = 0

        for item in flagged:
            print(f"\n[{flagged.index(item)+1}/{len(flagged)}] {item['list_item']}")
            updated = await recheck_item(item, ww_page, coles_page)
            item_map[item["list_item"]] = updated
            fixed += 1

        await browser.close()

    # Rebuild items list preserving original order
    data["items"] = [item_map.get(it["list_item"], it) for it in items]
    data["last_updated"] = datetime.now(timezone.utc).isoformat()

    with open(LATEST_PATH, "w") as f:
        json.dump(data, f, indent=2)

    print(f"\nPatched {fixed} items. Committing...")

    try:
        subprocess.run(["git", "config", "user.name",  "github-actions[bot]"], cwd=REPO_ROOT, check=False, capture_output=True)
        subprocess.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd=REPO_ROOT, check=False, capture_output=True)
        subprocess.run(["git", "add", "docs/data/"], cwd=REPO_ROOT, check=True, capture_output=True)
        diff = subprocess.run(["git", "diff", "--staged", "--quiet"], cwd=REPO_ROOT)
        if diff.returncode != 0:
            subprocess.run(["git", "commit", "-m", f"recheck: fix {fixed} items (missing/discrepant matches)"], cwd=REPO_ROOT, check=True)
            subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=REPO_ROOT, check=True, capture_output=True)
            subprocess.run(["git", "push"], cwd=REPO_ROOT, check=True)
            print("Pushed.")
        else:
            print("No changes to commit.")
    except subprocess.CalledProcessError as e:
        print(f"Git error: {e}")


if __name__ == "__main__":
    asyncio.run(run_recheck())
