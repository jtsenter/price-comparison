import asyncio
import json
import os
import random
import re
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from categories import guess_category
from shopping_list import detect_fuzzy_changes, get_purchase_history

WOOLWORTHS_BASE = "https://www.woolworths.com.au"
COLES_BASE = "https://www.coles.com.au"
MAX_RESULTS = 5
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
FLAG_PATH = os.path.join(DATA_DIR, "name_changes_detected.json")
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "..", "shopping_list.xlsx")

_ww_debug_done = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_price(text: str) -> float | None:
    if not text:
        return None
    m = re.search(r"\$\s*(\d[\d,]*(?:\.\d{1,2})?)", text)
    return float(m.group(1).replace(",", "")) if m else None


def parse_unit_price(text: str) -> tuple[float | None, str | None]:
    if not text:
        return None, None
    price = parse_price(text)
    m = re.search(r"(?:per|/)\s*(\d*\.?\d*\s*(?:g|kg|ml|l|ea|pk|pack|each))\b", text, re.IGNORECASE)
    unit = m.group(1).strip() if m else None
    return price, unit


def resolve_url(href: str, base: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    return base + href


# ---------------------------------------------------------------------------
# Woolworths — blocked by 403 from GitHub Actions IPs; kept for local use
# ---------------------------------------------------------------------------

def _parse_ww_products(product_list: list) -> list[dict]:
    results = []
    for p in product_list:
        stockcode = p.get("Stockcode")
        url_name = p.get("UrlFriendlyName", "")
        name = p.get("Name", "")
        price = p.get("Price")
        cup_price = p.get("CupPrice")
        cup_string = p.get("CupString", "")
        if not name or price is None:
            continue
        product_url = (
            f"{WOOLWORTHS_BASE}/shop/productdetails/{stockcode}/{url_name}"
            if stockcode else ""
        )
        _, unit = parse_unit_price(cup_string)
        results.append({
            "name": name,
            "price": float(price),
            "unit_price": float(cup_price) if cup_price is not None else None,
            "unit": unit,
            "url": product_url,
            "image_url": p.get("LargeImageFile") or p.get("MediumImageFile") or "",
        })
        if len(results) >= MAX_RESULTS:
            break
    return results


def _extract_from_next_data(next_data: dict) -> list[dict]:
    page_props = next_data.get("props", {}).get("pageProps", {})
    for path_fn in [
        lambda p: p.get("searchProducts", {}).get("Products", []),
        lambda p: p.get("initialData", {}).get("Products", []),
        lambda p: p.get("products", {}).get("Products", []),
    ]:
        try:
            bundles = path_fn(page_props)
            if bundles:
                all_products = []
                for bundle in bundles:
                    all_products.extend(bundle.get("Products", []) if isinstance(bundle, dict) else [])
                if all_products:
                    return _parse_ww_products(all_products)
        except Exception:
            continue
    return []


async def delay():
    await asyncio.sleep(random.uniform(0.3, 0.8))


async def search_woolworths(page, query: str) -> list[dict]:
    global _ww_debug_done
    url = f"{WOOLWORTHS_BASE}/shop/search/products?searchTerm={quote(query)}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(600)

        current_url = page.url
        title = await page.title()
        if not _ww_debug_done:
            print(f"  [WW DEBUG] URL: {current_url}")
            print(f"  [WW DEBUG] Title: {title}")
            _ww_debug_done = True

        # Try __NEXT_DATA__ SSR first
        next_data = await page.evaluate("""
            () => {
                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return null;
                try { return JSON.parse(el.textContent); } catch(e) { return null; }
            }
        """)
        if next_data:
            products = _extract_from_next_data(next_data)
            if products:
                return products

        # Fallback: internal API
        result = await page.evaluate("""
            async (query) => {
                try {
                    const r = await fetch(
                        '/apis/ui/Search/products?searchTerm=' + encodeURIComponent(query) +
                        '&pageNumber=1&pageSize=5&sortType=TraderRelevance&isMobile=false&filters=%5B%5D',
                        { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' }
                    );
                    if (!r.ok) return { error: 'http_' + r.status };
                    return { data: await r.json() };
                } catch(e) { return { error: e.toString() }; }
            }
        """, query)

        if result and result.get("error"):
            print(f"  [WW] blocked: {result['error']}")
        elif result and result.get("data"):
            products = []
            for bundle in (result["data"].get("Products") or []):
                products.extend(_parse_ww_products(bundle.get("Products") or []))
                if len(products) >= MAX_RESULTS:
                    break
            if products:
                return products

        return []
    except Exception as e:
        print(f"  [WW] Exception: {e}")
        return []


async def fetch_ww_by_url(page, url: str) -> dict | None:
    """Fetch a single WW product directly by URL (faster than search)."""
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(800)
        next_data = await page.evaluate("""
            () => {
                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return null;
                try { return JSON.parse(el.textContent); } catch { return null; }
            }
        """)
        if next_data:
            pp = next_data.get("props", {}).get("pageProps", {})
            product = pp.get("product") or pp.get("Product")
            if product:
                name = product.get("Name", "")
                price = product.get("Price")
                cup_price = product.get("CupPrice")
                cup_string = product.get("CupString", "")
                stockcode = product.get("Stockcode")
                url_name = product.get("UrlFriendlyName", "")
                if name and price is not None:
                    _, unit = parse_unit_price(cup_string)
                    product_url = (
                        f"{WOOLWORTHS_BASE}/shop/productdetails/{stockcode}/{url_name}"
                        if stockcode else url
                    )
                    return {
                        "name": name,
                        "price": float(price),
                        "unit_price": float(cup_price) if cup_price is not None else None,
                        "unit": unit,
                        "url": product_url,
                        "image_url": product.get("LargeImageFile") or product.get("MediumImageFile") or "",
                    }
        print(f"  [WW] __NEXT_DATA__ product not found for: {url}")
    except Exception as e:
        print(f"  [WW] Exception fetching URL {url}: {e}")
    return None


# ---------------------------------------------------------------------------
# Coles
# ---------------------------------------------------------------------------

COLES_EXTRACT_JS = """
() => {
    const selectors = [
        '[data-testid="product-tile"]',
        'article.product-tile',
        'article[class*="product"]',
        'div[class*="product-tile"]',
        'li[class*="product"]',
    ];
    let tiles = [];
    for (const sel of selectors) {
        tiles = Array.from(document.querySelectorAll(sel));
        if (tiles.length > 0) break;
    }

    return tiles.slice(0, 5).map(tile => {
        let name = '';
        for (const s of ['[data-testid="product-name"]','h2[class*="title"]','[class*="product__title"]','[class*="product-title"]','h2','h3']) {
            const el = tile.querySelector(s);
            if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
        }

        let priceText = '';
        for (const s of ['[data-testid="product-pricing"]','[class*="price__value"]','[class*="product__price"]:not([class*="unit"])','[class*="Price"]:not([class*="unit"])']) {
            const el = tile.querySelector(s);
            if (el?.textContent?.match(/\\$/)) { priceText = el.textContent.trim(); break; }
        }

        let unitPriceText = '';
        for (const s of [
            '[class*="CupPrice"]','[class*="cup-price"]','[class*="cupPrice"]',
            '[class*="price_cup"]','[class*="UnitPrice"]','[class*="unit-price"]',
            '[class*="price__per"]','[class*="pricePerUnit"]',
            '[data-testid*="cup"]','[data-testid*="unit"]',
        ]) {
            const el = tile.querySelector(s);
            const t = el?.textContent?.trim() || '';
            if (t && t.length < 30) { unitPriceText = t; break; }
        }
        // Fallback: scan all small text nodes in the tile for "per" or "/" price patterns
        if (!unitPriceText) {
            for (const el of tile.querySelectorAll('span,div,p')) {
                const t = el.textContent?.trim() || '';
                if (t.length < 30 && /\$[\d.]+\s*(\/|per\s*)\s*[\d.]*\s*\w+/i.test(t)) {
                    unitPriceText = t; break;
                }
            }
        }

        const linkEl = tile.querySelector('a[href*="/product"]');

        // Get product image — try src first, then data-src for lazy-loaded images
        let imageUrl = '';
        const imgEl = tile.querySelector('img');
        if (imgEl) {
            const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
            // Skip tiny base64 placeholders
            if (src && !src.startsWith('data:') && src.length > 20) imageUrl = src;
        }

        return { name, price_text: priceText, unit_price_text: unitPriceText,
                 url: linkEl?.getAttribute('href') || '', image_url: imageUrl };
    }).filter(p => p.name);
}
"""


async def search_coles(page, query: str) -> list[dict]:
    url = f"{COLES_BASE}/search?q={quote(query)}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        await page.evaluate("window.scrollBy(0, 300)")
        await page.wait_for_timeout(800)
        raw = await page.evaluate(COLES_EXTRACT_JS)
        results = []
        for r in raw:
            price = parse_price(r["price_text"])
            unit_price, unit = parse_unit_price(r["unit_price_text"])
            results.append({
                "name": r["name"],
                "price": price,
                "unit_price": unit_price,
                "unit": unit,
                "url": resolve_url(r["url"], COLES_BASE),
                "image_url": r.get("image_url", ""),
            })
        return results
    except Exception as e:
        print(f"  [Coles] Error searching '{query}': {e}")
        return []


COLES_PRODUCT_PAGE_JS = """
() => {
    let name = '';
    for (const s of ['h1[class*="product-title"]','h1[class*="heading"]','[data-testid="product-name"]','h1']) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
    }
    let priceText = '';
    for (const s of ['[data-testid="product-pricing"]','[class*="price__value"]','[class*="product-price"]','[class*="Price"]']) {
        const el = document.querySelector(s);
        if (el?.textContent?.match(/\\$/)) { priceText = el.textContent.trim(); break; }
    }
    let unitPriceText = '';
    for (const s of [
        '[class*="CupPrice"]','[class*="cup-price"]','[class*="cupPrice"]',
        '[class*="price_cup"]','[class*="UnitPrice"]','[class*="unit-price"]',
        '[class*="price__per"]','[class*="pricePerUnit"]',
        '[data-testid*="cup"]','[data-testid*="unit"]',
    ]) {
        const el = document.querySelector(s);
        const t = el?.textContent?.trim() || '';
        if (t && t.length < 30) { unitPriceText = t; break; }
    }
    let imageUrl = '';
    const imgEl = document.querySelector('[class*="product-image"] img, img[alt][src*="coles"]');
    if (imgEl) {
        const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
        if (src && !src.startsWith('data:') && src.length > 20) imageUrl = src;
    }
    return { name, price_text: priceText, unit_price_text: unitPriceText, image_url: imageUrl };
}
"""


async def fetch_coles_by_url(page, url: str) -> dict | None:
    """Fetch a single Coles product directly by URL (faster than search)."""
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=20000)
        await page.wait_for_timeout(1500)
        raw = await page.evaluate(COLES_PRODUCT_PAGE_JS)
        name = raw.get("name", "")
        price = parse_price(raw.get("price_text", ""))
        unit_price, unit = parse_unit_price(raw.get("unit_price_text", ""))
        if name and price:
            return {
                "name": name,
                "price": price,
                "unit_price": unit_price,
                "unit": unit,
                "url": url,
                "image_url": raw.get("image_url", ""),
            }
        print(f"  [Coles] Could not extract product (name={name!r}, price={price}) from: {url}")
    except Exception as e:
        print(f"  [Coles] Exception fetching URL {url}: {e}")
    return None


