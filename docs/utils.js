// ── utils.js — Shared utilities for PriceWatch
// SINGLE SOURCE OF TRUTH for trend position, hot deal detection, and sorting
// Both app.js (index.html) and hot-deals.html load this file before their own code
// Do NOT redefine these functions elsewhere or divergence will occur

// ── HTML escape ─────────────────────────────────────────────────────────────
// Escape a value for safe interpolation into an innerHTML template. Store-scraped
// product names and user-typed strings (search, renames) are untrusted: a name
// containing "<" or "&" both breaks rendering AND is an XSS vector (the GitHub
// token in localStorage is the prize). Use esc() for TEXT content and escAttr()
// inside a double-quoted attribute (escAttr also neutralises the quote). Numbers
// from fmt()/toFixed() and hardcoded markup never need escaping.
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ── Per-100g / per-100ml price ─────────────────────────────────────────────
// Compute per-100g or per-100ml price from a product result object.
// Prioritises size extracted from the product name (reliable for pack goods)
// over the store-scraped cup price (which is often wrong for Coles packs).
function clientPer100(result) {
  if (!result || result.price == null) return { value: null, label: '100g' };
  const price = result.price;
  const name  = result.name || '';

  // Strategy 1: extract size from product name
  const kgM = name.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kgM) { const g = +kgM[1] * 1000; return { value: +(price * 100 / g).toFixed(2), label: '100g' }; }
  const gM = name.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gM && +gM[1] > 0) return { value: +(price * 100 / +gM[1]).toFixed(2), label: '100g' };
  const lM = name.match(/(\d+(?:\.\d+)?)\s*l(?:it(?:re|er)s?)?\b(?!\w)/i);
  if (lM) { const ml = +lM[1] * 1000; return { value: +(price * 100 / ml).toFixed(2), label: '100ml' }; }
  const mlM = name.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (mlM && +mlM[1] > 0) return { value: +(price * 100 / +mlM[1]).toFixed(2), label: '100ml' };

  // Strategy 2: use store-provided cup price + unit (for loose/weight goods)
  const unit = (result.unit || '').toLowerCase().trim();
  const up   = result.unit_price;
  if (up != null && unit) {
    const uM = unit.match(/^(\d*\.?\d*)?\s*(g|kg|ml|l)\b/);
    if (uM) {
      let qty = parseFloat(uM[1]) || 1.0;
      const uom = uM[2];
      if (uom === 'kg') qty *= 1000;
      else if (uom === 'l') qty *= 1000;
      if (qty > 0) return { value: +(up * 100 / qty).toFixed(2), label: (uom === 'ml' || uom === 'l') ? '100ml' : '100g' };
    }
  }
  return { value: null, label: '100g' };
}

// ── Exclusion-key parsing ───────────────────────────────────────────────────
// One parser for pw_exclusions_v1 keys, which exist in three historical formats:
// bare numbers, bare strings ("3.50"), and store-prefixed strings ("ww:3.50" /
// "coles:3.50"). Returns a Set of "X.XX" price strings with prefixes stripped —
// for mixed WW+Coles series a price excluded at either store is dropped entirely
// (matches buildPriceBar's documented behaviour).
function exclPriceSet(exclKeys) {
  return new Set((exclKeys || []).map(k => {
    const s = String(k);
    return Number(s.includes(':') ? s.split(':')[1] : s).toFixed(2);
  }));
}

// ── Unified trend data source ──────────────────────────────────────────────
// Single series for both slider and sort: includes price_history + current prices.
function getTrendSeries(item) {
  // Include every observed price: Excel receipts (price_history) plus the scraped
  // WW and Coles histories. Previously only price_history was used, so items whose
  // lows live in ww_price_history (e.g. added from receipts) showed a too-high
  // trend minimum.
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ];
  // Honour the user's excluded history points (pw_exclusions_v1) here so the
  // sort ranks items by the same series the bar draws. loadExclusions() is a
  // function declaration in app.js/hot-deals.html — hoisted and available by
  // the time this actually runs (renders always happen after page scripts
  // finish loading), even though this file is included first.
  const excluded = exclPriceSet(loadExclusions()[item.list_item]);
  const histPrices = hist
    .map(h => Number(h.price))
    .filter(p => p > 0 && !excluded.has(p.toFixed(2)));
  const w = item.woolworths?.price, c = item.coles?.price;
  const prices = [...histPrices, w, c].filter(p => typeof p === 'number' && p > 0);
  const current = Math.min(
    w != null ? w : Infinity,
    c != null ? c : Infinity
  );
  return { prices, current: isFinite(current) ? current : null };
}

