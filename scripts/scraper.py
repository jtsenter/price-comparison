import asyncio
import base64
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, date, timedelta
from urllib.parse import quote, urlparse, parse_qs, unquote

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(__file__))
from categories import guess_category
from matcher import pick_best_match, validate_pair, extract_weight_g
from shopping_list import detect_fuzzy_changes, get_purchase_history, clean_name

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
                # CDN-relative path (e.g. /4/409499.jpg) -> prefix with CDN base
                if decoded.startswith("/") and "://" not in decoded:
                    return COLES_CDN + decoded
                return decoded
        except Exception:
            pass
    # Bare CDN path stored from a previous scrape (e.g. /4/409499.jpg)
    if img.startswith("/") and "://" not in img:
        return COLES_CDN + img
    return img
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "docs", "data")
FLAG_PATH = os.path.join(DATA_DIR, "name_changes_detected.json")
EXCEL_PATH = os.path.join(os.path.dirname(__file__), "..", "shopping_list.xlsx")

# ── Tunable constants ────────────────────────────────────────────────────────
PAGE_TIMEOUT_MS      = 20_000   # page.goto timeout
COLES_WAIT_MS        = 1_100    # post-navigation wait for Coles pages
COLES_SCROLL_WAIT_MS = 600      # post-scroll wait for lazy-loaded tiles
MAX_PRODUCT_PRICE    = 80.0     # ceiling used by COLES_PRODUCT_PAGE_JS's DOM-selector fallback
                                 # to reject unrelated on-page dollar figures (e.g. "spend $100,
                                 # save $X" promo text). Only the last-resort strategy - real
                                 # grocery items rarely exceed $50, but bulk packs/multipacks
                                 # legitimately can, so this was previously hardcoded lower (50)
                                 # and could silently drop a genuine price on that fallback path.
CONCURRENCY          = 2        # parallel page-pairs (don't exceed 3)
MAX_RESULTS          = 5        # search results fetched per store
ARCHIVED_REFRESH_DAYS = 7       # scheduled runs refresh archived items only if older than this (else carried forward)
SKIP_FRESH_HOURS     = 12       # scheduled runs skip items scraped within this window (a manual
                                # run minutes earlier otherwise gets fully re-scraped - double the
                                # request volume, which is what trips Coles's mid-run rate ban)
SUSPICIOUS_CHANGE_PCT   = 0.30  # flag if price changed by more than this fraction
SUSPICIOUS_MIN_HISTORY  = 3     # minimum price_history entries to run suspicion check
SCRAPE_LOG_MAX          = 30    # scrape-log runs kept in docs/data/scrape_log.json

_ww_debug_done = False
# Per-store fresh misses for the in-progress run: [(item, ww_missed, co_missed)].
# Reset at the start of each full run; read after it to write the scrape log.
_run_store_misses: list = []
# [writer, already_checkpointed] - lets the per-item loop write a provisional
# scrape-log entry at ~95% without threading the writer through every call.
_log_checkpoint: list = [None, False]


def _append_price_changes(trigger: str, ww_changes: list, coles_changes: list) -> None:
    """Append this run's per-store price movements to price_changes.json.
    UNCAPPED (unlike scrape_log.json, which keeps only SCRAPE_LOG_MAX runs): this
    is a permanent archive for studying each supermarket's pricing strategy over
    months. One entry per run: {date, trigger, ww:[{item,old,new}], coles:[...]}.

    EVERY run is recorded, including ones that moved nothing (empty ww/coles). A
    run where no price budged is itself a data point - "Coles held everything for
    three weeks" is only visible if the quiet runs are on the record too. Skipping
    them made a flat stretch indistinguishable from a stretch that never ran."""
    path = os.path.join(DATA_DIR, "price_changes.json")
    log = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                log = json.load(f)
        except Exception:
            log = []
    log.append({
        "date": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
        "ww": ww_changes,
        "coles": coles_changes,
    })
    with open(path, "w", encoding="utf-8") as f:
        json.dump(log, f, separators=(",", ":"))


def _append_scrape_log(trigger: str, scraped: int, ww_missed: list, coles_missed: list,
                       ww_attempted: int | None = None, coles_attempted: int | None = None,
                       partial: bool = False, duration_s: float | None = None,
                       duration_p90_s: float | None = None, archived: int | None = None) -> None:
    """Append one run's per-store miss summary to docs/data/scrape_log.json (capped).
    ww_missed/coles_missed: [{"item": str, "reason": "no_results"|"no_match"}, ...].
    ww_attempted/coles_attempted: how many items were actually TRIED at each store.
    Single-store-pinned items deliberately skip the other store ("a single-store pin
    means a single store") - counting those as misses made the success rates lie
    (WW showed 76% when its real rate was 85%). The UI divides by attempted.
    Lets the UI (scrape-log.html) show miss rates over time and which products get
    skipped most, and whether misses are a block/selector break (no_results) or a
    matcher/naming problem (no_match)."""
    path = os.path.join(DATA_DIR, "scrape_log.json")
    log = []
    if os.path.exists(path):
        try:
            with open(path) as f:
                log = json.load(f)
        except Exception:
            log = []
    entry = {
        "date": datetime.now(timezone.utc).isoformat(),
        "trigger": trigger,
        "scraped": scraped,
        "ww_missed": ww_missed,
        "coles_missed": coles_missed,
    }
    if ww_attempted is not None:
        entry["ww_attempted"] = ww_attempted
    if coles_attempted is not None:
        entry["coles_attempted"] = coles_attempted
    if archived is not None:
        entry["archived"] = archived
    # How long the run took, so "how long would 1000 products take?" is answerable
    # from data instead of guesswork. duration_p90_s is the same clock stopped at
    # 90% of items: if the two are close the run finishes evenly, and if p90 is far
    # short of the total then the tail really is where the time goes. Recorded from
    # this run onward - older entries simply have no duration and the UI skips them.
    if duration_s is not None:
        entry["duration_s"] = round(duration_s, 1)
    if duration_p90_s is not None:
        entry["duration_p90_s"] = round(duration_p90_s, 1)
    # Price movements deliberately do NOT live here any more - they go to the
    # uncapped price_changes.json via _append_price_changes(). (This function used
    # to take ww_changes/coles_changes; when those params were dropped the body
    # kept referencing them, so every full run died with NameError at the very
    # last step - after all 284 items had been scraped - and the workflow's commit
    # step, being skipped on failure, threw the whole run away. Four runs lost.)
    #
    # A run writes a PROVISIONAL entry at ~95% and its real one at the end. The
    # provisional is popped here so a run leaves exactly one entry either way -
    # but if the tail dies, that 95% entry survives as the record of the run
    # instead of the scrape vanishing from history entirely.
    if log and log[-1].get("partial"):
        log.pop()
    if partial:
        entry["partial"] = True
    log.append(entry)
    log = log[-SCRAPE_LOG_MAX:]
    with open(path, "w") as f:
        json.dump(log, f, separators=(",", ":"))


def _iso_week(d) -> tuple[int, int]:
    if isinstance(d, str):
        d = date.fromisoformat(d[:10])
    ic = d.isocalendar()
    return ic[0], ic[1]


def _dedup_hist(history: list) -> list:
    """Remove duplicate date entries from a price history list, keeping the last per date.
    Returns entries sorted oldest-first so history[-1] is always the most recent."""
    seen: dict = {}
    for e in history:
        d = e.get("date", "")
        if d:
            seen[d] = e  # last entry wins (matches scraper's own write order)
    return sorted(seen.values(), key=lambda e: e.get("date", ""))


def _week_dedup(history: list, new_price: float) -> str:
    today_week = _iso_week(date.today())
    for entry in history:
        if _iso_week(entry['date']) == today_week:
            return 'skip' if round(entry['price'], 2) == round(new_price, 2) else 'update'
    return 'append'


def _product_key(url: str) -> str:
    """Stable identity for a product URL, robust to query params / trailing slashes.
    WW: the stockcode in /productdetails/<id>/. Coles: the trailing numeric id.
    Falls back to the full URL when no id is found."""
    if not url:
        return ""
    m = re.search(r'/productdetails/(\d+)', url)        # Woolworths
    if m:
        return f"ww:{m.group(1)}"
    m = re.search(r'-(\d+)(?:[/?#]|$)', url)             # Coles slug ...-<id>
    if m:
        return f"co:{m.group(1)}"
    return url.split('?')[0].rstrip('/')


def _load_rejected_urls() -> dict:
    """Load the per-item rejected-product map written by the UI's 'Different item' flow.
    Shape: { "<item>": { "ww": ["url", ...], "coles": ["url", ...] } }"""
    path = os.path.join(DATA_DIR, "rejected_urls.json")
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _should_add_history_entry(history: list, new_price: float, today: str) -> bool:
    """Return True if a new price history entry should be appended.

    Rules (applies to all scrape triggers - manual and scheduled):
    - No history yet                           -> add.
    - Price changed vs last entry              -> add (always, regardless of age).
    - Price unchanged, last entry < 7 days ago -> skip.
    - Price unchanged, last entry ≥ 7 days ago -> add (confirms price still valid).
    """
    if not history:
        return True
    last = history[-1]
    last_price = last.get('price')
    last_date  = last.get('date', '')
    if round(float(last_price), 2) != round(float(new_price), 2):
        return True   # price changed - always record
    try:
        days_since = (date.fromisoformat(today) - date.fromisoformat(last_date[:10])).days
        return days_since >= 7
    except Exception:
        return True   # date parsing failed - add to be safe


def _miss_reason(match: dict | None, results: list) -> str | None:
    """Classify why a store fetch/match failed for the scrape log.
    None = matched. "no_results" = search/fetch returned nothing - points at a
    block or a broken page selector. "no_match" = got candidates but none scored
    well enough - points at a naming/matcher problem instead. The distinction
    matters: no_results across nearly every item means the SITE is blocking or its
    markup changed; no_match spread across items means the matcher needs tuning."""
    if match is not None:
        return None
    return 'no_results' if not results else 'no_match'


def _is_approved(price: float | None, approved_price: float | None, tolerance: float = 0.05) -> bool:
    """Return True if price is within tolerance of the previously-approved price."""
    if approved_price is None or price is None:
        return False
    return abs(price - approved_price) / max(abs(approved_price), 0.01) <= tolerance


def _suspicious_drop(new_price, prev_price, hist_prices, pct_threshold: float = 0.20) -> bool:
    """Return True only if new price drops >20% from previous AND sets a new historical low.
    Normal price fluctuations within historical range are always allowed.
    """
    if new_price is None or prev_price is None or prev_price <= 0:
        return False
    if not hist_prices:
        return False
    hist_min = min(p for p in hist_prices if p > 0)
    drop_pct = (prev_price - new_price) / prev_price
    if drop_pct > pct_threshold and new_price < hist_min:
        print(f"    [WARN] Suspicious drop: ${prev_price} -> ${new_price} ({drop_pct*100:.0f}% drop, below hist min ${hist_min})")
        return True
    return False


