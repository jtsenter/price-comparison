import asyncio
import json
import os
import random
import re
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from categories import guess_category
from shopping_list import detect_fuzzy_changes, get_active_shopping_list

WOOLWORTHS_BASE = "https://www.woolworths.com.au"
COLES_BASE = "https://www.coles.com.au"
MAX_RESULTS = 5
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
FLAG_PATH = os.path.join(DATA_DIR, "name_changes_detected.json")
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "..", "shopping_list.xlsx")

# Only log verbose debug for the first WW item
_ww_debug_done = False


# ---------------------------------------------------------------------------
# Price parsing
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
    m = re.search(r"(?:per|/)\s*(.+?)(?:\s*$|\))", text, re.IGNORECASE)
    unit = m.group(1).strip() if m else None
    return price, unit


def resolve_url(href: str, base: str) -> str:
    if not href:
        return ""
    if href.startswith("http"):
        return href
    return base + href


# ---------------------------------------------------------------------------
# Woolworths — try __NEXT_DATA__ SSR first, then internal API, then DOM
# ---------------------------------------------------------------------------

def _parse_ww_products(product_list: list) -> list[dict]:
    """Parse Woolworths product objects (same shape from API and __NEXT_DATA__)."""
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
        })

        if len(results) >= MAX_RESULTS:
            break

    return results


def _extract_from_next_data(next_data: dict) -> list[dict]:
    """Navigate __NEXT_DATA__ to find Woolworths product list."""
    page_props = next_data.get("props", {}).get("pageProps", {})

    # Common Next.js paths Woolworths uses
    candidate_paths = [
        lambda p: p.get("searchProducts", {}).get("Products", []),
        lambda p: p.get("initialData", {}).get("Products", []),
        lambda p: p.get("products", {}).get("Products", []),
        lambda p: p.get("searchResult", {}).get("Products", []),
    ]

    for path_fn in candidate_paths:
        try:
            bundles = path_fn(page_props)
            if bundles:
                all_products = []
                for bundle in bundles:
                    items = bundle.get("Products", []) if isinstance(bundle, dict) else []
                    all_products.extend(items)
                if all_products:
                    return _parse_ww_products(all_products)
        except Exception:
            continue

    return []


WW_DOM_EXTRACT_JS = """
() => {
    const selectors = [
        '[data-testid="product-tile"]',
        'article.shelfProductTile',
        'section.shelfProductTile',
        'article[class*="ProductTile"]',
        'div[class*="product-tile"]',
    ];
    let tiles = [];
    for (const sel of selectors) {
        tiles = Array.from(document.querySelectorAll(sel));
        if (tiles.length > 0) break;
    }

    return tiles.slice(0, 5).map(tile => {
        const nameSelectors = [
            '[data-testid="product-title"]',
            '[class*="product-title"]',
            '[class*="ProductTitle"]',
            'h2', 'h3',
        ];
        let name = '';
        for (const s of nameSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
        }

        const priceSelectors = [
            '[data-testid="price"]',
            '[class*="Price"][class*="current"i]',
            '[class*="price-dollars"]',
            '[class*="product-price"]:not([class*="unit"]):not([class*="per"])',
        ];
        let priceText = '';
        for (const s of priceSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.match(/\\$/)) { priceText = el.textContent.trim(); break; }
        }

        const unitSelectors = [
            '[data-testid="product-unit-price"]',
            '[class*="unit-price"]',
            '[class*="unitPrice"]',
            '[class*="cup-price"]',
            '[class*="pricePerUnit"]',
        ];
        let unitPriceText = '';
        for (const s of unitSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.trim()) { unitPriceText = el.textContent.trim(); break; }
        }

        const linkEl = tile.querySelector('a[href*="productdetails"], a[href*="/product/"], a[href]');

        return {
            name,
            price_text: priceText,
            unit_price_text: unitPriceText,
            url: linkEl?.getAttribute('href') || '',
        };
    }).filter(p => p.name);
}
"""


async def delay():
    await asyncio.sleep(random.uniform(1.5, 3.5))


