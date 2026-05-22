import asyncio
import json
import os
import random
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from urllib.parse import quote, urlparse, parse_qs, unquote

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from categories import guess_category
from matcher import pick_best_match, validate_pair, extract_weight_g
from shopping_list import detect_fuzzy_changes, get_purchase_history

WOOLWORTHS_BASE = "https://www.woolworths.com.au"
COLES_BASE = "https://www.coles.com.au"
COLES_CDN = "https://cdn.productimages.coles.com.au/productimages"


def _normalise_coles_img(img) -> str:
    """Return a publicly accessible image URL from whatever Coles gives us."""
    if not img:
        return ""
    if isinstance(img, dict):
        uri = img.get("uri", "")
        return (COLES_CDN + uri) if uri else ""
    if not isinstance(img, str):
        return ""
    if "/_next/image" in img:
        try:
            inner = parse_qs(urlparse(img).query).get("url", [""])[0]
            if inner:
                decoded = unquote(inner)
                # CDN-relative path (e.g. /4/409499.jpg) → prefix with CDN base
                if decoded.startswith("/") and "://" not in decoded:
                    return COLES_CDN + decoded
                return decoded
        except Exception:
            pass
    # Bare CDN path stored from a previous scrape (e.g. /4/409499.jpg)
    if img.startswith("/") and "://" not in img:
        return COLES_CDN + img
    return img
MAX_RESULTS = 5
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
FLAG_PATH = os.path.join(DATA_DIR, "name_changes_detected.json")
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "..", "shopping_list.xlsx")

# ── Tunable constants ────────────────────────────────────────────────────────
PAGE_TIMEOUT_MS      = 20_000   # page.goto timeout
COLES_WAIT_MS        = 1_500    # post-navigation wait for Coles pages
COLES_SCROLL_WAIT_MS = 800      # post-scroll wait for lazy-loaded tiles
MAX_PRODUCT_PRICE    = 50.0     # upper bound for plausible product prices
SKIP_AGE_DAYS        = 4        # items scraped within N days are skipped

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


async def search_with_retry(search_fn, page, query, retries=0):
    for attempt in range(retries + 1):
        results = await search_fn(page, query)
        if results:
            return results
        if attempt < retries:
            print(f"    No results for '{query}', retrying in 5s…")
            await asyncio.sleep(5)
    return []


async def search_woolworths(page, query: str) -> list[dict]:
    global _ww_debug_done
    url = f"{WOOLWORTHS_BASE}/shop/search/products?searchTerm={quote(query)}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
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
    if url and not url.startswith("http"):
        url = "https://" + url
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
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
                if (t.length < 30 && /\\$[\\d.]+\\s*(\\/|per\\s*)\\s*[\\d.]*\\s*\\w+/i.test(t)) {
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
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        await page.wait_for_timeout(COLES_WAIT_MS)
        await page.evaluate("window.scrollBy(0, 300)")
        await page.wait_for_timeout(COLES_SCROLL_WAIT_MS)
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
                "image_url": _normalise_coles_img(r.get("image_url", "")),
            })
        return results
    except Exception as e:
        print(f"  [Coles] Error searching '{query}': {e}")
        return []