def _suspicious_reasons(new_price, prev_price, price_history) -> list[str]:
    if new_price is None or new_price <= 0:
        return []
    hist_prices = [e['price'] for e in price_history if e.get('price', 0) > 0]
    if len(hist_prices) < SUSPICIOUS_MIN_HISTORY:
        return []
    reasons = []

    # >20% drop AND new all-time low -> likely EDR/member price
    if _suspicious_drop(new_price, prev_price, hist_prices, 0.20):
        reasons.append('suspicious_drop_gt20pct')

    # Existing: 30% change in either direction
    if prev_price is not None and prev_price > 0:
        if abs(new_price - prev_price) / prev_price > SUSPICIOUS_CHANGE_PCT:
            reasons.append('30pct_change')

    # Existing: outside historical range
    hist_min, hist_max = min(hist_prices), max(hist_prices)
    if new_price < hist_min or new_price > hist_max:
        reasons.append('outside_historical_range')

    return reasons


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_price(text: str) -> float | None:
    if not text:
        return None
    m = re.search(r"\$\s*(\d[\d,]*(?:\.\d+)?)", text)
    if not m:
        return None
    raw = float(m.group(1).replace(",", ""))
    return round(raw, 2)  # round $2.398 -> $2.40, $1.295 -> $1.30


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
# Woolworths - blocked by 403 from GitHub Actions IPs; kept for local use
# ---------------------------------------------------------------------------

def _ww_pack_price(cup_price, product_unit, package_size):
    """WW prices some fresh items per kg (Unit='KG') but sells a fixed portion shown as
    'per 200g'. Return the portion shelf price (e.g. $38/kg × 200g = $7.60) for DISPLAY
    only - the per-kg CupPrice stays the canonical `price`, so price history and the
    $/kg comparison remain in $/kg and don't cliff when a portion price is shown.

    Returns None when not a fixed per-kg portion: non-KG units, or by-weight produce
    whose PackageSize is 'Approx. 180g' rather than the explicit 'per <N>g' pattern.
    """
    if cup_price is None:
        return None
    if (product_unit or "").strip().upper() not in ("KG", "1KG"):
        return None
    m = re.search(r'per\s*(\d+(?:\.\d+)?)\s*g\b', package_size or "", re.IGNORECASE)
    if m:
        grams = float(m.group(1))
        if grams > 0:
            return round(float(cup_price) * grams / 1000, 2)
    return None


def _ww_multi_buy(p: dict) -> dict | None:
    """Woolworths multi-buy promo ("2 for $7.00"), or None.

    WW hangs it off the product's tag payload as MultibuyData {Quantity, Price},
    where Price is the TOTAL for that quantity. That is NOT the same shape as
    Coles' multiBuyPromotion, whose `reward` is PER UNIT and has to be multiplied
    by minQuantity - do not "unify" the two, they mean different things.

    Free to collect: this rides on the search/product payload the scraper already
    downloads for name and price, so it adds no request and no scrape time.
    Which tag slot carries it varies by product, hence the sweep.
    """
    for slot in ("CentreTag", "HeaderTag", "ImageTag", "FooterTag"):
        tag = p.get(slot)
        mb = tag.get("MultibuyData") if isinstance(tag, dict) else None
        if not isinstance(mb, dict):
            continue
        qty, total = mb.get("Quantity"), mb.get("Price")
        try:
            if qty and total and int(qty) > 1 and float(total) > 0:
                return {"qty": int(qty), "total": round(float(total), 2)}
        except (TypeError, ValueError):
            continue
    return None


def _parse_ww_products(product_list: list) -> list[dict]:
    results = []
    for p in product_list:
        stockcode = p.get("Stockcode")
        url_name = p.get("UrlFriendlyName", "")
        name = p.get("Name", "")
        price = p.get("Price")
        was_price = p.get("WasPrice")
        cup_price = p.get("CupPrice")
        cup_string = p.get("CupString", "")
        if not name or price is None:
            continue
        # Distinguish a MEMBER-EXCLUSIVE price (Everyday Rewards / Prices Member -
        # revert to the public WasPrice) from a PUBLIC special (IsOnSpecial, no
        # member flag - everyone pays the lower Price, so KEEP it). The old code
        # took WasPrice whenever WasPrice > Price "regardless of the EDR flag",
        # which inflated every public special to its struck-through was price
        # (Mix Max scraped at $7.70 when the public special was $5.80). Use the
        # same reliable flags the pinned-URL path uses: IsEdrSpecial/IsPmDelivery.
        # (IsEveryDayRewards/IsPmDeals come back null on the search API.)
        is_member_deal = bool(p.get("IsEdrSpecial") or p.get("IsPmDelivery")
                              or p.get("IsEveryDayRewards") or p.get("IsPmDeals"))
        if was_price is not None and float(was_price) > float(price) and is_member_deal:
            print(f"    [WW] Member price for '{name}': ${price} -> public shelf ${was_price}")
            price = was_price
        product_url = (
            f"{WOOLWORTHS_BASE}/shop/productdetails/{stockcode}/{url_name}"
            if stockcode else ""
        )
        _, unit = parse_unit_price(cup_string)
        # Per-kg-priced fixed portion ("per 200g"): keep price = per-kg (CupPrice) so
        # history/$/kg stay consistent; expose the portion shelf price separately.
        _pack = _ww_pack_price(cup_price, p.get("Unit"), p.get("PackageSize"))
        if _pack is not None:
            price = float(cup_price)
        entry = {
            "name": name,
            "price": float(price),
            "unit_price": float(cup_price) if cup_price is not None else None,
            "unit": unit,
            "url": product_url,
            "image_url": p.get("LargeImageFile") or p.get("MediumImageFile") or "",
        }
        if _pack is not None:
            entry["pack_price"] = _pack
        _mb = _ww_multi_buy(p)
        if _mb:
            entry["multi_buy"] = _mb
        results.append(entry)
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
    # An empty result is usually a transient miss (timeout, bot challenge, a slow
    # SSR payload) rather than "product doesn't exist". One retry recovers a large
    # share of those gaps. search_fn does a full page.goto, so the retry already
    # navigates a fresh DOM - a brand-new page object would share the context's
    # cookies and shed nothing extra.
    # ponytail: same-page re-navigation, not a fresh browser context. Ceiling - if a
    # store hard-bans the runner cookie/IP for a whole run, every item still retries
    # and wastes ~backoff each; upgrade path is a new context on repeated misses.
    for attempt in range(retries + 1):
        results = await search_fn(page, query)
        if results:
            return results
        if attempt < retries:
            backoff = random.uniform(2.5, 4.0)
            print(f"    No results for '{query}', retrying in {backoff:.0f}s…")
            await asyncio.sleep(backoff)
    return []