# ---------------------------------------------------------------------------
# Alternatives
# ---------------------------------------------------------------------------

def find_alternatives(all_results: list[dict], matched: dict | None, max_alts: int = 3) -> list[dict]:
    if not matched or matched.get("unit_price") is None:
        return []
    best_unit = matched["unit_price"]
    alts = [r for r in all_results if r.get("unit_price") and r["unit_price"] < best_unit and r["name"] != matched["name"]]
    alts.sort(key=lambda x: x["unit_price"])
    return alts[:max_alts]


# ---------------------------------------------------------------------------
# Incremental push helpers
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")

def _build_output(items: list, not_found: list, trigger: str, progress: dict | None = None) -> dict:
    ww_total = sum(r["woolworths"]["price"] for r in items if r.get("woolworths") and r["woolworths"].get("price") is not None)
    coles_total = sum(r["coles"]["price"] for r in items if r.get("coles") and r["coles"].get("price") is not None)
    ww_available = ww_total > 0
    if not ww_available:
        cheaper = "coles_only"
    elif coles_total == 0:
        cheaper = "ww_only"
    elif ww_total < coles_total:
        cheaper = "woolworths"
    elif coles_total < ww_total:
        cheaper = "coles"
    else:
        cheaper = "equal"
    out = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
        "items": items,
        "not_found_items": not_found,
        "summary": {
            "total_woolworths": round(ww_total, 2),
            "total_coles": round(coles_total, 2),
            "cheaper_store": cheaper,
            "ww_data_available": ww_available,
            "total_saving": round(abs(ww_total - coles_total), 2) if ww_available else 0,
            "items_compared": len(items),
            "items_not_found": len(not_found),
        },
    }
    if progress:
        out["scrape_progress"] = progress
    return out