// ── Trend Position Calculation ──────────────────────────────────────────────
// Returns 0.0–1.0 where current best price sits in purchase-history range:
//   0.0 = at/below all-time low   (best deal, maximum savings)
//   0.5 = flat history or middle
//   1.0 = at/above all-time high  (worst deal, least savings)
//   999 = no usable history (sorts last)

function calcTrendPosition(item) {
  const { prices, current } = getTrendSeries(item);
  if (prices.length < 2 || current == null) return 999;
  const lo = Math.min(...prices), hi = Math.max(...prices);
  if (lo === hi) return 0.5;
  return Math.max(0, Math.min(1, (current - lo) / (hi - lo)));
}

// ── Trend Sort Comparator ──────────────────────────────────────────────────
// Sorts items by trend position (best value first on asc, worst value first on desc)
// Tiebreak: alphabetical item name for deterministic ordering

function sortByTrend(items, dir = 'asc') {
  return [...items].sort((a, b) => {
    const pa = calcTrendPosition(a);
    const pb = calcTrendPosition(b);
    const cmp = pa - pb;
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    return a.list_item.localeCompare(b.list_item);
  });
}

// ── Deal Quality ──────────────────────────────────────────────────────────
// A "hot deal" is a price that is meaningfully LOW relative to the item's own
// price history. The old rule (all-time-low within 1¢ OR bottom 20%) flagged
// trivial deals: an item that only ever sells $3.80–$3.90 hits its "all-time
// low" at $3.80, but that's a 2.6% range — not worth surfacing.
//
// getDealQuality() measures the DEPTH of the discount against the item's
// TYPICAL (median) historical price and requires the price to actually move
// over time before anything qualifies, so flat items drop out.
//
//   typical   = median of historical prices (the "usual" shelf price)
//   spread    = (hi - lo) / hi   — how much the price varies historically
//   dropPct   = (typical - currentBest) / typical — how far below usual we are
//   saveAmount= max(0, typical - currentBest) — $ saved vs the usual price
//
// Qualifies when the price varies enough (spread ≥ MIN_SPREAD) AND the current
// price is a real discount (dropPct ≥ MIN_DROP, or an all-time low). Ranking is
// by dropPct (deepest discount first).

const DEAL_MIN_SPREAD = 0.05;  // price must vary ≥5% historically to count
const DEAL_MIN_DROP   = 0.04;  // current must be ≥4% below the usual price

function _median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function getDealQuality(item, exclusions) {
  const empty = { qualifies: false };
  if (item.archived) return empty;

  // Historical (past) prices only — the "usual" price is what it cost before now.
  // exclPriceSet handles the "ww:X.XX"/"coles:X.XX" key format — the old inline
  // Number(p).toFixed(2) turned prefixed keys into "NaN", silently disabling
  // exclusions for hot-deal detection (an excluded bogus low still made a 🔥).
  const excludedSet = exclPriceSet(exclusions && exclusions[item.list_item]);
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].map(h => Number(h.price))
   .filter(p => p > 0 && !excludedSet.has(p.toFixed(2)));
  if (hist.length < 2) return empty;

  const wwP = item.woolworths?.price;
  const coP = item.coles?.price;
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return empty;
  const store = (coP != null && coP <= (wwP ?? Infinity)) ? 'coles' : 'woolworths';

  const lo = Math.min(...hist), hi = Math.max(...hist);
  const typical = _median(hist);
  const spread = hi > 0 ? (hi - lo) / hi : 0;
  const dropPct = typical > 0 ? (typical - currentBest) / typical : 0;
  const saveAmount = Math.max(0, typical - currentBest);
  const isAllTimeLow = currentBest <= lo + 0.01;

  const qualifies = spread >= DEAL_MIN_SPREAD && (dropPct >= DEAL_MIN_DROP || isAllTimeLow);

  // Cross-store gap (secondary "savings": buying at the cheaper store vs the other)
  const otherPrice = store === 'woolworths' ? coP : wwP;
  const savingPct = (otherPrice != null && otherPrice > 0)
    ? (otherPrice - currentBest) / otherPrice : 0;

  const reason = isAllTimeLow
    ? '🏆 All-time low'
    : `↓ ${Math.round(dropPct * 100)}% below usual`;

  return {
    qualifies, store, price: currentBest, otherPrice,
    typical, lo, hi, spread, dropPct, saveAmount, isAllTimeLow,
    savingPct, reason,
  };
}

// Pass the pw_exclusions_v1 map so the 🔥 filter/badges agree with the
// Hot Deals page (getHotDealItems), which always applies exclusions.
function isHotDeal(item, exclusions) {
  return getDealQuality(item, exclusions).qualifies;
}