async def search_woolworths(page, query: str) -> list[dict]:
    global _ww_debug_done
    url = f"{WOOLWORTHS_BASE}/shop/search/products?searchTerm={quote(query)}"
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        await page.wait_for_timeout(450)

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
        await page.wait_for_timeout(600)
        next_data = await page.evaluate("""
            () => {
                const el = document.getElementById('__NEXT_DATA__');
                if (!el) return null;
                try { return JSON.parse(el.textContent); } catch { return null; }
            }
        """)
        if next_data:
            pp = next_data.get("props", {}).get("pageProps", {})
            product = pp.get("pdDetails", {}).get("Product")
            if product:
                name = product.get("Name", "")
                price = product.get("Price")
                was_price = product.get("WasPrice")
                cup_price = product.get("CupPrice")
                cup_string = product.get("CupString", "")
                stockcode = product.get("Stockcode")
                url_name = product.get("UrlFriendlyName", "")
                is_edr = bool(product.get("IsEdrSpecial"))
                is_pm = bool(product.get("IsPmDelivery"))
                on_special = bool(product.get("IsOnSpecial"))
                print(f"    [WW URL] {name!r}: Price=${price} WasPrice={was_price} IsEdr={is_edr} IsPm={is_pm}")

                # GATE: only override Price->WasPrice if this is a MEMBER-EXCLUSIVE price
                # PUBLIC specials (IsEdrSpecial=false, IsPmDelivery=false) keep their Price intact
                if was_price is not None and float(was_price) > float(price):
                    if is_edr or is_pm:
                        print(f"    [WW] Member price detected: ${price} -> shelf price ${was_price}")
                        price = was_price
                    else:
                        print(f"    [WW] Public special: keeping ${price} (was ${was_price})")
                # DOM price check: collect prices from shelf-price-specific selectors,
                # avoiding member-exclusive elements. Shelf price is always ≥ member price.
                # Selector priority:
                #   1. [data-testid="product-regular-price"] (explicit shelf price)
                #   2. [class*="regular"][class*="price"] (contains "regular" + "price")
                #   3. Any price NOT inside [class*="member"], [class*="reward"], [class*="loyalty"]
                #   4. Fallback: all prices, use max
                # BUT skip it entirely on a confirmed PUBLIC special: __NEXT_DATA__'s
                # Price is the real current price, and the page also shows a HIGHER
                # struck-through "Was" price - the "use max" heuristic would grab that
                # and hide the special (same bug as the search path had).
                public_special = on_special and not (is_edr or is_pm)
                if price is not None and not public_special:
                    _dom_prices = await page.evaluate("""
                        () => {
                            const priceRe = /^\\$\\s*([\\d]+\\.[\\d]{2})$/;
                            const rangeOk = p => p >= 0.5 && p <= 50;
                            const found = [];

                            // 1. Explicit non-member price element: [data-testid="product-regular-price"]
                            const regEl = document.querySelector('[data-testid="product-regular-price"]');
                            if (regEl?.textContent) {
                                const m = regEl.textContent.match(/\\$\\s*([\\d.]+)/);
                                if (m) {
                                    const p = parseFloat(m[1]);
                                    if (rangeOk(p)) found.push({ p, src: 'data-testid-regular-price' });
                                }
                            }
                            if (found.length > 0) return found; // High-confidence result

                            // 2a. Any [data-testid*="price"] element (catches split-text renders like $<span>5.30</span>)
                            // Uses element.textContent which concatenates all child text nodes.
                            const notMember = el => {
                                let p = el;
                                for (let i = 0; i < 8 && p; i++) {
                                    const c = (typeof p.className === 'string' ? p.className : (p.className?.toString() || '')).toLowerCase();
                                    if (c.includes('member') || c.includes('reward') || c.includes('loyalty')) return false;
                                    p = p.parentElement;
                                }
                                return true;
                            };
                            for (const el of document.querySelectorAll('[data-testid*="price"]')) {
                                if (!notMember(el)) continue;
                                const t = (el.textContent || '').replace(/\\s+/g, '').replace(',', '.');
                                const m = t.match(/\\$([\\d]+\\.[\\d]{2})/);
                                if (m) {
                                    const p = parseFloat(m[1]);
                                    if (rangeOk(p)) found.push({ p, src: 'data-testid-price' });
                                }
                            }
                            if (found.length > 0) return found;

                            // 2b. Class-based: [class*="regular"][class*="price"] (case-insensitive contains)
                            const allEls = document.querySelectorAll('*');
                            for (const el of allEls) {
                                const cls = (typeof el.className === 'string' ? el.className : (el.className?.toString() || '')).toLowerCase();
                                if (cls.includes('regular') && cls.includes('price')) {
                                    const t = el.textContent?.trim();
                                    const m = t?.match(/\\$\\s*([\\d.]+)/);
                                    if (m) {
                                        const p = parseFloat(m[1]);
                                        if (rangeOk(p)) found.push({ p, src: 'class-regular-price' });
                                    }
                                }
                            }
                            if (found.length > 0) return found; // Good result

                            // 3. Any price NOT inside [class*="member"], [class*="reward"], [class*="loyalty"]
                            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                            let node;
                            while ((node = walker.nextNode())) {
                                const t = node.textContent.trim();
                                const m = t.match(priceRe);
                                if (m) {
                                    // Check if this node is inside a member/reward/loyalty container
                                    let parent = node.parentElement;
                                    let inMemberEl = false;
                                    for (let i = 0; i < 10 && parent; i++) {
                                        const pc = (typeof parent.className === 'string' ? parent.className : (parent.className?.toString() || '')).toLowerCase();
                                        if (pc.includes('member') || pc.includes('reward') || pc.includes('loyalty')) {
                                            inMemberEl = true;
                                            break;
                                        }
                                        parent = parent.parentElement;
                                    }
                                    if (!inMemberEl) {
                                        const p = parseFloat(m[1]);
                                        if (rangeOk(p)) found.push({ p, src: 'non-member-text' });
                                    }
                                }
                            }
                            if (found.length > 0) return found; // Filtered result

                            // 4. Fallback: all prices (including member prices)
                            const walkerAll = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                            let nodeAll;
                            while ((nodeAll = walkerAll.nextNode())) {
                                const t = nodeAll.textContent.trim();
                                const m = t.match(priceRe);
                                if (m) {
                                    const p = parseFloat(m[1]);
                                    if (rangeOk(p)) found.push({ p, src: 'fallback-all-text' });
                                }
                            }
                            return found;
                        }
                    """)
                    if _dom_prices:
                        _dom_vals = [e['p'] for e in _dom_prices]
                        _dom_max  = max(_dom_vals)
                        _sources = set(e['src'] for e in _dom_prices)
                        if len(_dom_vals) >= 2:
                            print(f"    [WW] DOM prices found: {_dom_vals} (sources: {_sources}) - using highest ${_dom_max} (shelf > member)")
                        else:
                            print(f"    [WW] DOM price: ${_dom_vals[0]} (source: {list(_sources)[0]})")
                        if abs(_dom_max - float(price)) > 0.005:
                            print(f"    [WW] DOM overrides __NEXT_DATA__ ${price} -> ${_dom_max}")
                            price = _dom_max
                    else:
                        print(f"    [WW] DOM found no price elements - keeping __NEXT_DATA__ ${price}")
                if name and price is not None:
                    _, unit = parse_unit_price(cup_string)
                    # Per-kg-priced fixed portion ("per 200g"): keep price = per-kg
                    # (CupPrice, reliable) so history/$/kg stay consistent even though the
                    # DOM step may have grabbed the portion figure; expose portion shelf
                    # price separately for display.
                    pack_price = _ww_pack_price(cup_price, product.get("Unit"), product.get("PackageSize"))
                    if pack_price is not None:
                        price = float(cup_price)
                        print(f"    [WW] per-kg portion '{product.get('PackageSize')}': price/kg=${price}, shelf=${pack_price}")
                    product_url = (
                        f"{WOOLWORTHS_BASE}/shop/productdetails/{stockcode}/{url_name}"
                        if stockcode else url
                    )
                    out = {
                        "name": name,
                        "price": float(price),
                        "unit_price": float(cup_price) if cup_price is not None else None,
                        "unit": unit,
                        "url": product_url,
                        "image_url": product.get("LargeImageFile") or product.get("MediumImageFile") or "",
                        "is_on_special": on_special,  # True=public special, False=member price
                    }
                    if pack_price is not None:
                        out["pack_price"] = pack_price
                    _mb = _ww_multi_buy(product)
                    if _mb:
                        out["multi_buy"] = _mb
                    return out
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

    // Multi-buy specials ("Any 2 $6"): read the search page's own __NEXT_DATA__
    // (JSON, not affected by CSS changes) rather than scraping the promo text -
    // pricing.multiBuyPromotion.{minQuantity,reward} gives an exact total
    // (minQuantity x reward = the deal price). Matched to tiles BY INDEX: both
    // the DOM tiles and this results array reflect the same on-page order.
    // ponytail: an index mismatch (e.g. a sponsored tile reordering) silently
    // drops that one tile's multi-buy badge - harmless, price fields are unaffected.
    let multiBuyByIndex = [];
    try {
        const nd = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
        const results = nd?.props?.pageProps?.searchResults?.results || [];
        multiBuyByIndex = results.map(r => {
            const mb = r?.pricing?.multiBuyPromotion;
            if (!mb || !mb.minQuantity || !mb.reward) return null;
            return { qty: mb.minQuantity, total: Math.round(mb.minQuantity * mb.reward * 100) / 100 };
        });
    } catch {}

    return tiles.slice(0, 5).map((tile, i) => {
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

        // Get product image - try src first, then data-src for lazy-loaded images
        let imageUrl = '';
        const imgEl = tile.querySelector('img');
        if (imgEl) {
            const src = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
            // Skip tiny base64 placeholders
            if (src && !src.startsWith('data:') && src.length > 20) imageUrl = src;
        }

        return { name, price_text: priceText, unit_price_text: unitPriceText,
                 url: linkEl?.getAttribute('href') || '', image_url: imageUrl,
                 multi_buy: multiBuyByIndex[i] || null };
    }).filter(p => p.name);
}
"""


# One Coles request in flight at a time. Coles rate-bans mid-run when hammered
# (2026-07-06: a manual run got 14 items then 0 for the rest; the scheduled run
# 18 min later got 0/208 - and the ban outlived both runs) while WW tolerates
# CONCURRENCY page-pairs fine - so only Coles serialises, plus jitter between
# requests. A banned session gets served completely EMPTY pages (no title, no
# body - verified live), so consecutive hard failures are the ban signal.
_COLES_SEM = asyncio.Semaphore(1)

# Circuit breaker: after COLES_BAN_THRESHOLD consecutive failures, pause ALL
# Coles traffic once (the soft ban sometimes lifts in minutes); if the ban
# persists through the cooldowns, stop hitting Coles for the rest of the run -
# further requests only extend the ban, and carry-forward keeps the data whole.
COLES_BAN_THRESHOLD  = 8
COLES_BAN_COOLDOWN_S = 120
_coles_fails = 0
_coles_cooldowns_left = 2
_coles_dead = False

async def _register_coles_result(ok: bool) -> None:
    """Track consecutive Coles failures; cool down / trip the breaker on a ban.
    Called while holding _COLES_SEM, so the cooldown pauses ALL Coles traffic."""
    global _coles_fails, _coles_cooldowns_left, _coles_dead
    if ok:
        _coles_fails = 0
        return
    _coles_fails += 1
    if _coles_fails < COLES_BAN_THRESHOLD:
        return
    if _coles_cooldowns_left > 0:
        _coles_cooldowns_left -= 1
        print(f"  [Coles] {_coles_fails} consecutive failures - likely rate ban; "
              f"pausing all Coles requests {COLES_BAN_COOLDOWN_S}s "
              f"({_coles_cooldowns_left} cooldown(s) left)…")
        await asyncio.sleep(COLES_BAN_COOLDOWN_S)
        _coles_fails = 0
    else:
        _coles_dead = True
        print("  [Coles] Ban persisted through cooldowns - skipping Coles for the "
              "rest of this run; last-known prices carry forward.")

async def search_coles(page, query: str) -> list[dict]:
    if _coles_dead:
        return []
    url = f"{COLES_BASE}/search?q={quote(query)}"
    try:
      async with _COLES_SEM:
        await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
        await page.wait_for_timeout(COLES_WAIT_MS)
        await page.evaluate("window.scrollBy(0, 300)")
        await page.wait_for_timeout(COLES_SCROLL_WAIT_MS)
        raw = await page.evaluate(COLES_EXTRACT_JS)
        await _register_coles_result(bool(raw))
        await asyncio.sleep(random.uniform(0.5, 1.5))
        results = []
        for r in raw:
            price = parse_price(r["price_text"])
            unit_price, unit = parse_unit_price(r["unit_price_text"])
            entry = {
                "name": r["name"],
                "price": price,
                "unit_price": unit_price,
                "unit": unit,
                "url": resolve_url(r["url"], COLES_BASE),
                "image_url": _normalise_coles_img(r.get("image_url", "")),
            }
            if r.get("multi_buy"):
                entry["multi_buy"] = r["multi_buy"]
            results.append(entry)
        return results
    except Exception as e:
        print(f"  [Coles] Error searching '{query}': {e}")
        await _register_coles_result(False)  # timeouts on banned pages count toward the breaker
        return []


COLES_PRODUCT_PAGE_JS = """
() => {
    // Strategy 1: __NEXT_DATA__ (Next.js SSR - most reliable, not affected by CSS changes)
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
                    // Multi-buy special ("Any 2 $6"): minQuantity x reward = the deal total.
                    const mb = pricing?.multiBuyPromotion;
                    const multiBuy = (mb && mb.minQuantity && mb.reward)
                        ? { qty: mb.minQuantity, total: Math.round(mb.minQuantity * mb.reward * 100) / 100 } : null;
                    return { name, price_text: '$' + price, unit_price_text: comparable, image_url: img, multi_buy: multiBuy };
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
                if (v > 0 && v < __MAX_PRODUCT_PRICE__ && v < bestPrice) { bestPrice = v; priceText = t; }
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


def _coles_product_page_js() -> str:
    """COLES_PRODUCT_PAGE_JS with MAX_PRODUCT_PRICE substituted in - a plain
    .replace() rather than an f-string/`.format()` because the JS body is full of
    literal `{`/`}` braces that would otherwise need escaping throughout."""
    return COLES_PRODUCT_PAGE_JS.replace('__MAX_PRODUCT_PRICE__', str(MAX_PRODUCT_PRICE))


_COLES_BOT_KEYWORDS = ('interruption', 'captcha', 'access denied', 'challenge', 'verify')

async def fetch_coles_by_url(page, url: str) -> dict | None:
    """Fetch a single Coles product directly by URL (faster than search).
    Retries once after a 3-second delay if bot detection is hit (Incapsula
    'Pardon Our Interruption' page) or the execution context is destroyed by
    a mid-evaluation redirect triggered by Coles's challenge system.
    """
    if url and not url.startswith("http"):
        url = "https://" + url
    if _coles_dead:
        return None
    for attempt in range(2):
      async with _COLES_SEM:  # same serialisation as search_coles - one Coles request at a time
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
            await page.wait_for_timeout(COLES_WAIT_MS)
            raw = await page.evaluate(_coles_product_page_js())
            name = raw.get("name", "")
            price = parse_price(raw.get("price_text", ""))
            unit_price, unit = parse_unit_price(raw.get("unit_price_text", ""))
            if name and price:
                await _register_coles_result(True)
                if attempt > 0:
                    print(f"  [Coles] Retry succeeded for {url}")
                result = {
                    "name": name,
                    "price": price,
                    "unit_price": unit_price,
                    "unit": unit,
                    "url": url,
                    "image_url": _normalise_coles_img(raw.get("image_url", "")),
                }
                if raw.get("multi_buy"):
                    result["multi_buy"] = raw["multi_buy"]
                return result
            # Extraction yielded no product - check if it's a bot-detection page
            if attempt == 0:
                page_title = await page.title()
                if any(kw in page_title.lower() for kw in _COLES_BOT_KEYWORDS):
                    print(f"  [Coles] Bot detection hit on {url}, retrying in 3s…")
                    await page.wait_for_timeout(3000)
                    continue
            if attempt > 0:
                print(f"  [Coles] Retry also failed for {url}, returning None")
            else:
                print(f"  [Coles] Could not extract product (name={name!r}, price={price}) from: {url}")
        except Exception as e:
            if attempt == 0 and "execution context was destroyed" in str(e).lower():
                print(f"  [Coles] Bot detection hit on {url}, retrying in 3s…")
                await page.wait_for_timeout(3000)
                continue
            if attempt > 0:
                print(f"  [Coles] Retry also failed for {url}, returning None")
            else:
                print(f"  [Coles] Exception fetching URL {url}: {e}")
        await _register_coles_result(False)
        return None
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

def _entry_recency(it: dict) -> tuple:
    """Sort key for choosing between two entries of the SAME item. A priced entry
    always beats a priceless one (a failed re-scrape must never clobber good
    carried-forward data); among priced entries, the newest scrape wins."""
    has_price = ((it.get("woolworths") or {}).get("price") is not None
                 or (it.get("coles") or {}).get("price") is not None)
    return (1 if has_price else 0, it.get("last_scraped") or "")


def _purge_alias_items(items: list) -> list:
    """Drop items recorded under a stale alias name when their canonical name
    (per KNOWN_NAME_CHANGES) is also present. Without this, a renamed/merged
    product can linger as a duplicate forever via carry-forward and single-item
    runs (e.g. "Capsicum Green" alongside "Woolworths Capsicum Green").

    Also collapses exact-name duplicates, keeping the FRESHEST entry. Keeping the
    first one instead caused a phantom repeating price change (2026-07-26):
    archived items are pre-populated from existing data early in the run (so they
    survive a stalled run's progress push), and manual runs never skip archived
    items - so the same item got scraped again and appended a second time. The
    price-change differ walked both entries and logged the FRESH price
    ("Australian Grown Carrots $2.00 -> $1.70"), while this function kept the
    STALE one, so latest.json never moved and the next run logged the identical
    change again. The same move appeared to repeat daily while the price on the
    site never changed. See scripts/alias_purge_selfcheck.py."""
    present = {i["list_item"] for i in items}
    # Winning index per name, decided by recency rather than position.
    winner: dict = {}
    for idx, it in enumerate(items):
        name = it["list_item"]
        if name not in winner or _entry_recency(it) >= _entry_recency(items[winner[name]]):
            winner[name] = idx
    out = []
    for idx, it in enumerate(items):
        name = it["list_item"]
        canon = clean_name(name)
        if canon != name and canon in present:
            continue                      # alias whose canonical entry exists - drop it
        if winner[name] != idx:
            continue                      # a fresher entry for this name exists
        out.append(it)
    return out


def _build_output(items: list, not_found: list, trigger: str, progress: dict | None = None, pending_validation: list | None = None, approved_prices: dict | None = None) -> dict:
    # Only compare items where both prices are present - avoids single-store items skewing the totals
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
    if pending_validation is not None:
        out["pending_validation"] = pending_validation
    if approved_prices is not None:
        out["approved_prices"] = approved_prices
    return out


_PROGRESS_BRANCH  = "scrape-progress"
_PROGRESS_API_URL = "https://api.github.com/repos/jtsenter/price-comparison/contents/docs/data/latest.json"

def push_progress(items: list, not_found: list, done: int, total: int, trigger: str,
                  current_item: str = "", started_at: str = "",
                  pending_validation: list | None = None):
    progress: dict = {"done": done, "total": total}
    if started_at:
        progress["started_at"] = started_at
    if current_item:
        progress["current_item"] = current_item
    out = _build_output(items, not_found, trigger, progress=progress, pending_validation=pending_validation)
    os.makedirs(DATA_DIR, exist_ok=True)
    latest_path = os.path.join(DATA_DIR, "latest.json")
    # Minified: latest.json is fetched by every page on every load - keep it small.
    with open(latest_path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("  -> Progress push skipped (no GITHUB_TOKEN)")
        return
    encoded = base64.b64encode(json.dumps(out, separators=(",", ":")).encode("utf-8")).decode("ascii")
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
    }

    def _fetch_sha() -> str | None:
        req = urllib.request.Request(
            f"{_PROGRESS_API_URL}?ref={_PROGRESS_BRANCH}", headers=headers
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())["sha"]
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None   # first write to branch - no SHA needed
            raise

    def _do_put(sha: str | None) -> None:
        body: dict = {
            "message": f"progress: {done}/{total} items scraped",
            "content": encoded,
            "branch": _PROGRESS_BRANCH,
        }
        if sha:
            body["sha"] = sha
        req = urllib.request.Request(
            _PROGRESS_API_URL,
            data=json.dumps(body).encode("utf-8"),
            headers=headers,
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=30):
            pass

    try:
        sha = _fetch_sha()
        try:
            _do_put(sha)
            print(f"  -> Pushed progress to {_PROGRESS_BRANCH} ({done}/{total})")
        except urllib.error.HTTPError as e:
            if e.code == 409:
                # Stale SHA (concurrent write) - refetch and retry once
                try:
                    sha2 = _fetch_sha()
                    _do_put(sha2)
                    print(f"  -> Pushed progress to {_PROGRESS_BRANCH} ({done}/{total}) [409 retry ok]")
                except urllib.error.HTTPError as e2:
                    print(f"  -> Progress push failed after retry: HTTP {e2.code} on {_PROGRESS_BRANCH}")
                except Exception as e2:
                    print(f"  -> Progress push failed after retry: {e2} on {_PROGRESS_BRANCH}")
            else:
                print(f"  -> Progress push skipped: HTTP {e.code} on {_PROGRESS_BRANCH}")
    except Exception as e:
        print(f"  -> Progress push skipped: {e}")


_push_thread_ref = [None]
_push_lock = threading.Lock()

def push_progress_bg(items, not_found, done, total, trigger, existing_items=None,
                     current_item: str = "", started_at: str = "",
                     pending_validation=None):
    """Non-blocking progress push - skips if a previous push is still running.
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
            args=(merged, list(not_found), done, total, trigger, current_item, started_at, pending_validation),
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
    # Archived items refresh on scheduled runs too, but "in a different way":
    # only when their data is stale (older than ARCHIVED_REFRESH_DAYS). This way
    # they update automatically - no separate tool - without scraping every run.
    if ex_data.get("archived") and trigger not in ("scrape_archived", "manual"):
        last_scraped = ex_data.get("last_scraped")
        if not last_scraped:
            return False  # never scraped → fetch it now
        try:
            age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(last_scraped)).days
        except Exception:
            return False
        return age_days < ARCHIVED_REFRESH_DAYS
    if trigger == "manual":
        return False
    # Scheduled runs skip items scraped within SKIP_FRESH_HOURS. Carried-forward
    # items keep their OLD last_scraped, so a failed item is still retried next
    # run - only genuinely fresh successes are skipped. (2026-07-06: a scheduled
    # run fired 18 min after a manual one, re-scraped 208 items, and got Coles
    # 0% because the manual run's volume had already tripped the rate ban.)
    last_scraped = ex_data.get("last_scraped")
    if not last_scraped:
        return False
    try:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(last_scraped)
    except Exception:
        return False
    return age < timedelta(hours=SKIP_FRESH_HOURS)


def _coles_fallback_query(coles_url: str, item: str) -> str:
    """Derive a search query from a Coles product URL slug.

    'coles-strawberries-250g-5191256' -> 'strawberries 250g'
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
) -> tuple[dict | None, bool, dict | None]:
    """Scrape one item. Returns (result_dict | None, is_not_found)."""
    category = guess_category(item)
    history = purchase_history.get(item, {})
    # Fallback: if exact match fails, allow a store-prefix variant of the SAME
    # product (e.g. "Lamb Mince" -> "Woolworths Lamb Mince"), i.e. the Excel name
    # must END with the item name. A bare substring test borrowed history across
    # different products - "…Porterhouse Steak" matched "…Porterhouse Steak &
    # Butter", giving the loose $/kg listing the 2-pack's receipt prices (the
    # phantom $100/kg trend points).
    if not history and purchase_history:
        for excel_name, hist_data in purchase_history.items():
            if excel_name.lower().endswith(item.lower()) and hist_data.get("price_history"):
                history = hist_data
                break
    existing_item = next((ex for ex in existing_data.get("items", []) if ex["list_item"] == item), {})
    existing_item = existing_item or {}  # guard: next() default is {} but protect any None path

    # Tracks whether each side was fetched directly (skip name-based picker)
    _skip_picker_ww = False
    _skip_picker_co = False
    # Set when a pinned WW URL existed but its fetch failed; ensures carry-forward
    # fires even if fallback searches return non-empty-but-unmatched results.
    _had_pinned_ww = False
    # Deliberately-not-attempted stores (single-store pins / explicit single-URL
    # refresh). These must NOT count as misses in the scrape log - they aren't
    # failures, the store simply doesn't sell the product.
    _ww_skipped = False
    _co_skipped = False

    if ww_url or coles_url:
        # Explicit URL refresh (workflow dispatch) - use the URL; no name-search fallback
        if ww_url and not coles_url:
            print(f"  Fetching WW by URL: {ww_url}")
            _ww = await fetch_ww_by_url(ww_page, ww_url)
            if not _ww: print(f"  WW URL fetch failed: {ww_url}")
            ww_results = [_ww] if _ww else []
            _skip_picker_ww = True
            coles_results = [existing_item["coles"]] if existing_item.get("coles") else []
            _skip_picker_co = True
            _co_skipped = True
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
            _ww_skipped = True
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
        # Name-based search (normal scrape) - honour url_overrides.json if present
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
                # Treat price=0 the same as a fetch failure - WW sometimes SSR-serves $0
                # for products whose real price is only set client-side (EDLP products).
                if _ww and (_ww.get('price') or 0) > 0:
                    ww_results = [_ww]
                    _skip_picker_ww = True
                else:
                    # WW blocks direct page access from GHA - fall back to name search
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
                            # Stockcode not in top-5 results - retry search using URL slug
                            _slug_q = _sc_m.group(2).replace('-', ' ').strip()
                            # Also derive a brand-prefix-stripped query (e.g. "woolworths chickpeas"
                            # -> "chickpeas") to try if the slug is identical to the item name.
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
                                    # Pinned stockcode not found - don't substitute a different product.
                                    # Clear results so carry-forward preserves the last known price.
                                    print(f"  WW: pinned stockcode {_sc} not in results - carrying forward")
                                    ww_results = []
                                    _skip_picker_ww = True
            else:
                # Reached only when pinned_co is set but pinned_ww is not - i.e. a
                # Coles-only product. Do NOT name-search Woolworths: it mis-matches
                # unrelated WW items (e.g. "Coles 3 Star Lamb Mince" → "Woolworths Lamb
                # Mince"), polluting the data. A single-store pin means a single store.
                ww_results = []
                _ww_skipped = True
            if pinned_co:
                _co = await fetch_coles_by_url(coles_page, pinned_co)
                if _co:
                    coles_results = [_co]
                    _skip_picker_co = True
                else:
                    # Coles product page failed - derive search query from URL slug
                    # (e.g. "coles-strawberries-250g-5191256" -> "strawberries 250g")
                    _fq = _coles_fallback_query(pinned_co, item)
                    print(f"  Coles pinned URL failed, searching by: {_fq!r}")
                    coles_results = await search_with_retry(search_coles, coles_page, _fq)
                    if coles_results:
                        # Only the pinned product will do. Falling back to the top
                        # search result here silently attributed ANOTHER product's
                        # price to this one: a pinned item that goes "Currently
                        # unavailable" drops out of search, so the top hit is a
                        # sibling pack - e.g. the Lilydale 545g small pack showed
                        # the 900g bulk price, and the free-range RSPCA cutlets
                        # showed the non-free-range ones. With the matcher bypassed
                        # (_skip_picker_co) nothing downstream could catch it.
                        # No pinned match = no price, which is the truth.
                        _slug_m = re.search(r'/product/([^/?]+)', pinned_co)
                        _co_hit = None
                        if _slug_m:
                            _pinned_slug = _slug_m.group(1)
                            _co_hit = next((r for r in coles_results if _pinned_slug in r.get('url', '')), None)
                        if _co_hit:
                            print(f"  Coles: matched by pinned slug")
                            coles_results = [_co_hit]
                            _skip_picker_co = True  # bypass matcher; user chose this product
                        else:
                            print(f"  Coles: pinned product not in search results - treating as unavailable")
                            coles_results = []
            else:
                # Woolworths-only pinned item - don't name-search Coles (same mis-match risk).
                coles_results = []
                _co_skipped = True
        else:
            ww_results, coles_results = await asyncio.gather(
                search_with_retry(search_woolworths, ww_page, item, retries=1),
                search_with_retry(search_coles, coles_page, item, retries=1),
            )
            # Search came back empty but a past run matched this product and stored
            # its URL - refetch that page directly. Rescues blocked-search runs
            # (Coles rate-bans search mid-run far more readily than product pages)
            # and costs nothing when search works. Same product → skip the matcher.
            if not ww_results and (existing_item.get("woolworths") or {}).get("url"):
                _ww = await fetch_ww_by_url(ww_page, existing_item["woolworths"]["url"])
                if _ww and (_ww.get("price") or 0) > 0:
                    print("    WW: search empty - recovered via last-known product URL")
                    ww_results = [_ww]
                    _skip_picker_ww = True
            if not coles_results and (existing_item.get("coles") or {}).get("url"):
                _co = await fetch_coles_by_url(coles_page, existing_item["coles"]["url"])
                if _co:
                    print("    Coles: search empty - recovered via last-known product URL")
                    coles_results = [_co]
                    _skip_picker_co = True
        await delay()

    # Drop any candidates the user explicitly rejected for this item via "Different item".
    # Matched by stable product id so query-param noise doesn't defeat the blocklist.
    _rej_item = _load_rejected_urls().get(item, {})
    _rej_ww = {_product_key(u) for u in _rej_item.get("ww", [])}
    _rej_co = {_product_key(u) for u in _rej_item.get("coles", [])}
    if _rej_ww and ww_results:
        _before = len(ww_results)
        ww_results = [r for r in ww_results if _product_key(r.get("url", "")) not in _rej_ww]
        if len(ww_results) != _before:
            print(f"    WW: dropped {_before - len(ww_results)} rejected candidate(s)")
    if _rej_co and coles_results:
        _before = len(coles_results)
        coles_results = [r for r in coles_results if _product_key(r.get("url", "")) not in _rej_co]
        if len(coles_results) != _before:
            print(f"    Coles: dropped {_before - len(coles_results)} rejected candidate(s)")

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

    # Record fresh per-store misses for this run's scrape log, BEFORE carry-forward
    # masks a miss with the last-known price. This is the signal that surfaces
    # chronically-skipped products in the UI summary (a carried price still hides a gap).
    # A deliberately-skipped store (single-store pin) is neither attempted nor missed.
    _ww_reason = _miss_reason(ww_match, ww_results)
    _co_reason = _miss_reason(coles_match, coles_results)
    _run_store_misses.append({
        "item": item,
        "ww_attempted": not _ww_skipped,
        "co_attempted": not _co_skipped,
        "ww_missed": ww_match is None and not _ww_skipped,
        "co_missed": coles_match is None and not _co_skipped,
        "ww_reason": _ww_reason,
        "co_reason": _co_reason,
    })

    # Carry forward existing store data when no fresh result is available.
    # Always carry forward when the matcher produced no usable result - whether because
    # the search returned nothing, the URL fetch failed, or the matcher rejected all
    # candidates. Losing existing price data is always worse than briefly keeping a
    # slightly stale match; the next successful scrape will correct it.
    def _carry(existing_key, conf_label, tag):
        existing = existing_item.get(existing_key)
        if existing and existing.get("price") is not None:
            print(f"    {tag}: keeping existing ${existing.get('price')} ({existing.get('name','?')})")
            return existing, conf_label
        return None, "none"

    # A deliberately-skipped store (single-store pin = "not sold there") must NOT
    # carry forward: keeping the stale price made it impossible to ever remove a
    # product from one store - the old number just kept resurfacing.
    if coles_match is None and not _co_skipped:
        coles_match, co_conf = _carry("coles", "carried", "Coles")

    if ww_match is None and not _ww_skipped:
        ww_match, ww_conf = _carry("woolworths", "carried", "WW")

    if not ww_match and not coles_match:
        return None, True, None

    # Guard: validate existing_item is a valid dict before accessing price history
    if not isinstance(existing_item, dict):
        print(f"[ERROR] Item lookup failed or invalid: {item!r}")
        return None, True, None

    # Detect implausible price swings (usually a wrong-product match). Per the
    # "flag, don't delete" rule we KEEP the scraped price live and route it into
    # pending_validation (see reasons merge below) instead of silently discarding
    # it and carrying forward the old price. The user confirms/rejects on the
    # validate page; nothing is mutated in history until then.
    def _jump_reason(new_price, prev_price, item_dict):
        if new_price is None or prev_price is None or prev_price <= 0:
            return None
        change_pct = (new_price - prev_price) / prev_price
        all_hist = (
            [e['price'] for e in item_dict.get('ww_price_history', []) if e.get('price', 0) > 0] +
            [e['price'] for e in item_dict.get('coles_price_history', []) if e.get('price', 0) > 0] +
            [e['price'] for e in item_dict.get('price_history', []) if e.get('price', 0) > 0]
        )
        if all_hist and min(all_hist) <= new_price <= max(all_hist):
            return None  # within known historical range -> not suspicious
        if change_pct > 1.00:   # >100% increase = likely wrong page/product
            return f"jumped {change_pct*100:.0f}% up"
        if change_pct < -0.35:  # >35% drop = likely data error (real specials are smaller)
            return f"dropped {abs(change_pct)*100:.0f}%"
        return None

    ww_prev_hist = existing_item['ww_price_history'][-1]['price'] if existing_item.get('ww_price_history') else None
    co_prev_hist = existing_item['coles_price_history'][-1]['price'] if existing_item.get('coles_price_history') else None
    _ww_jump = _jump_reason(ww_match['price'] if ww_match else None, ww_prev_hist, existing_item)
    _co_jump = _jump_reason(coles_match['price'] if coles_match else None, co_prev_hist, existing_item)
    if _ww_jump:
        print(f"    [FLAG] WW {_ww_jump}: ${ww_prev_hist}->${ww_match['price']} - keeping live, flagging for validation")
    if _co_jump:
        print(f"    [FLAG] Coles {_co_jump}: ${co_prev_hist}->${coles_match['price']} - keeping live, flagging for validation")

    # Compute _ww_price_factor for per-kg items (used by UI for price_history normalisation).
    # WW sells loose produce (e.g. mushrooms) at $/kg; Coles sells fixed packs (e.g. 200g).
    # Store the factor so the UI can normalise price_history and trend bars accordingly.
    # The displayed WW price remains the actual shelf price (per-kg), not a sub-pack equivalent.
    _ww_price_factor = 1.0
    if ww_match and coles_match:
        _ww_unit = (ww_match.get("unit") or "").strip().upper()
        ww_price_val = ww_match.get("price")
        ww_cup_val = ww_match.get("unit_price")
        # Only apply factor if WW's displayed price IS a per-kg rate
        # (price ≈ cup/unit price, meaning no pack markup). If they differ,
        # WW price is a pack total and factor must be 1.0.
        is_per_kg_rate = (
            ww_cup_val is not None and
            ww_price_val is not None and
            abs(ww_price_val - ww_cup_val) <= max(0.05, ww_price_val * 0.01)
        )
        if _ww_unit in ("KG", "1KG") and is_per_kg_rate:
            _co_size_g = extract_weight_g(coles_match.get("name", ""))
            if _co_size_g and _co_size_g < 900:
                _ww_price_factor = round(_co_size_g / 1000, 4)
                print(f"    WW per-kg rate detected: ${ww_price_val}, factor for {_co_size_g}g: {_ww_price_factor}")
            else:
                print(f"    WW unit=KG but Coles pack >=900g or missing - factor 1.0")
        else:
            print(f"    WW price ${ww_price_val} != cup ${ww_cup_val} (pack total, not per-kg) - factor 1.0")

    ww_price = ww_match["price"] if ww_match else None
    coles_price = coles_match["price"] if coles_match else None
    # For per-kg WW items, use normalised price so comparison is apples-to-apples
    ww_norm = round(ww_price * _ww_price_factor, 2) if ww_price is not None else None

    cheaper_store = None
    saving = None
    # saving_per_item is the per-unit price difference (NOT qty-adjusted).
    # The app.js multiplies this by units/qty to show basket total savings.
    if ww_norm is not None and coles_price is not None:
        if ww_norm < coles_price:
            cheaper_store, saving = "woolworths", round(coles_price - ww_norm, 2)
        elif coles_price < ww_norm:
            cheaper_store, saving = "coles", round(ww_norm - coles_price, 2)
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

    # Deduplicate by date before use - guards against external writes introducing duplicates
    existing_ww_hist = _dedup_hist(existing_item.get("ww_price_history",    []) or [])
    existing_co_hist = _dedup_hist(existing_item.get("coles_price_history", []) or [])
    today_str = date.today().isoformat()
    ww_add = _should_add_history_entry(existing_ww_hist,  ww_price,    today_str) if ww_price    else False
    co_add = _should_add_history_entry(existing_co_hist,  coles_price, today_str) if coles_price else False
    item_price_history = history.get("price_history", [])
    prev_ww    = (existing_item.get("woolworths") or {}).get("price")
    prev_coles = (existing_item.get("coles")     or {}).get("price")
    _item_approved = (existing_data.get("approved_prices") or {}).get(item, {})
    ww_reasons    = ([] if _is_approved(ww_price,    _item_approved.get("ww"))
                     else _suspicious_reasons(ww_price,    prev_ww,    item_price_history))
    coles_reasons = ([] if _is_approved(coles_price, _item_approved.get("coles"))
                     else _suspicious_reasons(coles_price, prev_coles, item_price_history))

    # Merge implausible-jump flags (computed above). This covers items with too
    # little Excel price_history for _suspicious_reasons to fire, while keeping the
    # scraped price live and routing it to pending_validation.
    if _ww_jump and not _is_approved(ww_price, _item_approved.get("ww")):
        ww_reasons = ww_reasons + [_ww_jump]
    if _co_jump and not _is_approved(coles_price, _item_approved.get("coles")):
        coles_reasons = coles_reasons + [_co_jump]

    def _hist_entry(price, match):
        """One history point. `price` is the LOWEST price actually obtainable that
        day: the multi-buy unit rate when a deal was running and beat the ticket,
        otherwise the shelf price. A promo price is a real price the item sold at,
        so it belongs in the history and in the trend range. The shelf price is
        kept as `shelf` (only when it differs) so the UI can show what the ticket
        said and how big the discount was."""
        best = round(price, 2)
        e = {"date": today_str, "price": best}
        mb = (match or {}).get("multi_buy")
        if mb and mb.get("qty") and mb.get("total") is not None:
            per = round(mb["total"] / mb["qty"], 2)
            if per < best:
                e["price"] = per
                e["shelf"] = best
                e["mb"] = {"qty": mb["qty"], "total": mb["total"]}
        return e

    # WW history: withhold if suspicious; append if price changed or ≥7 days since last entry
    if ww_reasons:
        new_ww_hist = existing_ww_hist
    elif ww_add:
        new_ww_hist = existing_ww_hist + [_hist_entry(ww_price, ww_match)]
    else:
        new_ww_hist = existing_ww_hist

    # Coles history: same logic
    if coles_reasons:
        new_co_hist = existing_co_hist
    elif co_add:
        new_co_hist = existing_co_hist + [_hist_entry(coles_price, coles_match)]
    else:
        new_co_hist = existing_co_hist

    # week_conflict is normal repricing behaviour - never a validation trigger

    # FIX 1: don't flag a store whose price is identical to the previous scrape.
    # An unchanged price cannot be a real pricing event regardless of history shape.
    if ww_reasons and ww_price is not None and prev_ww is not None and round(ww_price, 2) == round(prev_ww, 2):
        ww_reasons = []
    if coles_reasons and coles_price is not None and prev_coles is not None and round(coles_price, 2) == round(prev_coles, 2):
        coles_reasons = []

    # FIX 3: if the flagged store's new price matches the competitor's price exactly,
    # it's a real market price - two stores agreeing on the same price is not suspicious.
    if ww_reasons and ww_price is not None and coles_price is not None and round(ww_price, 2) == round(coles_price, 2):
        ww_reasons = []
    if coles_reasons and coles_price is not None and ww_price is not None and round(coles_price, 2) == round(ww_price, 2):
        coles_reasons = []

    # FIX 4: if the price falls within the combined range of all observed scrape prices
    # (both WW and Coles histories), it is a known market price - not suspicious.
    # e.g. WW at $5.50 when WW history is $2.30-$3.70 but Coles history is $6.50:
    # the combined range is $2.30-$6.50, so $5.50 is within range and should not be flagged.
    _all_scrape_prices = (
        [e["price"] for e in existing_ww_hist if e.get("price", 0) > 0] +
        [e["price"] for e in existing_co_hist if e.get("price", 0) > 0]
    )
    if _all_scrape_prices:
        _hist_lo, _hist_hi = min(_all_scrape_prices), max(_all_scrape_prices)
        if ww_reasons and ww_price is not None and _hist_lo <= ww_price <= _hist_hi:
            ww_reasons = []
        if coles_reasons and coles_price is not None and _hist_lo <= coles_price <= _hist_hi:
            coles_reasons = []

    all_reasons = list(dict.fromkeys(ww_reasons + coles_reasons))
    _validation_entry = None
    if all_reasons:
        # FIX 2: suppress entry if every still-flagged store's price is within the
        # approved_prices tolerance - the per-store _is_approved check above only
        # runs before _suspicious_reasons; this catches edge cases where approved
        # prices were updated between scrape runs.
        _ww_clear = not ww_reasons or _is_approved(ww_price, _item_approved.get("ww"))
        _co_clear = not coles_reasons or _is_approved(coles_price, _item_approved.get("coles"))
        if not (_ww_clear and _co_clear):
            _validation_entry = {
                "item": item,
                "ww_price": ww_price,
                "ww_url": (ww_match or {}).get("url", ""),
                "ww_prev_price": prev_ww,
                "ww_suspicious": bool(ww_reasons),
                "coles_price": coles_price,
                "coles_url": (coles_match or {}).get("url", ""),
                "coles_prev_price": prev_coles,
                "coles_suspicious": bool(coles_reasons),
                "flagged_date": today_str,
                "reason": all_reasons,
            }

    # FIX 3: Suppress EDR/member prices - only when is_on_special is explicitly False.
    # If is_on_special=True (confirmed public sale) or None (search result, unknown),
    # allow the price through to validation instead of silently carrying forward the old price.
    if ww_reasons and 'suspicious_drop_gt20pct' in ww_reasons and ww_match and prev_ww is not None:
        if ww_match.get('is_on_special') == False:
            print(f"    [FIX] WW EDR/member price suppressed: keeping ${prev_ww} (not a public special)")
            ww_match = None  # carry-forward previous price
        else:
            print(f"    [FIX] WW drop allowed through to validation: ${ww_match.get('price')} (public special or unknown)")

    if coles_reasons and 'suspicious_drop_gt20pct' in coles_reasons and coles_match and prev_coles is not None:
        if coles_match.get('is_on_special') == False:
            print(f"    [FIX] Coles EDR/member price suppressed: keeping ${prev_coles} (not a public special)")
            coles_match = None  # carry-forward previous price
        else:
            print(f"    [FIX] Coles drop allowed through to validation: ${coles_match.get('price')} (public special or unknown)")

    # If a store returned no result this run (and _carry also found nothing), preserve
    # whatever was in the previous latest.json rather than overwriting with None.
    # This prevents a single bot-detection miss from permanently erasing valid data.
    # _nonzero: discard any store entry whose price is 0 or missing - $0 is not a
    # real price (Woolworths serves it for products that load but aren't priced).
    def _nonzero(store_data):
        if store_data is None:
            return None
        p = store_data.get("price")
        return None if (p is not None and p <= 0) else store_data

    _raw_ww = ww_match if ww_match is not None else existing_item.get("woolworths")
    _raw_co = coles_match if coles_match is not None else existing_item.get("coles")
    if ww_match is not None and (ww_match.get("price") or 0) <= 0:
        print(f"  WW: price=${ww_match.get('price')} treated as unavailable (null)")
    if coles_match is not None and (coles_match.get("price") or 0) <= 0:
        print(f"  Coles: price=${coles_match.get('price')} treated as unavailable (null)")
    _final_ww = _nonzero(_raw_ww)
    _final_co = _nonzero(_raw_co)

    result = {
        "list_item": item,
        "last_scraped": datetime.now(timezone.utc).isoformat(),
        "trip_count": history.get("trip_count", 0),
        "price_history": [e for e in history.get("price_history", [])
                          if e.get("date", "") not in ("", "1970-01-01", None)],
        "category": category,
        "woolworths": _final_ww,
        "coles": _final_co,
        "cheaper_store": cheaper_store,
        "saving_per_item": saving,
        "alternatives": alternatives,
        "ww_price_history": new_ww_hist,
        "coles_price_history": new_co_hist,
        **pair_meta,
    }
    if _ww_price_factor != 1.0:
        result["_ww_price_factor"] = _ww_price_factor
    return result, False, _validation_entry


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

    # Permanently-deleted items (written by the UI's "Delete forever" action).
    # THE scraper-side half of deletion: the browser can purge the JSON files but
    # it cannot touch shopping_list.xlsx, so without this gate the next run would
    # read the Excel, re-scrape the name and resurrect it - which is exactly how
    # "Plum Red" came back before. Enforced at every entry point below: the
    # shopping list, url_overrides' manual adds, and the carry-forward map.
    removed_path = os.path.join(DATA_DIR, "removed_items.json")
    removed_set: set[str] = set()
    if os.path.exists(removed_path):
        try:
            with open(removed_path) as _f:
                removed_set = set(json.load(_f))
        except Exception:
            pass
    if removed_set:
        archived_set -= removed_set
        # Drops the name from BOTH the active list and the archived list, since
        # each is derived from these two.
        _before = len(purchase_history)
        purchase_history = {k: v for k, v in purchase_history.items() if k not in removed_set}
        if len(purchase_history) != _before:
            print(f"  [removed] skipping {_before - len(purchase_history)} permanently-deleted item(s)")

    if single_item:
        shopping_list = [single_item]
        print(f"Single-item refresh: {single_item}" + (f" [WW URL]" if ww_url else "") + (f" [Coles URL]" if coles_url else ""))
    elif trigger == "scrape_archived":
        shopping_list = sorted(archived_set)
        print(f"Archived-only scrape: {len(shopping_list)} items")
    else:
        # Order by the user's actual priority tags (synced from the UI into
        # user_settings.json): weekly first, then monthly, then rare - so if the
        # run dies mid-way (Coles rate-ban, runner reboot) the items that matter
        # most already have fresh prices. Untagged items count as weekly (the UI
        # default). Trip count breaks ties within a band.
        _user_priorities: dict = {}
        try:
            with open(os.path.join(DATA_DIR, "user_settings.json")) as _f:
                _user_priorities = json.load(_f).get("priorities", {}) or {}
        except Exception:
            pass
        _PRIO_RANK = {"weekly": 0, "monthly": 1, "rare": 2}

        # Intermittent items (priced at NEITHER store in the current latest.json)
        # are typically out-of-stock variant-group members that occasionally
        # reappear. Scrape them LAST among active items (rank 3, below "rare") so
        # a rate-ban or crash never delays items that actually have prices. The
        # set is derived fresh each run, so an item that comes back in stock
        # automatically returns to its normal priority next run. Archived items
        # still come after these (appended below).
        _unpriced_last_run: set = set()
        try:
            with open(os.path.join(DATA_DIR, "latest.json")) as _lf:
                for _it in json.load(_lf).get("items", []):
                    _ww = (_it.get("woolworths") or {}).get("price")
                    _co = (_it.get("coles") or {}).get("price")
                    if _ww is None and _co is None:
                        _unpriced_last_run.add(_it.get("list_item"))
        except Exception:
            pass

        def _priority_key(name):
            if name in _unpriced_last_run:
                rank = 3
            else:
                rank = _PRIO_RANK.get(_user_priorities.get(name, "weekly"), 0)
            trips = purchase_history.get(name, {}).get("trip_count", 0)
            return (rank, -trips)
        # Active items first (by priority); archived items appended LAST so they
        # refresh in the same scheduled run but never delay active items. The
        # staleness gate in should_skip_item keeps them to ~weekly, not every run.
        active = sorted(
            [n for n in purchase_history.keys() if n not in archived_set],
            key=_priority_key,
        )
        archived_list = sorted(n for n in archived_set if n in purchase_history)
        shopping_list = active + archived_list

        # Items pinned via url_overrides.json but not in the Excel get added here
        # so they are actively re-scraped each run (fresh prices).  The universal
        # carry-forward below handles the fallback if the scrape fails.
        overrides_path = os.path.join(DATA_DIR, "url_overrides.json")
        if os.path.exists(overrides_path):
            try:
                with open(overrides_path) as _f:
                    _url_ov = json.load(_f)
                shopping_set = set(shopping_list)
                manually_added = [
                    n for n, v in _url_ov.items()
                    if n and n != "undefined" and n not in shopping_set
                    and n not in removed_set          # a pin must not resurrect a deleted item
                    and (v.get("ww_url") or v.get("coles_url"))
                ]
                if manually_added:
                    shopping_list = shopping_list + manually_added
                    print(f"  + {len(manually_added)} manually-pinned item(s) from url_overrides.json")
            except Exception:
                pass

        print(f"Active shopping list: {len(active)} items + {len(archived_list)} archived (refreshed if older than {ARCHIVED_REFRESH_DAYS}d)")

    detect_fuzzy_changes(shopping_list, FLAG_PATH)

    latest_path = os.path.join(DATA_DIR, "latest.json")
    existing_data = {}
    if os.path.exists(latest_path):
        with open(latest_path) as f:
            existing_data = json.load(f)
    existing_map = {i["list_item"]: i for i in existing_data.get("items", [])}
    # Third gate: the universal carry-forward below preserves anything already in
    # latest.json, which would quietly restore a deleted item that a stale
    # progress push had re-added mid-run. Drop them here so no later step sees them.
    for _rm in removed_set:
        existing_map.pop(_rm, None)

    items_output = []
    not_found = []
    new_validation_entries: list = []
    single_item_ve = None

    # Load existing pending_validation as a dict keyed by item name for O(1) dedup
    existing_pv: dict = {e["item"]: e for e in existing_data.get("pending_validation", [])}
    # Load existing approved_prices - carried forward and updated during this run
    existing_approved: dict = dict(existing_data.get("approved_prices") or {})

    async with async_playwright() as pw:
        # UA needs BOTH properties (verified live 2026-07-06):
        #   1. no "HeadlessChrome" token - WW's edge 403s it on the first request;
        #   2. a version matching the real Chrome build - the old hardcoded
        #      Chrome/124 lagged the installed browser, and a UA/fingerprint
        #      version mismatch is itself a bot signal for Incapsula.
        # So: read the real version with a throwaway launch, then advertise it.
        _probe = await pw.chromium.launch(headless=True, channel="chrome")
        _chrome_major = _probe.version.split(".")[0]
        await _probe.close()
        real_ua = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            f"AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{_chrome_major}.0.0.0 Safari/537.36"
        )
        print(f"Browser: Chrome {_chrome_major} (persistent profile)")

        # Persistent profile: Incapsula/Akamai trust cookies (Coles) survive across
        # runs, so a session that passed a challenge once stays trusted instead of
        # re-triggering the bot check from zero every run. Lives OUTSIDE the repo -
        # actions/checkout's `git clean -ffdx` would wipe anything in the worktree.
        profile_dir = os.path.join(
            os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "pricewatch-pw-profile"
        )
        context = await pw.chromium.launch_persistent_context(
            profile_dir,
            headless=True,
            channel="chrome",
            user_agent=real_ua,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
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
                try:
                    await ww_page.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                    await delay()
                except Exception as e:
                    print(f"  WW warm-up navigation failed (continuing): {e}")
            if need_coles:
                try:
                    await coles_page.goto(COLES_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                    await delay()
                except Exception as e:
                    print(f"  Coles warm-up navigation failed (continuing): {e}")

            result, is_nf, _ve = await _scrape_single_item(
                single_item, purchase_history, ww_page, coles_page,
                ww_url, coles_url, existing_data,
            )
            if result:
                items_output.append(result)
            else:
                not_found.append(single_item)
            single_item_ve = _ve

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

            # Pre-populate archived items so they appear in every progress push.
            # The final write also appends them (else: branch below), but since
            # the scrape often stalls before completing, the last progress push
            # becomes the permanent latest.json - archived items must be in it.
            if trigger != "scrape_archived":
                _arch_present = {i["list_item"] for i in items_output}
                for _arch_name in sorted(archived_set):
                    if _arch_name in _arch_present:
                        continue
                    _arch_ex = existing_map.get(_arch_name)
                    if _arch_ex is not None:
                        items_output.append({**_arch_ex, "archived": True})
                    else:
                        _arch_hist = purchase_history.get(_arch_name)
                        if not _arch_hist:
                            continue
                        items_output.append({
                            "list_item": _arch_name,
                            "archived": True,
                            "trip_count": _arch_hist.get("trip_count", 0),
                            "price_history": [e for e in _arch_hist.get("price_history", [])
                                              if e.get("date", "") not in ("", "1970-01-01", None)],
                            "category": guess_category(_arch_name),
                            "woolworths": None,
                            "coles": None,
                            "cheaper_store": None,
                            "saving_per_item": None,
                            "ww_price_history": [],
                            "coles_price_history": [],
                        })

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
                # Warm-up navigation. MUST NOT be fatal: Woolworths intermittently blocks
                # the runner IP, and an unguarded goto here would crash the entire scrape
                # (exit 1) before a single item is processed. The page is still usable -
                # search_* navigate to their own URLs - so on failure we just continue.
                try:
                    await p.goto(WOOLWORTHS_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                except Exception as e:
                    print(f"  WW warm-up navigation failed (continuing): {e}")
                await ww_pool.put(p)
                p = await context.new_page()
                try:
                    await p.goto(COLES_BASE, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
                except Exception as e:
                    print(f"  Coles warm-up navigation failed (continuing): {e}")
                await co_pool.put(p)

            # Push an initial progress marker before scraping begins so the UI
            # can show the progress bar immediately.  At this point _push_thread_ref[0]
            # is None (no previous push), so the lock check never fires and the
            # background thread starts without delay.
            _scrape_start_time = datetime.now(timezone.utc).isoformat()
            # [0] = run start (monotonic), [1] = seconds to reach 90% of items.
            # Two numbers instead of one because the progress bar appears to sit
            # near the end for a while: if p90 lands close to the total, the run
            # is even and that impression is wrong; if it lands far short, the
            # tail genuinely dominates and 90% is the honest yardstick.
            _run_clock = [time.monotonic(), None]
            if total_to_scrape > 0:
                push_progress_bg(
                    items_output, not_found,
                    skipped,            # items already handled via carry-forward
                    total_all, trigger,
                    existing_items=list(existing_map.values()),
                    current_item="",
                    started_at=_scrape_start_time,
                    pending_validation=existing_pv if existing_pv else None,
                )

            sem = asyncio.Semaphore(CONCURRENCY)
            completed = [0]

            async def scrape_one(name: str):
                async with sem:
                    ww_page = await ww_pool.get()
                    co_page = await co_pool.get()
                    timed_out = False
                    _force_push = False
                    try:
                        idx = completed[0] + 1
                        print(f"[{idx}/{total_to_scrape}] {name}")
                        result, is_nf, _ve = await asyncio.wait_for(
                            _scrape_single_item(
                                name, purchase_history, ww_page, co_page, "", "", existing_data,
                            ),
                            timeout=90,
                        )
                        if result:
                            items_output.append(result)
                        else:
                            not_found.append(name)
                        if _ve:
                            new_validation_entries.append(_ve)
                    except asyncio.TimeoutError:
                        print(f"  [TIMEOUT] {name} exceeded 90s - keeping existing data")
                        not_found.append(name)   # final carry-forward will restore existing price data
                        timed_out = True
                        _force_push = True       # push immediately so UI stall detector resets
                    except Exception as e:
                        print(f"  Error scraping {name}: {e}")
                        not_found.append(name)   # keep item visible; final pass will carry forward
                    finally:
                        completed[0] += 1
                        if (_run_clock[1] is None and total_to_scrape
                                and completed[0] >= total_to_scrape * 0.90):
                            _run_clock[1] = time.monotonic() - _run_clock[0]
                        if completed[0] % 5 == 0 or _force_push or (total_to_scrape - completed[0]) < 5:
                            _pv_snap = {**existing_pv, **{e["item"]: e for e in new_validation_entries}}
                            merged_pv = list(_pv_snap.values())
                            push_progress_bg(
                                items_output, not_found,
                                # done = items actually processed this run (completed[0],
                                # which counts found + not-found + timed-out + errored)
                                # plus carry-forward skips. items_output can't be used here:
                                # it already includes skips AND pre-populated archived rows,
                                # so len(items_output)+skipped double-counts → "274 of 214".
                                completed[0] + skipped,
                                total_all, trigger,
                                existing_items=list(existing_map.values()),
                                current_item=name,
                                started_at=_scrape_start_time,
                                pending_validation=merged_pv if merged_pv else None,
                            )
                        # Checkpoint the scrape log once ~95% of items are done.
                        # No full run ever finishes completely clean, and a crash
                        # in the tail used to erase the entire scrape from the
                        # record. This entry is marked partial and is replaced by
                        # the final one if the run does reach the end.
                        if (_log_checkpoint[0] and not _log_checkpoint[1] and total_to_scrape
                                and completed[0] >= total_to_scrape * 0.95):
                            _log_checkpoint[1] = True
                            try:
                                _log_checkpoint[0](True)
                                print(f"  -> Scrape log checkpointed at {completed[0]}/{total_to_scrape}")
                            except Exception as _e:
                                print(f"  [warn] scrape-log checkpoint failed: {_e}")
                        if timed_out:
                            # Reset pages after mid-navigation cancellation
                            for _p, _base in [(ww_page, WOOLWORTHS_BASE), (co_page, COLES_BASE)]:
                                try:
                                    await _p.goto(_base, wait_until="commit", timeout=5000)
                                except Exception:
                                    pass
                        await ww_pool.put(ww_page)
                        await co_pool.put(co_page)

            # One writer for both the 95% checkpoint and the final entry, so the
            # provisional and real rows can never drift apart.
            def _write_scrape_log(partial: bool) -> None:
                _append_scrape_log(
                    trigger, len(_run_store_misses),
                    sorted(({"item": e["item"], "reason": e["ww_reason"]}
                            for e in _run_store_misses if e["ww_missed"]), key=lambda x: x["item"]),
                    sorted(({"item": e["item"], "reason": e["co_reason"]}
                            for e in _run_store_misses if e["co_missed"]), key=lambda x: x["item"]),
                    ww_attempted=sum(1 for e in _run_store_misses if e["ww_attempted"]),
                    coles_attempted=sum(1 for e in _run_store_misses if e["co_attempted"]),
                    partial=partial,
                    duration_s=time.monotonic() - _run_clock[0],
                    duration_p90_s=_run_clock[1],
                    archived=sum(1 for e in _run_store_misses if e["item"] in archived_set),
                )

            _log_checkpoint[0] = _write_scrape_log
            _run_store_misses.clear()
            await asyncio.gather(*[scrape_one(name) for name in to_scrape])

            # Scrape log: record this run's per-store fresh misses so the UI can show
            # miss rates over time and which products get skipped most. Items that timed
            # out or errored never reached the match phase, so they're absent here -
            # `scraped` counts items that completed matching, not total attempted.
            # Each entry is {item, reason}: "no_results" (search/fetch returned nothing -
            # points at a block or a broken selector) vs "no_match" (got candidates, none
            # matched the query well enough - points at a naming/matcher issue instead).
            _ww_missed = sorted(
                ({"item": e["item"], "reason": e["ww_reason"]} for e in _run_store_misses if e["ww_missed"]),
                key=lambda e: e["item"],
            )
            _co_missed = sorted(
                ({"item": e["item"], "reason": e["co_reason"]} for e in _run_store_misses if e["co_missed"]),
                key=lambda e: e["item"],
            )
            # Price changes this run: previous latest.json price vs freshly scraped
            # price, per store, with old AND new - the raw data for studying how
            # each supermarket moves prices over time. Carried-forward rows diff to
            # zero and drop out naturally.
            def _store_changes(store_key):
                out = []
                for it in items_output:
                    old = existing_map.get(it["list_item"])
                    if not old:
                        continue
                    op = (old.get(store_key) or {}).get("price")
                    np = (it.get(store_key) or {}).get("price")
                    if op is not None and np is not None and abs(op - np) > 0.004:
                        out.append({"item": it["list_item"], "old": op, "new": np})
                return sorted(out, key=lambda e: e["item"])

            # End-of-run bookkeeping must NEVER be able to discard a finished
            # scrape. A NameError in here once killed four consecutive full runs:
            # all 284 items had been scraped, the process exited 1, and the
            # workflow's commit step - skipped on failure - threw the lot away.
            # Log the problem and let the run exit clean so the data still lands.
            try:
                _write_scrape_log(partial=False)
            except Exception as e:
                print(f"  [warn] scrape log write failed (data is unaffected): {e}")
            # Price movements go to their OWN uncapped archive (price_changes.json),
            # separate from the 30-run scrape_log, so the pricing-strategy record
            # is kept indefinitely.
            try:
                _append_price_changes(trigger, _store_changes("woolworths"), _store_changes("coles"))
            except Exception as e:
                print(f"  [warn] price-change archive write failed (data is unaffected): {e}")

        await context.close()  # persistent context: closing also flushes the profile to disk

    os.makedirs(DATA_DIR, exist_ok=True)

    if not single_item:
        # Carry-forward: any item already in latest.json that wasn't produced by
        # this scrape run gets preserved with its last-known prices.  This is the
        # single rule that prevents items from disappearing - regardless of whether
        # they failed to scrape, are not in the Excel, or were added manually via
        # the UI.  Items with pinned URLs are already in the shopping list (added
        # earlier) so they will have been re-scraped fresh; everything else just
        # keeps its previous data until a future run can reach it.
        scraped_names = {i["list_item"] for i in items_output}
        still_not_found = []
        for name, ex in existing_map.items():
            if name in scraped_names:
                continue  # already in output - fresh data takes priority
            has_ww = (ex.get("woolworths") or {}).get("price") not in (None, 0, 0.0)
            has_co = (ex.get("coles") or {}).get("price") not in (None, 0, 0.0)
            if has_ww or has_co:
                items_output.append(ex)
                if name in not_found:
                    print(f"  [carry-forward] Restoring existing data for failed item: {name}")
                else:
                    print(f"  [carry-forward] Preserving item not in shopping list: {name}")
            elif name in not_found:
                still_not_found.append(name)
        not_found = [n for n in not_found if n in still_not_found]

        # Placeholder pass: any item that was in the shopping list but is STILL
        # absent from items_output (failed scrape AND no prior latest.json entry
        # to carry forward) gets a minimal placeholder so it is never silently
        # dropped.  The UI shows pending:true items as "Pending price fetch".
        final_names = {i["list_item"] for i in items_output}
        for name in shopping_list:
            if name in final_names:
                continue
            print(f"  [placeholder] No data for shopping-list item - writing stub: {name}")
            items_output.append({
                "list_item": name,
                "last_scraped": datetime.now(timezone.utc).isoformat(),
                "trip_count": purchase_history.get(name, {}).get("trip_count", 0),
                "price_history": [],
                "category": guess_category(name),
                "woolworths": None,
                "coles": None,
                "cheaper_store": None,
                "saving_per_item": None,
                "alternatives": [],
                "ww_price_history": [],
                "coles_price_history": [],
                "match_confidence": "none",
                "size_warning": False,
                "per_100_ww": None,
                "per_100_coles": None,
                "per_100_unit": "100g",
                "pending": True,
            })

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
        # Merge single-item validation entry into existing pending_validation
        merged_pv = existing.get("pending_validation", [])
        if single_item_ve:
            # Replace any existing entry for this item, then append
            merged_pv = [e for e in merged_pv if e.get("item") != single_item]
            merged_pv.append(single_item_ve)
        output = _build_output(
            all_items, existing.get("not_found_items", []), trigger,
            pending_validation=merged_pv if merged_pv else None,
            approved_prices=existing.get("approved_prices") or None,
        )
        print(f"Patched '{single_item}' into existing data ({len(all_items)} total items).")
    else:
        # Remove stale approvals: if a re-scraped item's price moved >5% from its approved
        # price, clear that store's approval so it can be re-flagged and re-approved.
        for result in items_output:
            name = result["list_item"]
            ap = existing_approved.get(name, {})
            if not ap:
                continue
            ww_p = (result.get("woolworths") or {}).get("price")
            co_p = (result.get("coles") or {}).get("price")
            if ww_p is not None and not _is_approved(ww_p, ap.get("ww")):
                ap.pop("ww", None)
            if co_p is not None and not _is_approved(co_p, ap.get("coles")):
                ap.pop("coles", None)
            if ap:
                existing_approved[name] = ap
            else:
                existing_approved.pop(name, None)

        if trigger == "scrape_archived":
            # Merge archived results back into the full item list so non-archived items
            # are not lost. Fresh scraped entries replace their existing counterparts;
            # archived items that couldn't be scraped are carried forward from existing data.
            freshly_scraped_names = {i["list_item"] for i in items_output}
            carry_archived = [existing_map[n] for n in not_found if n in existing_map]
            items_output = (
                [i for i in existing_map.values() if i["list_item"] not in freshly_scraped_names]
                + items_output
                + carry_archived
            )
            not_found = [n for n in not_found if n not in existing_map]
        else:
            # Normal/scheduled run. Archived items we refreshed this run are already
            # in items_output but the scrape result doesn't carry the archived flag -
            # re-stamp it so the archive view still recognises them.
            for _it in items_output:
                if _it.get("list_item") in archived_set:
                    _it["archived"] = True
            # Any archived item NOT refreshed this run (still fresh, or no history to
            # scrape) is carried forward so latest.json keeps full archive coverage.
            present = {i["list_item"] for i in items_output}
            for name in sorted(archived_set):
                if name in present:
                    continue
                ex = existing_map.get(name)
                if ex is not None:
                    items_output.append({**ex, "archived": True})
                    continue
                hist = purchase_history.get(name)
                if not hist:
                    continue
                items_output.append({
                    "list_item": name,
                    "archived": True,
                    "trip_count": hist.get("trip_count", 0),
                    "price_history": [e for e in hist.get("price_history", [])
                                      if e.get("date", "") not in ("", "1970-01-01", None)],
                    "category": guess_category(name),
                    "woolworths": None,
                    "coles": None,
                    "cheaper_store": None,
                    "saving_per_item": None,
                    "ww_price_history": [],
                    "coles_price_history": [],
                })

        # Merge by item name: new entries replace old ones for the same item (last scrape wins)
        merged_pv_dict = {**existing_pv, **{e["item"]: e for e in new_validation_entries}}
        # Remove items that were scraped cleanly this run (no new validation entry)
        scraped_this_run = {i["list_item"] for i in items_output}
        new_entry_names = {e["item"] for e in new_validation_entries}
        for name in scraped_this_run - new_entry_names:
            merged_pv_dict.pop(name, None)
        merged_pv = list(merged_pv_dict.values())
        output = _build_output(
            items_output, not_found, trigger,
            pending_validation=merged_pv if merged_pv else None,
            approved_prices=existing_approved if existing_approved else None,
        )
        s = output["summary"]
        print(f"\nDone. {len(items_output)} items compared, {len(not_found)} not found.")
        print(f"Woolworths total: ${s['total_woolworths']:.2f} | Coles total: ${s['total_coles']:.2f}")

    # Drop any stale alias duplicates before publishing (e.g. an old product name
    # that has since been merged into a canonical "Woolworths …" name).
    output["items"] = _purge_alias_items(output["items"])

    # latest.json is served to every page on every load - minify it.
    with open(latest_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))
    # Dated snapshot is a local, gitignored archive - keep it human-readable.
    with open(os.path.join(DATA_DIR, f"{datetime.now().strftime('%Y-%m-%d')}.json"), "w") as f:
        json.dump(output, f, indent=2)


if __name__ == "__main__":
    trigger = sys.argv[1] if len(sys.argv) > 1 else "manual"
    single_item = sys.argv[2].strip() if len(sys.argv) > 2 else ""
    ww_url = sys.argv[3].strip() if len(sys.argv) > 3 else ""
    coles_url = sys.argv[4].strip() if len(sys.argv) > 4 else ""
    asyncio.run(scrape(trigger, single_item=single_item, ww_url=ww_url, coles_url=coles_url))