async def search_woolworths(page, query: str) -> list[dict]:
    global _ww_debug_done
    url = f"{WOOLWORTHS_BASE}/shop/search/products?searchTerm={quote(query)}"
    try:
        await page.goto(url, wait_until="load", timeout=30000)
        await page.wait_for_timeout(2000)

        current_url = page.url
        title = await page.title()

        if not _ww_debug_done:
            print(f"  [WW DEBUG] Landed URL: {current_url}")
            print(f"  [WW DEBUG] Page title: {title}")
            _ww_debug_done = True

        # ── Strategy 1: extract from embedded __NEXT_DATA__ ──────────────────
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
            page_props_keys = list(
                next_data.get("props", {}).get("pageProps", {}).keys()
            )
            print(f"  [WW] __NEXT_DATA__ found but no products. pageProps keys: {page_props_keys[:8]}")
        else:
            print(f"  [WW] No __NEXT_DATA__ on page")

        # ── Strategy 2: internal JSON API via browser fetch ───────────────────
        result = await page.evaluate(
            """
            async (query) => {
                try {
                    const encoded = encodeURIComponent(query);
                    const r = await fetch(
                        '/apis/ui/Search/products?searchTerm=' + encoded +
                        '&pageNumber=1&pageSize=5&sortType=TraderRelevance&isMobile=false&filters=%5B%5D',
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest'
                            },
                            credentials: 'include'
                        }
                    );
                    if (!r.ok) return { error: 'http_' + r.status };
                    const data = await r.json();
                    return { data };
                } catch(e) {
                    return { error: e.toString() };
                }
            }
            """,
            query,
        )

        if result and result.get("error"):
            print(f"  [WW] API error: {result['error']}")
        elif result and result.get("data"):
            products = []
            for bundle in (result["data"].get("Products") or []):
                products.extend(_parse_ww_products(bundle.get("Products") or []))
                if len(products) >= MAX_RESULTS:
                    break
            if products:
                return products

        # ── Strategy 3: DOM scraping ──────────────────────────────────────────
        raw = await page.evaluate(WW_DOM_EXTRACT_JS)
        if raw:
            results = []
            for r in raw:
                price = parse_price(r["price_text"])
                unit_price, unit = parse_unit_price(r["unit_price_text"])
                results.append({
                    "name": r["name"],
                    "price": price,
                    "unit_price": unit_price,
                    "unit": unit,
                    "url": resolve_url(r["url"], WOOLWORTHS_BASE),
                })
            if any(r["price"] for r in results):
                return results

        return []

    except Exception as e:
        print(f"  [WW] Exception searching '{query}': {e}")
        return []