// ── GitHub Contents-API JSON read/write ─────────────────────────────────────
// Single reader/writer for every synced data file (was 7 near-identical copies
// across app.js and hot-deals.html). githubPutJson GETs the fresh blob sha
// immediately before the PUT and retries once on 409 (stale sha from a
// concurrent writer). Base64 is unicode-safe both ways — plain btoa() throws on
// non-Latin-1 product names, and plain atob() mangles them on read. Throws on
// failure so each caller keeps its own reporting (alert / showSyncError /
// fire-and-forget). validate.html keeps its own githubPut: it threads a known
// sha end-to-end for its stale-read race fix, different semantics.
function _ghHeaders(s) {
  return { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}
async function githubGetJson(s, repoPath) {
  const res = await fetch(`https://api.github.com/repos/${s.user}/${s.repo}/contents/${repoPath}`, { headers: _ghHeaders(s) });
  if (!res.ok) return {};
  const meta = await res.json();
  if (!meta.content) return {};
  try { return JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))))); } catch { return {}; }
}
async function githubPutJson(s, repoPath, data, message) {
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/${repoPath}`;
  const headers = _ghHeaders(s);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const meta = getRes.ok ? await getRes.json() : {};
    const body = { message, content };
    if (meta.sha) body.sha = meta.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(body) });
  };
  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
  if (!putRes.ok) {
    const msg = await putRes.text().catch(() => String(putRes.status));
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg}`);
  }
}

// ── Category normalisation ──────────────────────────────────────────────────
// SINGLE map for every page (index, hot-deals, shopping-list). Covers the old
// scraper names AND the 2026-07 category consolidation (13 → 10: Bakery folded
// into Pantry, Frozen Foods + Ready Meals merged, Personal Care + Baby merged) —
// so stale latest.json values and old user overrides in pw_categories_v1 keep
// resolving to a live category instead of resurrecting a dead tab.
const CATEGORY_REMAP = {
  'Fruit':                  'Fruit & Veg',
  'Vegetables':             'Fruit & Veg',
  'Bakery':                 'Pantry',
  'Bread & Bakery':         'Pantry',
  'Spices & Herbs':         'Pantry',
  'Spreads & Dips':         'Pantry',
  'Nuts & Seeds':           'Pantry',
  'Frozen Foods':           'Frozen & Ready Meals',
  'Frozen':                 'Frozen & Ready Meals',
  'Ready Meals':            'Frozen & Ready Meals',
  'Snacks & Confectionery': 'Sweets',
  'Snacks':                 'Sweets',
  'Drinks':                 'Drinks & Alcohol',
  'Personal Care':          'Personal Care & Baby',
  'Baby':                   'Personal Care & Baby',
  'Health & Beauty':        'Personal Care & Baby',
};