COLES_PRODUCT_PAGE_JS = """
() => {
    // Strategy 1: __NEXT_DATA__ (Next.js SSR — most reliable, not affected by CSS changes)
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
        try {
            const nd = JSON.parse(ndEl.textContent);
            const pp = nd?.props?.pageProps;
            const candidates = [
                pp?.product, pp?.productDetail, pp?.pageProduct,
                pp?.catalogGroupView?.[0], pp?.searchResults?.results?.[0],
            ].filter(Boolean);
            for (const prod of candidates) {
                const name = prod?.name || prod?.displayName || prod?.productTitle || '';
                const pricing = prod?.pricing || prod?.price || {};
                const price = pricing?.now ?? pricing?.current ?? prod?.priceCalc?.price ?? prod?.unitPrice ?? prod?.price;
                if (name && price != null && price > 0) {
                    const comparable = pricing?.comparable || pricing?.cupPrice || '';
                    const rawUri = prod?.imageUris?.[0];
                    const img = (typeof rawUri === 'object' ? rawUri?.uri : rawUri) || prod?.images?.[0]?.uri || '';
                    return { name, price_text: '$' + price, unit_price_text: comparable, image_url: img };
                }
            }
        } catch {}
    }

    // Strategy 2: JSON-LD structured data
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
            const items = [].concat(JSON.parse(script.textContent));
            const prod = items.find(i => i['@type'] === 'Product');
            if (prod?.name && prod?.offers?.price) {
                return { name: prod.name, price_text: '$' + prod.offers.price,
                         unit_price_text: '', image_url: prod.image || '' };
            }
        } catch {}
    }

    // Strategy 3: DOM selectors
    let name = '';
    for (const s of [
        '[data-testid="product-title"]','[data-testid="product-name"]',
        'h1[class*="product-title"]','h1[class*="heading"]','h1',
    ]) {
        const el = document.querySelector(s);
        if (el?.textContent?.trim()) { name = el.textContent.trim(); break; }
    }

    let priceText = '';
    let bestPrice = Infinity;
    const priceSelectors = [
        '[data-testid="product-pricing"]',
        '[class*="price__value"]',
        '[class*="product__price"]:not([class*="was"]):not([class*="save"])',
        '[class*="Price"]:not([class*="was"]):not([class*="save"]):not([class*="WasPrice"])',
    ];
    for (const s of priceSelectors) {
        for (const el of document.querySelectorAll(s)) {
            const t = el.textContent?.trim() || '';
            if (!t.match(/\\$/) || t.length > 20) continue;
            const m = t.match(/\\$\\s*([\\d,]+(?:\\.\\d{1,2})?)/);
            if (m) {
                const v = parseFloat(m[1].replace(',',''));
                if (v > 0 && v < 50 && v < bestPrice) { bestPrice = v; priceText = t; }
            }
        }
        if (priceText) break;
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
    if url and not url.startswith("http"):
        url = "https://" + url
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        await page.wait_for_timeout(COLES_WAIT_MS)
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
                "image_url": _normalise_coles_img(raw.get("image_url", "")),
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
    # Only compare items where both prices are present — avoids single-store items skewing the totals
    comparable = [r for r in items if r.get("woolworths", {}) and r["woolworths"].get("price") is not None
                  and r.get("coles", {}) and r["coles"].get("price") is not None]
    ww_total = sum(r["woolworths"]["price"] for r in comparable)
    coles_total = sum(r["coles"]["price"] for r in comparable)
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


_GIT_TIMEOUT = 45  # seconds per git subprocess call

def push_progress(items: list, not_found: list, done: int, total: int, trigger: str):
    out = _build_output(items, not_found, trigger, progress={"done": done, "total": total})
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "latest.json"), "w") as f:
        json.dump(out, f, indent=2)
    try:
        subprocess.run(["git", "config", "user.name", "github-actions[bot]"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
        subprocess.run(["git", "config", "user.email", "github-actions[bot]@users.noreply.github.com"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
        subprocess.run(["git", "add", "docs/data/"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
        diff = subprocess.run(["git", "diff", "--staged", "--quiet"], cwd=REPO_ROOT, timeout=_GIT_TIMEOUT)
        if diff.returncode != 0:
            commit = subprocess.run(["git", "commit", "-m", f"progress: {done}/{total} items scraped"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
            if commit.returncode == 0:
                # Clean up any stale rebase state before pulling
                for stale in [".git/rebase-merge", ".git/rebase-apply"]:
                    if os.path.exists(os.path.join(REPO_ROOT, stale)):
                        subprocess.run(["git", "rebase", "--abort"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
                        break
                subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
                subprocess.run(["git", "push"], cwd=REPO_ROOT, check=False, capture_output=True, timeout=_GIT_TIMEOUT)
                print(f"  -> Pushed progress ({done}/{total})")
            else:
                print(f"  -> Commit failed, skipping push: {commit.stderr.decode(errors='replace').strip()}")
    except subprocess.TimeoutExpired as e:
        print(f"  -> Progress push timed out: {e}")
    except Exception as e:
        print(f"  -> Progress push skipped: {e}")


_push_thread_ref = [None]
_push_lock = threading.Lock()

def push_progress_bg(items, not_found, done, total, trigger, existing_items=None):
    """Non-blocking progress push — skips if a previous push is still running.
    existing_items: full pre-scrape item list; carry-forward items not yet re-scraped
    so the JSON always shows all products during a scrape.
    """
    with _push_lock:
        if _push_thread_ref[0] and _push_thread_ref[0].is_alive():
            print(f"  -> Push skipped (previous still running)")
            return
        # Merge carry-forward items for items not yet scraped in this run
        if existing_items:
            scraped_names = {i["list_item"] for i in items} | set(not_found)
            carry = [ex for ex in existing_items if ex["list_item"] not in scraped_names]
            merged = json.loads(json.dumps(items)) + carry
        else:
            merged = json.loads(json.dumps(items))
        t = threading.Thread(
            target=push_progress,
            args=(merged, list(not_found), done, total, trigger),
            daemon=True,
        )
        _push_thread_ref[0] = t
        t.start()


# ---------------------------------------------------------------------------
# Main scrape loop
# ---------------------------------------------------------------------------

def should_skip_item(ex_data: dict | None, trigger: str) -> bool:
    """Return True if item was recently scraped and can be skipped on scheduled runs."""
    if not ex_data:
        return False
    # Archived items: skip unless this is an explicit archived-only scrape
    if ex_data.get("archived") and trigger != "scrape_archived":
        return True
    if trigger == "manual":
        return False
    last_scraped = ex_data.get("last_scraped")
    if not last_scraped:
        return False
    ww = ex_data.get("woolworths") or {}
    co = ex_data.get("coles") or {}
    if ww.get("price") is None or co.get("price") is None:
        return False
    try:
        age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(last_scraped)).total_seconds() / 86400
        return age_days < SKIP_AGE_DAYS
    except Exception:
        return False


CONCURRENCY = 2  # parallel items (1 page-pair each)


def _coles_fallback_query(coles_url: str, item: str) -> str:
    """Derive a search query from a Coles product URL slug.

    'coles-strawberries-250g-5191256' → 'strawberries 250g'
    Falls back to item name if the URL doesn't match expected pattern.
    """
    m = re.search(r'/product/([^/?]+)', coles_url)
    if m:
        slug = re.sub(r'^coles-', '', m.group(1))
        slug = re.sub(r'-\d+$', '', slug)
        return slug.replace('-', ' ').strip()
    return item


async def _scrape_single_item(
    item: str, purchase_history: dict, ww_page, coles_page,
    ww_url: str, coles_url: str, existing_data: dict
) -> tuple[dict | None, bool]:
    """Scrape one item. Returns (result_dict | None, is_not_found)."""
    category = guess_category(item)
    history = purchase_history.get(item, {})
    # Fallback: if exact match fails, try substring match (e.g. "Lamb Mince" → "Woolworths Lamb Mince")
    if not history and purchase_history:
        for excel_name, hist_data in purchase_history.items():
            if item.lower() in excel_name.lower() and hist_data.get("price_history"):
                history = hist_data
                break
    existing_item = next((ex for ex in existing_data.get("items", []) if ex["list_item"] == item), {})

    # Tracks whether each side was fetched directly (skip name-based picker)
    _skip_picker_ww = False
    _skip_picker_co = False
    # Set when a pinned WW URL existed but its fetch failed; ensures carry-forward
    # fires even if fallback searches return non-empty-but-unmatched results.
    _had_pinned_ww = False

    if ww_url or coles_url:
        # Explicit URL refresh (workflow dispatch) — use the URL; no name-search fallback
        if ww_url and not coles_url:
            print(f"  Fetching WW by URL: {ww_url}")
            _ww = await fetch_ww_by_url(ww_page, ww_url)
            if not _ww: print(f"  WW URL fetch failed: {ww_url}")
            ww_results = [_ww] if _ww else []
            _skip_picker_ww = True
            coles_results = [existing_item["coles"]] if existing_item.get("coles") else []
            _skip_picker_co = True
        elif coles_url and not ww_url:
            print(f"  Fetching Coles by URL: {coles_url}")
            _co = await fetch_coles_by_url(coles_page, coles_url)
            if _co:
                coles_results = [_co]
                _skip_picker_co = True
            else:
                _fq = _coles_fallback_query(coles_url, item)
                print(f"  Coles URL fetch failed, searching by: {_fq!r}")
                coles_results = await search_with_retry(search_coles, coles_page, _fq)
            ww_results = [existing_item["woolworths"]] if existing_item.get("woolworths") else []
            _skip_picker_ww = True
        else:
            print(f"  Fetching WW by URL: {ww_url}")
            _ww = await fetch_ww_by_url(ww_page, ww_url)
            if not _ww: print(f"  WW URL fetch failed: {ww_url}")
            ww_results = [_ww] if _ww else []
            _skip_picker_ww = True
            print(f"  Fetching Coles by URL: {coles_url}")
            _co = await fetch_coles_by_url(coles_page, coles_url)
            if _co:
                coles_results = [_co]
                _skip_picker_co = True
            else:
                _fq = _coles_fallback_query(coles_url, item)
                print(f"  Coles URL fetch failed, searching by: {_fq!r}")
                coles_results = await search_with_retry(search_coles, coles_page, _fq)
    else:
        # Name-based search (normal scrape) — honour url_overrides.json if present
        overrides_path = os.path.join(DATA_DIR, "url_overrides.json")
        _url_ov: dict = {}
        if os.path.exists(overrides_path):
            try:
                with open(overrides_path) as _f:
                    _url_ov = json.load(_f)
            except Exception:
                pass
        pinned_ww  = _url_ov.get(item, {}).get("ww_url", "")
        pinned_co  = _url_ov.get(item, {}).get("coles_url", "")

        if pinned_ww or pinned_co:
            if pinned_ww:
                _had_pinned_ww = True
                _ww = await fetch_ww_by_url(ww_page, pinned_ww)
                if _ww:
                    ww_results = [_ww]
                    _skip_picker_ww = True
                else:
                    # WW blocks direct page access from GHA — fall back to name search
                    print(f"  WW pinned URL failed, falling back to name search")
                    ww_results = await search_with_retry(search_woolworths, ww_page, item)
                    # Prefer the result matching the stockcode in the pinned URL (avoids
                    # wrong-size matches when the item name has no size info)
                    _sc_m = re.search(r'/productdetails/(\d+)/([^/?]+)', pinned_ww)
                    if _sc_m:
                        _sc = _sc_m.group(1)
                        _sc_hit = next((r for r in ww_results if _sc in r.get('url', '')), None)
                        if _sc_hit:
                            print(f"  WW: matched by stockcode {_sc}")
                            ww_results = [_sc_hit]
                            _skip_picker_ww = True
                        else:
                            # Stockcode not in top-5 results — retry search using URL slug
                            _slug_q = _sc_m.group(2).replace('-', ' ').strip()
                            # Also derive a brand-prefix-stripped query (e.g. "woolworths chickpeas"
                            # → "chickpeas") to try if the slug is identical to the item name.
                            _slug_stripped = re.sub(r'^woolworths\s+', '', _slug_q, flags=re.IGNORECASE).strip()
                            _retry_q = _slug_q if _slug_q.lower() != item.lower() else (
                                _slug_stripped if _slug_stripped.lower() != item.lower() else ""
                            )
                            if _retry_q:
                                print(f"  WW: retrying with slug query: {_retry_q!r}")
                                _slug_res = await search_with_retry(search_woolworths, ww_page, _retry_q)
                                _sc_hit2 = next((r for r in _slug_res if _sc in r.get('url', '')), None)
                                if _sc_hit2:
                                    print(f"  WW: slug search found stockcode {_sc}")
                                    ww_results = [_sc_hit2]
                                    _skip_picker_ww = True
                                elif _slug_res:
                                    # Pinned stockcode not found — don't substitute a different product.
                                    # Clear results so carry-forward preserves the last known price.
                                    print(f"  WW: pinned stockcode {_sc} not in results — carrying forward")
                                    ww_results = []
                                    _skip_picker_ww = True
            else:
                ww_results = await search_with_retry(search_woolworths, ww_page, item)
            if pinned_co:
                _co = await fetch_coles_by_url(coles_page, pinned_co)
                if _co:
                    coles_results = [_co]
                    _skip_picker_co = True
                else:
                    # Coles product page failed — derive search query from URL slug
                    # (e.g. "coles-strawberries-250g-5191256" → "strawberries 250g")
                    _fq = _coles_fallback_query(pinned_co, item)
                    print(f"  Coles pinned URL failed, searching by: {_fq!r}")
                    coles_results = await search_with_retry(search_coles, coles_page, _fq)
                    if coles_results:
                        # Prefer exact slug match; otherwise trust the user's URL choice
                        # and use first result (skip the matcher — user already chose this product).
                        _slug_m = re.search(r'/product/([^/?]+)', pinned_co)
                        if _slug_m:
                            _pinned_slug = _slug_m.group(1)
                            _co_hit = next((r for r in coles_results if _pinned_slug in r.get('url', '')), None)
                            if _co_hit:
                                print(f"  Coles: matched by pinned slug")
                                coles_results = [_co_hit]
                            else:
                                print(f"  Coles: using top search result (pinned slug not in results)")
                        _skip_picker_co = True  # bypass matcher; user chose this product
            else:
                coles_results = await search_with_retry(search_coles, coles_page, item)
        else:
            ww_results, coles_results = await asyncio.gather(
                search_with_retry(search_woolworths, ww_page, item),
                search_with_retry(search_coles, coles_page, item),
            )
        await delay()

    # Pick best matching product from each result list
    if _skip_picker_ww:
        ww_match  = ww_results[0]  if ww_results  else None
        ww_conf   = 'high' if ww_match else 'none'
    else:
        ww_match, ww_conf = pick_best_match(item, ww_results)
        if ww_match:
            print(f"    WW match ({ww_conf}): {ww_match['name']}")

    if _skip_picker_co:
        coles_match = coles_results[0] if coles_results else None
        co_conf     = 'high' if coles_match else 'none'
    else:
        coles_match, co_conf = pick_best_match(item, coles_results)
        if coles_match:
            print(f"    Coles match ({co_conf}): {coles_match['name']}")

    # Carry forward existing store data when no fresh result is available.
    # Always carry forward when the matcher produced no usable result — whether because
    # the search returned nothing, the URL fetch failed, or the matcher rejected all
    # candidates. Losing existing price data is always worse than briefly keeping a
    # slightly stale match; the next successful scrape will correct it.
    def _carry(existing_key, conf_label, tag):
        existing = existing_item.get(existing_key)
        if existing and existing.get("price") is not None:
            print(f"    {tag}: keeping existing ${existing.get('price')} ({existing.get('name','?')})")
            return existing, conf_label
        return None, "none"

    if coles_match is None:
        coles_match, co_conf = _carry("coles", "carried", "Coles")

    if ww_match is None:
        ww_match, ww_conf = _carry("woolworths", "carried", "WW")

    if not ww_match and not coles_match:
        return None, True

    # Compute _ww_price_factor for per-kg items (used by UI for price_history normalisation).
    # WW sells loose produce (e.g. mushrooms) at $/kg; Coles sells fixed packs (e.g. 200g).
    # Store the factor so the UI can normalise price_history and trend bars accordingly.
    # The displayed WW price remains the actual shelf price (per-kg), not a sub-pack equivalent.
    _ww_price_factor = 1.0  # stored in JSON so buildPriceBar & isHotDeal can normalise price_history
    if ww_match and coles_match:
        _ww_unit = (ww_match.get("unit") or "").strip().upper()
        if _ww_unit in ("KG", "1KG"):
            _co_size_g = extract_weight_g(coles_match.get("name", ""))
            if _co_size_g and _co_size_g < 900:  # Coles pack < 900g → not a per-kg item
                _ww_price_factor = round(_co_size_g / 1000, 4)
                print(f"    WW per-kg price: ${ww_match['price']}, factor for {_co_size_g}g: {_ww_price_factor}")

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

    # "carried" is internal only; validate_pair uses the standard confidence vocabulary
    _vww = "low" if ww_conf == "carried" else ww_conf
    _vco = "low" if co_conf == "carried" else co_conf
    pair_meta = validate_pair(item, ww_match, coles_match, _vww, _vco)

    result = {
        "list_item": item,
        "last_scraped": datetime.now(timezone.utc).isoformat(),
        "trip_count": history.get("trip_count", 0),
        "price_history": history.get("price_history", []),
        "category": category,
        "woolworths": ww_match,
        "coles": coles_match,
        "cheaper_store": cheaper_store,
        "saving_per_item": saving,
        "alternatives": alternatives,
        **pair_meta,
    }
    if _ww_price_factor != 1.0:
        result["_ww_price_factor"] = _ww_price_factor
    return result, False


async def scrape(trigger: str = "scheduled", single_item: str = "", ww_url: str = "", coles_url: str = ""):
    purchase_history = get_purchase_history(EXCEL_PATH)

    # Load archived items list (written by UI via GitHub API)
    archived_path = os.path.join(DATA_DIR, "archived_items.json")
    archived_set: set[str] = set()
    if os.path.exists(archived_path):
        try:
            with open(archived_path) as _f:
                archived_set = set(json.load(_f))
        except Exception:
            pass

    if single_item:
        shopping_list = [single_item]
        print(f"Single-item refresh: {single_item}" + (f" [WW URL]" if ww_url else "") + (f" [Coles URL]" if coles_url else ""))
    elif trigger == "scrape_archived":
        shopping_list = sorted(archived_set)
        print(f"Archived-only scrape: {len(shopping_list)} items")
    else:
        def _priority_key(name):
            trips = purchase_history.get(name, {}).get("trip_count", 0)
            return 0 if trips >= 7 else (1 if trips >= 3 else 2)
        # Exclude archived items from normal scrapes
        shopping_list = sorted(
            [n for n in purchase_history.keys() if n not in archived_set],
            key=_priority_key,
        )
        print(f"Active shopping list: {len(shopping_list)} items (excluding {len(archived_set)} archived)")

    detect_fuzzy_changes(shopping_list, FLAG_PATH)

    latest_path = os.path.join(DATA_DIR, "latest.json")
    existing_data = {}
    if os.path.exists(latest_path):
        with open(latest_path) as f:
            existing_data = json.load(f)
    existing_map = {i["list_item"]: i for i in existing_data.get("items", [])}

    items_output = []
    not_found = []

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
        context.set_default_navigation_timeout(PAGE_TIMEOUT_MS)
        context.set_default_timeout(PAGE_TIMEOUT_MS)

        if single_item:
            # Single-item: one page-pair, sequential
            ww_page = await context.new_page()
            coles_page = await context.new_page()
            need_ww = not (coles_url and not ww_url)
            need_coles = not (ww_url and not coles_url)
            if need_ww:
                await ww_page.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                await delay()
            if need_coles:
                await coles_page.goto(COLES_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                await delay()

            result, is_nf = await _scrape_single_item(
                single_item, purchase_history, ww_page, coles_page,
                ww_url, coles_url, existing_data,
            )
            if result:
                items_output.append(result)
            else:
                not_found.append(single_item)

        else:
            # Full scrape: determine which items need re-scraping
            fresh_items = []
            to_scrape = []
            for name in shopping_list:
                ex = existing_map.get(name)
                if should_skip_item(ex, trigger):
                    # Carry forward existing data
                    fresh_items.append(ex)
                else:
                    to_scrape.append(name)

            items_output.extend(fresh_items)
            total_all = len(shopping_list)
            total_to_scrape = len(to_scrape)
            skipped = len(fresh_items)
            if skipped:
                print(f"Skipping {skipped} recently-scraped items. Scraping {total_to_scrape} items.")

            # Create page pools (CONCURRENCY page-pairs)
            ww_pool: asyncio.Queue = asyncio.Queue()
            co_pool: asyncio.Queue = asyncio.Queue()
            for _ in range(CONCURRENCY):
                p = await context.new_page()
                await p.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                await ww_pool.put(p)
                p = await context.new_page()
                await p.goto(COLES_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                await co_pool.put(p)

            sem = asyncio.Semaphore(CONCURRENCY)
            completed = [0]

            async def scrape_one(name: str):
                async with sem:
                    ww_page = await ww_pool.get()
                    co_page = await co_pool.get()
                    timed_out = False
                    try:
                        idx = completed[0] + 1
                        print(f"[{idx}/{total_to_scrape}] {name}")
                        result, is_nf = await asyncio.wait_for(
                            _scrape_single_item(
                                name, purchase_history, ww_page, co_page, "", "", existing_data,
                            ),
                            timeout=120,
                        )
                        if result:
                            items_output.append(result)
                        else:
                            not_found.append(name)
                    except asyncio.TimeoutError:
                        print(f"  [TIMEOUT] {name} exceeded 120s — skipping")
                        not_found.append(name)
                        timed_out = True
                    except Exception as e:
                        print(f"  Error scraping {name}: {e}")
                        not_found.append(name)   # keep item visible; final pass will carry forward
                    finally:
                        completed[0] += 1
                        if completed[0] % 5 == 0:
                            push_progress_bg(
                                items_output, not_found,
                                len(items_output) + len(not_found) + skipped,
                                total_all, trigger,
                                existing_items=list(existing_map.values()),
                            )
                        if timed_out:
                            # Reset pages after mid-navigation cancellation
                            for _p, _base in [(ww_page, WOOLWORTHS_BASE), (co_page, COLES_BASE)]:
                                try:
                                    await _p.goto(_base, wait_until="commit", timeout=5000)
                                except Exception:
                                    pass
                        await ww_pool.put(ww_page)
                        await co_pool.put(co_page)

            await asyncio.gather(*[scrape_one(name) for name in to_scrape])

        await browser.close()

    os.makedirs(DATA_DIR, exist_ok=True)

    if not single_item:
        # Final carry-forward: for any item that failed scraping (in not_found) but has
        # existing data, restore it into items_output so it isn't lost from the JSON.
        # This mirrors the push_progress_bg carry-forward but for the final write.
        scraped_names = {i["list_item"] for i in items_output}
        still_not_found = []
        for name in not_found:
            ex = existing_map.get(name)
            if ex and (ex.get("woolworths", {}) or {}).get("price") is not None \
                   or ex and (ex.get("coles", {}) or {}).get("price") is not None:
                print(f"  [carry-forward] Restoring existing data for failed item: {name}")
                items_output.append(ex)
            else:
                still_not_found.append(name)
        not_found = still_not_found

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