# ---------------------------------------------------------------------------
# Coles scraping
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
        const nameSelectors = [
            '[data-testid="product-name"]',
            'h2[class*="title"]',
            '[class*="product__title"]',
            '[class*="product-title"]',
            'h2', 'h3',
        ];
        let name = '';
        for (const s of nameSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
        }

        const priceSelectors = [
            '[data-testid="product-pricing"]',
            '[class*="price__value"]',
            '[class*="product__price"]:not([class*="unit"])',
            '[class*="Price"]:not([class*="unit"])',
        ];
        let priceText = '';
        for (const s of priceSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.match(/\\$/)) { priceText = el.textContent.trim(); break; }
        }

        const unitSelectors = [
            '[class*="unit-price"]',
            '[class*="price__per"]',
            '[class*="pricePerUnit"]',
            '[data-testid*="unit"]',
        ];
        let unitPriceText = '';
        for (const s of unitSelectors) {
            const el = tile.querySelector(s);
            if (el?.textContent?.trim()) { unitPriceText = el.textContent.trim(); break; }
        }

        const linkEl = tile.querySelector('a[href*="/product"]');

        return {
            name,
            price_text: priceText,
            unit_price_text: unitPriceText,
            url: linkEl?.getAttribute('href') || '',
        };
    }).filter(p => p.name);
}
"""


async def search_coles(page, query: str) -> list[dict]:
    url = f"{COLES_BASE}/search?q={quote(query)}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        await page.evaluate("window.scrollBy(0, 300)")
        await page.wait_for_timeout(1500)
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
            })
        return results
    except Exception as e:
        print(f"  [Coles] Error searching '{query}': {e}")
        return []


# ---------------------------------------------------------------------------
# Alternatives
# ---------------------------------------------------------------------------

def find_alternatives(all_results: list[dict], matched: dict | None, max_alts: int = 3) -> list[dict]:
    if not matched or matched.get("unit_price") is None:
        return []
    best_unit = matched["unit_price"]
    alts = []
    for r in all_results:
        if r.get("unit_price") and r["unit_price"] < best_unit and r["name"] != matched["name"]:
            alts.append(r)
    alts.sort(key=lambda x: x["unit_price"])
    return alts[:max_alts]


# ---------------------------------------------------------------------------
# Main scrape loop
# ---------------------------------------------------------------------------

async def scrape(trigger: str = "scheduled"):
    shopping_list = get_active_shopping_list(EXCEL_PATH)
    print(f"Active shopping list: {len(shopping_list)} items")

    detect_fuzzy_changes(shopping_list, FLAG_PATH)

    items_output = []
    not_found = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
            ],
        )
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            locale="en-AU",
        )
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        ww_page = await context.new_page()
        coles_page = await context.new_page()

        # Warm up sessions
        await ww_page.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=30000)
        await delay()
        await coles_page.goto(COLES_BASE, wait_until="domcontentloaded", timeout=30000)
        await delay()

        total = len(shopping_list)
        for i, item in enumerate(shopping_list, 1):
            print(f"[{i}/{total}] {item}")
            category = guess_category(item)

            ww_results = await search_woolworths(ww_page, item)
            await delay()
            coles_results = await search_coles(coles_page, item)
            await delay()

            ww_match = ww_results[0] if ww_results else None
            coles_match = coles_results[0] if coles_results else None

            if not ww_match and not coles_match:
                not_found.append(item)
                print(f"  Not found on either store")
                continue

            ww_price = ww_match["price"] if ww_match else None
            coles_price = coles_match["price"] if coles_match else None

            cheaper_store = None
            saving = None
            if ww_price is not None and coles_price is not None:
                if ww_price < coles_price:
                    cheaper_store = "woolworths"
                    saving = round(coles_price - ww_price, 2)
                elif coles_price < ww_price:
                    cheaper_store = "coles"
                    saving = round(ww_price - coles_price, 2)
                else:
                    cheaper_store = "equal"
                    saving = 0.0

            all_for_item = ww_results + coles_results
            best_match = ww_match if (ww_match and ww_match.get("unit_price")) else coles_match
            alternatives = find_alternatives(all_for_item, best_match)

            for alt in alternatives:
                if not alt.get("retailer"):
                    alt["retailer"] = "woolworths" if WOOLWORTHS_BASE in alt.get("url", "") else "coles"

            items_output.append({
                "list_item": item,
                "category": category,
                "woolworths": ww_match,
                "coles": coles_match,
                "cheaper_store": cheaper_store,
                "saving_per_item": saving,
                "alternatives": alternatives,
            })

        await browser.close()

    ww_total = sum(
        r["woolworths"]["price"]
        for r in items_output
        if r["woolworths"] and r["woolworths"].get("price") is not None
    )
    coles_total = sum(
        r["coles"]["price"]
        for r in items_output
        if r["coles"] and r["coles"].get("price") is not None
    )

    output = {
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
        "items": items_output,
        "not_found_items": not_found,
        "summary": {
            "total_woolworths": round(ww_total, 2),
            "total_coles": round(coles_total, 2),
            "cheaper_store": "woolworths" if ww_total < coles_total else "coles" if coles_total < ww_total else "equal",
            "total_saving": round(abs(ww_total - coles_total), 2),
            "items_compared": len(items_output),
            "items_not_found": len(not_found),
        },
    }

    os.makedirs(DATA_DIR, exist_ok=True)
    latest_path = os.path.join(DATA_DIR, "latest.json")
    with open(latest_path, "w") as f:
        json.dump(output, f, indent=2)

    dated_path = os.path.join(DATA_DIR, f"{datetime.now().strftime('%Y-%m-%d')}.json")
    with open(dated_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nDone. {len(items_output)} items compared, {len(not_found)} not found.")
    print(f"Woolworths total: ${ww_total:.2f} | Coles total: ${coles_total:.2f}")
    print(f"Results written to {latest_path}")


if __name__ == "__main__":
    trigger = sys.argv[1] if len(sys.argv) > 1 else "manual"
    asyncio.run(scrape(trigger))