// Per-item category corrections — applied after CATEGORY_REMAP, before user
// localStorage overrides win. These fix scraper mismatches without editing
// latest.json. SINGLE copy here so index, hot-deals and shopping-list agree
// (when only app.js had it, corrected items landed under their raw category
// on the Basket page's shopping mode).
const ITEM_CATEGORY_DEFAULTS = {
  // Bakery → correct
  'Essentials Domestic Wipes Roll':                               'Household',
  'Woolworths Fresh Continental Parsley Bunch':                   'Fruit & Veg',
  // Dairy & Eggs → correct (scraper matched by store section, not product type)
  'Ben & Jerry\'s Ice Cream Tub Chocolate Chip Cookie Dough':    'Frozen Foods',
  'Cadbury Dairy Milk Large Chocolate Block':                     'Sweets',
  'Cadbury Dairy Milk Top Deck Chocolate Block':                  'Sweets',
  'Continental Classics Cup A Soup Creamy Chicken With Croutons': 'Pantry',
  'KitKat Milk Chocolate Mini Bars Share Pack':                   'Sweets',
  'Maltesers Milk Chocolate Party Gift Box':                      'Sweets',
  'McVitie\'s Digestives Milk Chocolate':                        'Sweets',
  'McVitie\'s Hobnobs Milk Chocolate':                           'Sweets',
  'Pringles Sour Cream & Onion Potato Chips':                     'Sweets',
  'Snickers Milk Chocolate Party Share Bag':                      'Sweets',
  'Snickers Milk Chocolate Party Share Bag 20 Pieces':            'Sweets',
  'Woolworths Beef Porterhouse Steak & Butter':                   'Meat & Seafood',
  'Woolworths Butternut Pumpkin Cut':                             'Fruit & Veg',
  'Yumi\'s Eggplant Mediterranean Dip':                          'Pantry',
  // Fruit & Veg → correct
  'Baby Mum-Mum Organiic Rice Rusks Blueberry & Carrot':         'Baby',
  'Dolmio Extra Bolognese Tomato Pasta Sauce':                    'Pantry',
  'Macro Organic Natural Pumpkin Kernels':                        'Pantry',
  'Mutti Tomato Paste Double Concentrate':                        'Pantry',
  'Sam\'s Pantry Granola Pink Lady Apple & Cinnamon':             'Pantry',
  'Schweppes Lemon Lime Bitters Soft Drink Classic Mixers Bottle': 'Drinks & Alcohol',
  'Schweppes Orange Mango Natural Mineral Water Bottle':          'Drinks & Alcohol',
  'Twinings Honeybush, Orange & Mandarin':                        'Pantry',
  'Twinings Orange & Cinnamon Tea Bags Tea':                      'Pantry',
  // Meat & Seafood → correct
  'Continental Classics Cup A Soup Chicken With Lots Of Noodles': 'Pantry',
  // Other → correct
  'Hedy\'s Fresh Quiche Lorraine Chilled Meal':                   'Ready Meals',
  'Old El Paso Fajita Spice Mix Mexican Style':                   'Pantry',
  'Parsnip Fresh':                                                'Fruit & Veg',
  'Weet-Bix Little Kids Breakfast Cereal':                        'Baby',
  'Woolworths Garlic Heads CLOVE':                                'Fruit & Veg',
  // Pantry → correct
  'Baby Mum-Mum Snack Vegetable Rice Rusk':                      'Baby',
  'Strike Blue Toilet Cleaner Cistern Blocks':                    'Household',
  'Vevelle White 2 Ply Toilet Tissue':                            'Household',
  'Woolworths Dill Fresh Herb':                                   'Fruit & Veg',
};

function normalizeCategory(raw) {
  const c = (raw || '').trim() || 'Other';
  return CATEGORY_REMAP[c] || c;
}

// Canonical hot-deal list — the SINGLE source of truth shared by the main page
// (which only needs the COUNT) and the Hot Deals page (which renders the list).
// Both call this with the same inputs so the "🔥 N deals" number on the main
// page always equals the number of rows shown on the Hot Deals page.
//   opts.exclusions  — per-item excluded historical prices (pw_exclusions_v1)
//   opts.archivedSet — names archived in docs/data/archived_items.json
//   opts.priorities  — localStorage priorities (pw_priorities_v1); 'archive' hides
//   opts.minDropPct / opts.minStoreDiffPct — optional threshold overrides (the
//     Hot Deals sliders; both pages pass the same stored values so the main-page
//     count always equals the rows shown). Defaults reproduce the canonical
//     qualify rule exactly: drop ≥ DEAL_MIN_DROP (or all-time low), any store gap.
function getHotDealItems(items, opts) {
  opts = opts || {};
  const exclusions  = opts.exclusions  || {};
  const archivedSet = opts.archivedSet || new Set();
  const priorities  = opts.priorities  || {};
  const minDrop = opts.minDropPct      != null ? opts.minDropPct / 100      : DEAL_MIN_DROP;
  const minDiff = opts.minStoreDiffPct != null ? opts.minStoreDiffPct / 100 : 0;
  return (items || [])
    .filter(item =>
      !item.archived &&
      priorities[item.list_item] !== 'archive' &&
      !archivedSet.has(item.list_item))
    .map(item => ({ item, deal: getDealQuality(item, exclusions) }))
    .filter(({ deal }) =>
      deal.typical != null &&
      deal.spread >= DEAL_MIN_SPREAD &&
      // At the default threshold an all-time low always qualifies (canonical
      // rule); once the user RAISES the drop slider, ATL items must meet it too.
      (deal.dropPct >= minDrop || (deal.isAllTimeLow && minDrop <= DEAL_MIN_DROP)) &&
      deal.savingPct >= minDiff);
}

// Shared slider state for the two deal thresholds (Hot Deals page writes it,
// both pages read it so their numbers agree).
const DEAL_TUNE_DEFAULTS = { drop: Math.round(DEAL_MIN_DROP * 100), diff: 0 };
function loadDealTune() {
  try {
    const t = JSON.parse(localStorage.getItem('pw_hd_tune_v1') || 'null');
    if (t && typeof t.drop === 'number' && typeof t.diff === 'number') return t;
  } catch {}
  return { ...DEAL_TUNE_DEFAULTS };
}