def push_progress(items: list, not_found: list, done: int, total: int, trigger: str):
    out = _build_output(items, not_found, trigger, progress={"done": done, "total": total})
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "latest.json"), "w") as f:
        json.dump(out, f, indent=2)
    try:
        subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=REPO_ROOT, check=False, capture_output=True)
        subprocess.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd=REPO_ROOT, check=False, capture_output=True)
        subprocess.run(["git", "add", "docs/data/"], cwd=REPO_ROOT, check=False, capture_output=True)
        diff = subprocess.run(["git", "diff", "--staged", "--quiet"], cwd=REPO_ROOT)
        if diff.returncode != 0:
            subprocess.run(["git", "commit", "-m", f"progress: {done}/{total} items scraped"], cwd=REPO_ROOT, check=False, capture_output=True)
            subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=REPO_ROOT, check=False, capture_output=True)
            subprocess.run(["git", "push"], cwd=REPO_ROOT, check=False, capture_output=True)
            print(f"  -> Pushed progress ({done}/{total})")
    except Exception as e:
        print(f"  -> Progress push skipped: {e}")


# ---------------------------------------------------------------------------
# Main scrape loop
# ---------------------------------------------------------------------------

async def scrape(trigger: str = "scheduled", single_item: str = "", ww_url: str = "", coles_url: str = ""):
    purchase_history = get_purchase_history(EXCEL_PATH)

    if single_item:
        shopping_list = [single_item]
        print(f"Single-item refresh: {single_item}" + (f" [WW URL]" if ww_url else "") + (f" [Coles URL]" if coles_url else ""))
    else:
        # Sort by priority: weekly (7+ trips) first, monthly (3+) second, then rest
        def _priority_key(name):
            h = purchase_history.get(name, {})
            trips = h.get("trip_count", 0)
            if trips >= 7: return 0
            if trips >= 3: return 1
            return 2
        shopping_list = sorted(purchase_history.keys(), key=_priority_key)
        print(f"Active shopping list: {len(shopping_list)} items")

    detect_fuzzy_changes(shopping_list, FLAG_PATH)

    items_output = []
    not_found = []

    # Load existing data for single-item partial updates (keep other store's data)
    latest_path = os.path.join(DATA_DIR, "latest.json")
    existing_data = {}
    if single_item and (ww_url or coles_url) and os.path.exists(latest_path):
        with open(latest_path) as f:
            existing_data = json.load(f)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            channel="chrome",
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="en-AU",
        )
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        ww_page = await context.new_page()
        coles_page = await context.new_page()

        # Only visit homepages for stores we'll actually scrape (saves time for single-URL updates)
        need_ww = not (single_item and coles_url and not ww_url)
        need_coles = not (single_item and ww_url and not coles_url)

        if need_ww:
            await ww_page.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=20000)
            await delay()
        if need_coles:
            await coles_page.goto(COLES_BASE, wait_until="domcontentloaded", timeout=20000)
            await delay()

        total = len(shopping_list)
        for i, item in enumerate(shopping_list, 1):
            print(f"[{i}/{total}] {item}")
            category = guess_category(item)
            history = purchase_history.get(item, {})

            # Determine fetch strategy
            if single_item and (ww_url or coles_url):
                existing_item = next((ex for ex in existing_data.get("items", []) if ex["list_item"] == item), {})

                if ww_url and not coles_url:
                    # Fetch WW by URL only; keep existing Coles data
                    print(f"  Fetching WW by URL: {ww_url}")
                    ww_match = await fetch_ww_by_url(ww_page, ww_url)
                    if not ww_match:
                        print("  URL fetch failed, falling back to name search")
                        res = await search_woolworths(ww_page, item)
                        ww_match = res[0] if res else None
                    coles_match = existing_item.get("coles")

                elif coles_url and not ww_url:
                    # Fetch Coles by URL only; keep existing WW data
                    print(f"  Fetching Coles by URL: {coles_url}")
                    coles_match = await fetch_coles_by_url(coles_page, coles_url)
                    if not coles_match:
                        print("  URL fetch failed, falling back to name search")
                        res = await search_coles(coles_page, item)
                        coles_match = res[0] if res else None
                    ww_match = existing_item.get("woolworths")

                else:
                    # Both URLs provided
                    print(f"  Fetching WW by URL: {ww_url}")
                    ww_match = await fetch_ww_by_url(ww_page, ww_url)
                    if not ww_match:
                        res = await search_woolworths(ww_page, item)
                        ww_match = res[0] if res else None
                    print(f"  Fetching Coles by URL: {coles_url}")
                    coles_match = await fetch_coles_by_url(coles_page, coles_url)
                    if not coles_match:
                        res = await search_coles(coles_page, item)
                        coles_match = res[0] if res else None

                ww_results = [ww_match] if ww_match else []
                coles_results = [coles_match] if coles_match else []

            else:
                # Normal: search both stores by name in parallel
                ww_results, coles_results = await asyncio.gather(
                    search_woolworths(ww_page, item),
                    search_coles(coles_page, item),
                )
                await delay()
                ww_match = ww_results[0] if ww_results else None
                coles_match = coles_results[0] if coles_results else None

            if not ww_match and not coles_match:
                not_found.append(item)
                continue

            ww_price = ww_match["price"] if ww_match else None
            coles_price = coles_match["price"] if coles_match else None

            cheaper_store = None
            saving = None
            if ww_price is not None and coles_price is not None:
                if ww_price < coles_price:
                    cheaper_store, saving = "woolworths", round(coles_price - ww_price, 2)
                elif coles_price < ww_price:
                    cheaper_store, saving = "coles", round(ww_price - coles_price, 2)
                else:
                    cheaper_store, saving = "equal", 0.0
            elif coles_price is not None:
                cheaper_store = "coles"
            elif ww_price is not None:
                cheaper_store = "woolworths"

            all_for_item = ww_results + coles_results
            best_match = ww_match if (ww_match and ww_match.get("unit_price")) else coles_match
            alternatives = find_alternatives(all_for_item, best_match)
            for alt in alternatives:
                if not alt.get("retailer"):
                    alt["retailer"] = "woolworths" if WOOLWORTHS_BASE in alt.get("url", "") else "coles"

            items_output.append({
                "list_item": item,
                "trip_count": history.get("trip_count", 0),
                "price_history": history.get("price_history", []),
                "category": category,
                "woolworths": ww_match,
                "coles": coles_match,
                "cheaper_store": cheaper_store,
                "saving_per_item": saving,
                "alternatives": alternatives,
            })

            if not single_item and i % 3 == 0:
                push_progress(items_output, not_found, i, total, trigger)

        await browser.close()

    os.makedirs(DATA_DIR, exist_ok=True)
    latest_path = os.path.join(DATA_DIR, "latest.json")

    if single_item:
        existing = {}
        if os.path.exists(latest_path):
            with open(latest_path) as f:
                existing = json.load(f)
        all_items = existing.get("items", [])
        if items_output:
            replaced = False
            for idx, ex in enumerate(all_items):
                if ex["list_item"] == single_item:
                    all_items[idx] = items_output[0]
                    replaced = True
                    break
            if not replaced:
                all_items.append(items_output[0])
        output = _build_output(all_items, existing.get("not_found_items", []), trigger)
        print(f"Patched '{single_item}' into existing data ({len(all_items)} total items).")
    else:
        output = _build_output(items_output, not_found, trigger)
        s = output["summary"]
        print(f"\nDone. {len(items_output)} items compared, {len(not_found)} not found.")
        print(f"Woolworths total: ${s['total_woolworths']:.2f} | Coles total: ${s['total_coles']:.2f}")

    with open(latest_path, "w") as f:
        json.dump(output, f, indent=2)
    with open(os.path.join(DATA_DIR, f"{datetime.now().strftime('%Y-%m-%d')}.json"), "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    trigger = sys.argv[1] if len(sys.argv) > 1 else "manual"
    single_item = sys.argv[2].strip() if len(sys.argv) > 2 else ""
    ww_url = sys.argv[3].strip() if len(sys.argv) > 3 else ""
    coles_url = sys.argv[4].strip() if len(sys.argv) > 4 else ""
    asyncio.run(scrape(trigger, single_item=single_item, ww_url=ww_url, coles_url=coles_url))
