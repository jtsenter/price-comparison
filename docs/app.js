// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—';

// Strip "Woolworths " prefix for display. The underlying list_item key stays
// unchanged so price history and localStorage keys keep working.
const stripWW  = (name) => name.replace(/^Woolworths\s+/i, '');
const isMobile = () => window.innerWidth < 640;

const COLES_CDN = 'https://cdn.productimages.coles.com.au/productimages';

function resolveImgUrl(imgData) {
  if (!imgData) return '';
  if (typeof imgData === 'object' && imgData.uri)
    return COLES_CDN + imgData.uri;
  if (typeof imgData !== 'string') return '';
  if (imgData.includes('/_next/image')) {
    try {
      const inner = new URL(imgData).searchParams.get('url');
      if (inner) {
        const decoded = decodeURIComponent(inner);
        return (decoded.startsWith('/') && !decoded.includes('://')) ? COLES_CDN + decoded : decoded;
      }
    } catch {}
  }
  // Bare CDN path stored by scraper (e.g. /4/409499.jpg)
  if (imgData.startsWith('/') && !imgData.includes('://')) return COLES_CDN + imgData;
  return imgData;
}

function imgError(el, fallbackSrc) {
  if (fallbackSrc && el.src !== fallbackSrc) {
    el.onerror = () => imgError(el, '');
    el.src = fallbackSrc;
  } else {
    el.onerror = null;
    if      (el.classList.contains('mc-img'))   el.outerHTML = '<div class="mc-img-placeholder"></div>';
    else if (el.classList.contains('card-img')) el.outerHTML = '<div class="card-img-placeholder">No Photo</div>';
    else                                        el.outerHTML = '<div class="item-img-placeholder">No Photo</div>';
  }
}
const fmtUnit = (price, unit) => {
  if (price == null) return '';
  if (!unit) return `${fmt(price)}/unit`;
  // Suppress "1ea" display — it just means the whole pack and adds no info
  if (/^1\s*ea\b/i.test(unit.trim())) return '';
  const m = unit.match(/^\d*\.?\d*\s*(?:g|kg|ml|l|ea|pk|pack|each)\b/i);
  return m ? `${fmt(price)}/${m[0].trim()}` : fmt(price);
};

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

function daysSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// ── Dismissed diff warnings ──────────────────────────────────────────────────

function loadDismissedDiffs() {
  try { return JSON.parse(localStorage.getItem('pw_dismissed_diffs_v1') || '{}'); } catch { return {}; }
}
function saveDismissedDiffs(d) {
  localStorage.setItem('pw_dismissed_diffs_v1', JSON.stringify(d));
}
function isDiffDismissed(itemName, currentDiff) {
  const dismissed = loadDismissedDiffs()[itemName];
  if (dismissed == null) return false;
  return currentDiff <= dismissed * 1.10;
}
function dismissDiff(itemName, currentDiff) {
  const d = loadDismissedDiffs();
  d[itemName] = currentDiff;
  saveDismissedDiffs(d);
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const HOT_DEAL_TREND_THRESHOLD = 0.10;   // current price must be in bottom 10% of historical range
const DISCREPANCY_WARN_THRESHOLD = 0.31; // price diff % above which ⚠ is shown
const STALE_DATA_DAYS          = 5;      // days before "data is stale" banner appears
const STALE_PROGRESS_MS        = 3 * 60 * 1000; // ms with no progress update → ⚠ Stalled

// ── Overrides (edit name / URL) ──────────────────────────────────────────────

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_overrides_v1') || '{}'); } catch { return {}; }
}

function saveOverrides(obj) {
  localStorage.setItem('pw_overrides_v1', JSON.stringify(obj));
}

// Write url_overrides.json to the repo so the scraper uses pinned URLs on every run.
// overrides: the full pw_overrides_v1 localStorage object.
let _overridesSaving = false;
let _archivedSaving = false;

async function persistArchivedToRepo(s, archivedNames, message = 'chore: sync archived items list') {
  if (!s?.user || !s?.repo || !s?.token) return;
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/archived_items.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const content = btoa(JSON.stringify(archivedNames, null, 2) + '\n');

  // Always re-fetch SHA immediately before PUT; retry once on 409 (stale SHA from concurrent call)
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const shaJson = getRes.ok ? await getRes.json() : {};
    const putBody = { message, content };
    if (shaJson.sha) putBody.sha = shaJson.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(putBody) });
  };

  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut(); // retry with fresh SHA
  if (!putRes.ok) {
    const msg = await putRes.text().catch(() => String(putRes.status));
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg}`);
  }
}

// ── Watchlist persistence ─────────────────────────────────────────────────────

function loadWatchlistLocal() {
  try { return new Set(JSON.parse(localStorage.getItem('pw_watchlist_v1') || '[]')); } catch { return new Set(); }
}
function saveWatchlistLocal(set) {
  localStorage.setItem('pw_watchlist_v1', JSON.stringify([...set]));
}
async function persistWatchlistToRepo(names) {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) return;
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/watchlist.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const content = btoa(JSON.stringify(names, null, 2) + '\n');
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const meta = getRes.ok ? await getRes.json() : {};
    const body = { message: 'chore: sync watchlist', content };
    if (meta.sha) body.sha = meta.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(body) });
  };
  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
  // fire-and-forget — errors are silently ignored
}
async function initWatchlist() {
  _watchlist = loadWatchlistLocal();
  try {
    const res = await fetch(`data/watchlist.json?t=${Date.now()}`);
    if (res.ok) {
      const names = await res.json();
      if (Array.isArray(names)) { _watchlist = new Set(names); saveWatchlistLocal(_watchlist); }
    }
  } catch {}
}
function toggleWatchlist(itemName) {
  if (_watchlist.has(itemName)) _watchlist.delete(itemName);
  else _watchlist.add(itemName);
  saveWatchlistLocal(_watchlist);
  persistWatchlistToRepo([..._watchlist]); // fire-and-forget
  if (_lastData) renderPage(_lastData);
}

async function persistLatestJson(data, message = 'chore: update latest.json') {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) return;
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/latest.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
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
    const err = await putRes.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${putRes.status}`);
  }
}

async function persistUrlOverridesToRepo(s, overrides) {
  if (!s?.user || !s?.repo || !s?.token) return;
  // Build scraper format: {item: {ww_url, coles_url}} — skip display-name-only entries
  const scraperFmt = {};
  for (const [item, ov] of Object.entries(overrides)) {
    if (ov.wwUrl || ov.colesUrl) {
      scraperFmt[item] = {};
      if (ov.wwUrl)    scraperFmt[item].ww_url    = ov.wwUrl;
      if (ov.colesUrl) scraperFmt[item].coles_url = ov.colesUrl;
    }
  }
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/url_overrides.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const content = JSON.stringify(scraperFmt, null, 2) + '\n';
  const encoded = btoa(unescape(encodeURIComponent(content)));

  // Always re-fetch SHA immediately before PUT; retry once on 409 (stale SHA from concurrent call)
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const shaJson = getRes.ok ? await getRes.json() : {};
    const putBody = { message: 'Update URL overrides', content: encoded };
    if (shaJson.sha) putBody.sha = shaJson.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(putBody) });
  };

  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut(); // retry with fresh SHA
  if (!putRes.ok) {
    const msg = await putRes.text().catch(() => String(putRes.status));
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg}`);
  }
}

// ── Exclusions (price range manager) ────────────────────────────────────────

function loadExclusions() {
  try { return JSON.parse(localStorage.getItem('pw_exclusions_v1') || '{}'); } catch { return {}; }
}

function saveExclusions(obj) {
  localStorage.setItem('pw_exclusions_v1', JSON.stringify(obj));
}

// ── Priorities ───────────────────────────────────────────────────────────────

function loadPriorities() {
  try { return JSON.parse(localStorage.getItem('pw_priorities_v1') || '{}'); } catch { return {}; }
}
function savePriorities(obj) {
  localStorage.setItem('pw_priorities_v1', JSON.stringify(obj));
}

// ── Pending items (from "different item" in price history) ───────────────────

function loadPending() {
  try { return JSON.parse(localStorage.getItem('pw_pending_items_v1') || '[]'); } catch { return []; }
}
function savePending(arr) {
  localStorage.setItem('pw_pending_items_v1', JSON.stringify(arr));
}

function updateImportBadge() {
  const btn = $('importBtn');
  if (!btn) return;
  let badge = btn.querySelector('.import-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'import-badge';
    btn.appendChild(badge);
  }
  const count = loadPending().length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-flex' : 'none';
}

// ── Unit quantity overrides ──────────────────────────────────────────────────

function loadUnitOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_units_v1') || '{}'); } catch { return {}; }
}
function saveUnitOverrides(obj) {
  localStorage.setItem('pw_units_v1', JSON.stringify(obj));
}

// ── Category overrides ───────────────────────────────────────────────────────

const KNOWN_CATEGORIES = [
  'Fruit & Veg', 'Dairy & Eggs', 'Meat & Seafood', 'Bakery', 'Frozen Foods',
  'Pantry', 'Drinks & Alcohol', 'Sweets', 'Personal Care', 'Household', 'Baby', 'Ready Meals',
];

function loadCategoryOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_categories_v1') || '{}'); } catch { return {}; }
}
function saveCategoryOverrides(obj) {
  localStorage.setItem('pw_categories_v1', JSON.stringify(obj));
}

// ── Item analysis data (loaded from data/item_analysis.json) ─────────────────

let _itemAnalysis = {};

async function loadItemAnalysis() {
  try {
    const res = await fetch(`data/item_analysis.json?t=${Date.now()}`);
    if (res.ok) _itemAnalysis = await res.json();
  } catch {}
}

function getAnalysisData(itemName) {
  return _itemAnalysis[itemName] || {};
}

function getPriority(itemName) {
  const p = loadPriorities()[itemName];
  if (p) return p;  // explicit user override always wins
  const d = getAnalysisData(itemName);
  const trips = d.trip_count || 0;
  if (trips >= 7) return 'weekly';
  if (trips >= 3) return 'monthly';
  return d.priority || 'rare';
}

function getUnits(itemName) {
  const ov = loadUnitOverrides()[itemName];
  if (ov != null) return ov;
  const qty = getAnalysisData(itemName).avg_qty;
  return qty != null ? Math.round(qty) : 1;
}

// ── Category normalisation ────────────────────────────────────────────────────

const CATEGORY_REMAP = {
  // old scraper names → new names
  'Fruit':                  'Fruit & Veg',
  'Vegetables':             'Fruit & Veg',
  'Bread & Bakery':         'Bakery',
  'Frozen':                 'Frozen Foods',
  'Snacks & Confectionery': 'Sweets',
  'Snacks':                 'Sweets',
  'Drinks':                 'Drinks & Alcohol',
  'Health & Beauty':        'Personal Care',
  // flatten sub-categories into parent
  'Spices & Herbs':         'Pantry',
  'Spreads & Dips':         'Pantry',
  'Nuts & Seeds':           'Pantry',
};

function getCategory(item) {
  const ov = loadCategoryOverrides()[item.list_item];
  if (ov) return ov;
  const c = (item.category || '').trim();
  return CATEGORY_REMAP[c] || c || 'Other';
}

// ── Filter state ─────────────────────────────────────────────────────────────

let _activePriority = 'all';
let _showHotOnly = false;
let _storeFilter = 'all';
let _showPricesOnly = false;
let _searchQuery = '';
let _watchlist = new Set(); // loaded on boot from localStorage + watchlist.json
let _viewMode = localStorage.getItem('pw_view_mode') || 'table'; // 'table' | 'card'

// ── Bulk selection ────────────────────────────────────────────────────────────

let _checkedItems = new Set();

function updateBulkBar() {
  const bar = $('bulkBar');
  if (!bar) return;
  const count = _checkedItems.size;
  bar.style.display = count > 0 ? 'flex' : 'none';
  const el = $('bulkCount');
  if (el) el.textContent = `${count} item${count !== 1 ? 's' : ''} selected`;
}

// ── Column order & widths ────────────────────────────────────────────────────

const DEFAULT_COL_ORDER = ['name', 'trend', 'priority', 'ww', 'coles', 'cheaper', 'pct', 'saving', 'units', 'trips', 'category', 'last_scraped', 'ww_total', 'coles_total'];

let _colOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('pw_col_order'));
    if (Array.isArray(saved) && saved.every(c => DEFAULT_COL_ORDER.includes(c))) {
      const newCols = DEFAULT_COL_ORDER.filter(c => !saved.includes(c));
      if (!newCols.length) return saved;
      const result = [...saved];
      // Insert 'trend' after 'name' rather than appending to end
      if (newCols.includes('trend')) {
        const nameIdx = result.indexOf('name');
        result.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, 'trend');
        newCols.splice(newCols.indexOf('trend'), 1);
      }
      return newCols.length ? [...result, ...newCols] : result;
    }
  } catch {}
  return [...DEFAULT_COL_ORDER];
})();

const DEFAULT_COL_WIDTHS = {
  name:         340,
  priority:      90,
  ww:            85,
  coles:         85,
  cheaper:       90,
  pct:           80,
  saving:       110,
  units:         80,
  trips:         65,
  category:     110,
  last_scraped: 130,
  ww_total:      95,
  coles_total:  100,
};

const DEFAULT_COL_VISIBILITY = {
  name: true, trend: true, priority: true, ww: true, coles: true,
  cheaper: true, pct: true, saving: true, units: true, trips: false,
  category: false, last_scraped: false, ww_total: false, coles_total: false,
};

let _colVisibility = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('pw_col_vis'));
    if (saved && typeof saved === 'object') return { ...DEFAULT_COL_VISIBILITY, ...saved };
  } catch {}
  return { ...DEFAULT_COL_VISIBILITY };
})();

let _colWidths = (() => {
  try { return JSON.parse(localStorage.getItem('pw_col_widths')) || {}; } catch { return {}; }
})();

function saveColOrder()      { localStorage.setItem('pw_col_order', JSON.stringify(_colOrder)); }
function saveColWidths()     { localStorage.setItem('pw_col_widths', JSON.stringify(_colWidths)); }
function saveColVisibility() { localStorage.setItem('pw_col_vis', JSON.stringify(_colVisibility)); }

// ── Column filters (per-column value sets) ───────────────────────────────────

let _colFilters = {};     // col → Set<string> of active values (undefined = all shown)
let _colNumFilters = {};  // col → { op1, val1, link, op2, val2 } for numeric columns

const NUMERIC_COLS = new Set(['ww', 'coles', 'pct', 'saving', 'units', 'trips', 'ww_total', 'coles_total']);

function getColNumericValue(col, item) {
  switch (col) {
    case 'ww':        return item.woolworths?.price ?? null;
    case 'coles':     return item.coles?.price ?? null;
    case 'pct': {
      const ww = item.woolworths?.price, co = item.coles?.price;
      if (ww == null || co == null) return null;
      return Math.abs(ww - co) / Math.max(ww, co) * 100;
    }
    case 'saving':    return item.saving_per_item ?? null;
    case 'units':     return getUnits(item.list_item);
    case 'trips':     return item.trip_count || 0;
    case 'ww_total':  return item.woolworths?.price != null ? item.woolworths.price * getUnits(item.list_item) : null;
    case 'coles_total': return item.coles?.price != null ? item.coles.price * getUnits(item.list_item) : null;
    default: return null;
  }
}

function applyNumFilter(val, { op1, val1 }) {
  if (val1 === '' || val1 == null) return true;
  const t = parseFloat(val1);
  if (isNaN(t)) return true;
  if (val == null) return false;
  switch (op1) {
    case '>':  return val > t;
    case '<':  return val < t;
    case '>=': return val >= t;
    case '<=': return val <= t;
    case '=':  return Math.abs(val - t) < 0.0001;
    case '≠':  return Math.abs(val - t) >= 0.0001;
    default:   return true;
  }
}

function getColValue(col, item) {
  switch (col) {
    case 'name':         return item.list_item;
    case 'priority':     return getPriority(item.list_item);
    case 'ww':           return item.woolworths?.price != null ? fmt(item.woolworths.price) : '(Missing)';
    case 'coles':        return item.coles?.price != null ? fmt(item.coles.price) : '(Missing)';
    case 'cheaper':      return item.cheaper_store || 'N/A';
    case 'pct': {
      const ww = item.woolworths?.price, co = item.coles?.price;
      if (ww == null || co == null) return '—';
      return Math.round(Math.abs(ww - co) / Math.max(ww, co) * 100) + '%';
    }
    case 'saving':       return item.saving_per_item > 0 ? fmt(item.saving_per_item) : '—';
    case 'trips':        return String(item.trip_count || 0);
    case 'units':        return String(getUnits(item.list_item));
    case 'category':     return getCategory(item);
    case 'last_scraped': return item.last_scraped
      ? new Date(item.last_scraped).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';
    case 'ww_total': {
      const v = item.woolworths?.price != null ? item.woolworths.price * getUnits(item.list_item) : null;
      return v != null ? fmt(v) : '—';
    }
    case 'coles_total': {
      const v = item.coles?.price != null ? item.coles.price * getUnits(item.list_item) : null;
      return v != null ? fmt(v) : '—';
    }
    default: return '';
  }
}

function resetColumns() {
  _colOrder      = [...DEFAULT_COL_ORDER];
  _colVisibility = { ...DEFAULT_COL_VISIBILITY };
  _colWidths     = {};
  _colFilters    = {};
  _colNumFilters = {};
  // Show the cheaper store's total column; hide the other
  if (_lastData) {
    const s = computeBannerStats(_lastData.items || []);
    if (s.cheaper_store === 'woolworths') {
      _colVisibility.ww_total    = true;
      _colVisibility.coles_total = false;
    } else if (s.cheaper_store === 'coles') {
      _colVisibility.ww_total    = false;
      _colVisibility.coles_total = true;
    }
    // equal/unknown → both hidden (default)
  }
  saveColOrder();
  saveColVisibility();
  saveColWidths();
  if (_lastData) renderPage(_lastData);
}

// Column header HTML (function so store-chips render fresh each time)
function colHeadHtml(col) {
  const fa = `<button class="col-filter-btn" data-filter-col="${col}" title="Filter">▾</button>`;
  const fa2 = (extra = '') => `${extra}${fa}<div class="col-resize-handle"></div>`;
  const hasFilter = _colFilters[col]?.size > 0 || !!_colNumFilters[col];
  function th(col, cls, label) {
    return `<th data-col="${col}" class="sortable${cls ? ' '+cls : ''}${hasFilter ? ' filter-active' : ''}">${label} <span class="sort-arrow"></span>${fa2()}</th>`;
  }
  switch (col) {
    case 'name':         return th('name', '', 'Product');
    case 'trend':        return th('trend', '', 'Trend');
    case 'ww':           return th('ww', '', '<span class="store-chip ww sm">W</span> WW');
    case 'coles':        return th('coles', '', '<span class="store-chip coles sm">C</span> Coles');
    case 'cheaper':      return th('cheaper', 'center-th', 'Best');
    case 'pct':          return th('pct', 'center-th', 'Diff');
    case 'saving':       return th('saving', 'right-th', 'Savings');
    case 'trips':        return th('trips', 'center-th', 'Buys');
    case 'priority':     return th('priority', 'center-th', 'Priority');
    case 'units':        return th('units', 'center-th', 'Qty');
    case 'category':     return th('category', '', 'Category');
    case 'last_scraped': return th('last_scraped', '', 'Last Scraped');
    case 'ww_total':     return th('ww_total', '', '<span class="store-chip ww sm">W</span> Total');
    case 'coles_total':  return th('coles_total', '', '<span class="store-chip coles sm">C</span> Total');
    default: return '';
  }
}

// ── Price history bar ────────────────────────────────────────────────────────

function buildPriceBar(itemName, priceHistory, currentPrice, factor = 1) {
  if (!priceHistory?.length || currentPrice == null) return '';

  const exclusions = loadExclusions();
  const excluded = new Set((exclusions[itemName] || []).map(p => Number(p).toFixed(2)));
  // Use raw history prices — they are already in the same monetary units (pack/shelf price)
  // as currentPrice. _ww_price_factor is only used for cheaper_store comparison in the scraper.
  const prices = priceHistory
    .map(p => p.price)
    .filter((p, i) => p > 0 && !excluded.has(Number(priceHistory[i].price).toFixed(2)));
  if (prices.length < 2) return '';

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  if (minP === maxP) {
    const safeItemName = itemName.replace(/"/g, '&quot;');
    let flatTrack;
    if (currentPrice < minP - 0.005) {
      // Current price is below all historical prices — green circle left
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-marker-off-left"></div><div class="price-bar price-bar-flat"></div></div>`;
    } else if (currentPrice > minP + 0.005) {
      // Current price is above all historical prices — red circle right
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-bar price-bar-flat"></div><div class="price-marker-off-right"></div></div>`;
    } else {
      flatTrack = `<div class="price-bar price-bar-flat"><div class="price-marker" style="left:50%"></div></div>`;
    }
    return `
    <div class="price-bar-outer">
      ${flatTrack}
      <div class="price-bar-labels price-bar-labels-flat"><span class="price-bar-always">${fmt(minP)}</span></div>
    </div>
    <button class="price-bar-manage" data-manage-item="${safeItemName}">Manage</button>`;
  }

  const rawPos = ((currentPrice - minP) / (maxP - minP)) * 100;
  const pos = Math.max(0, Math.min(100, rawPos));

  const counts = {};
  prices.forEach(p => { const k = p.toFixed(2); counts[k] = (counts[k] || 0) + 1; });
  const total = prices.length;

  const lines = Object.entries(counts)
    .sort(([a], [b]) => +a - +b)
    .map(([p, c]) => {
      const pct = Math.round((c / total) * 100);
      const bar = '█'.repeat(Math.round(pct / 10));
      return `$${p}  ${bar.padEnd(10)}  ${pct}% (${c}×)`;
    });

  const cheaperPct = Math.round(prices.filter(p => p > currentPrice).length / total * 100);
  lines.push('');
  lines.push(cheaperPct > 0
    ? `Now cheaper than ${cheaperPct}% of past prices ✓`
    : `Now at all-time low ✓`
  );

  const tooltip = lines.join('\n');
  const safeTooltip = tooltip.replace(/"/g, '&quot;');
  const safeItemName = itemName.replace(/"/g, '&quot;');

  // Off-range: green circle LEFT (price below min) or red circle RIGHT (price above max)
  let trackHtml;
  if (rawPos < 0) {
    trackHtml = `<div class="price-bar-track-wrap"><div class="price-marker-off-left"></div><div class="price-bar"></div></div>`;
  } else if (rawPos > 100) {
    trackHtml = `<div class="price-bar-track-wrap"><div class="price-bar"></div><div class="price-marker-off-right"></div></div>`;
  } else {
    trackHtml = `<div class="price-bar"><div class="price-marker" style="left:${pos.toFixed(1)}%"></div></div>`;
  }

  const allTimeLowBadge = rawPos === 0 ? '<span class="trophy-icon">🏆</span>' : '';
  return `
    <div class="price-bar-outer" data-tooltip="${safeTooltip}">
      ${trackHtml}
      <div class="price-bar-labels">
        <span>${fmt(minP)}${allTimeLowBadge}</span>
        <span>${fmt(maxP)}</span>
      </div>
    </div>
    <button class="price-bar-manage" data-manage-item="${safeItemName}">Manage</button>`;
}

// ── Tooltip (fixed, not clipped by overflow:hidden) ──────────────────────────

function initTooltip() {
  const tip = $('priceTooltip');
  if (!tip) return;

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.price-bar-outer[data-tooltip]');
    if (!el) return;
    tip.textContent = el.dataset.tooltip;
    tip.style.display = 'block';
  });

  document.addEventListener('mousemove', (e) => {
    if (tip.style.display === 'none') return;
    const margin = 12;
    const tipH = tip.offsetHeight;
    const tipW = tip.offsetWidth;
    let top = e.clientY - tipH - margin;
    let left = e.clientX - tipW / 2;
    if (top < 8) top = e.clientY + margin;
    if (left < 8) left = 8;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('.price-bar-outer[data-tooltip]');
    if (el) tip.style.display = 'none';
  });
}

// ── Per-item refresh ─────────────────────────────────────────────────────────

async function triggerItemRefresh(itemName, btn, urlOverrides) {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) {
    alert('Please configure Auto-update Setup first (button in the top-right).');
    return;
  }

  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  // Pre-flight: confirm the self-hosted runner is online before dispatching
  const { anyOnline } = await getRunnerStatus(s);
  if (!anyOnline) {
    showRunnerOfflineBanner();
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    return;
  }
  hideRunnerOfflineBanner();

  const inputs = { trigger: 'manual', item: itemName };
  if (urlOverrides?.wwUrl) inputs.ww_url = urlOverrides.wwUrl;
  if (urlOverrides?.colesUrl) inputs.coles_url = urlOverrides.colesUrl;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs }),
      }
    );

    if (res.status === 204) {
      if (btn) pollItemRefresh(s, btn, itemName);
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Error ${res.status}: ${err.message || 'Could not trigger refresh'}`);
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

async function pollItemRefresh(s, btn, itemName) {
  _pendingRefreshItem = itemName;
  if (_lastData) renderPage(_lastData);

  const dispatchedAt = new Date().toISOString();
  const apiBase = `https://api.github.com/repos/${s.user}/${s.repo}`;
  const apiHeaders = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' };

  const finish = (fresh) => {
    _pendingRefreshItem = null;
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
    if (fresh) renderPage(fresh);
    else if (_lastData) renderPage(_lastData);
  };

  // Phase 1: find the run created after dispatchedAt.
  // Multiple per-item refreshes run concurrently (different concurrency groups),
  // so we must track the specific run for this item, not just whatever is latest.
  let findAttempts = 0;
  const findRun = async () => {
    if (++findAttempts > 12) { finish(null); return; } // ~1 min to appear
    try {
      const res = await fetch(
        `${apiBase}/actions/workflows/scrape.yml/runs?per_page=10`,
        { headers: apiHeaders }
      );
      const data = await res.json();
      const run = data.workflow_runs?.find(r => r.created_at >= dispatchedAt);
      if (run) { setTimeout(() => waitForRun(run.id), 5000); return; }
    } catch (_) {}
    setTimeout(findRun, 5000);
  };

  // Phase 2: poll the specific run by ID until it completes.
  const waitForRun = async (runId) => {
    let waitAttempts = 0;
    const poll = async () => {
      if (++waitAttempts > 90) { finish(null); return; } // ~7.5 min max
      try {
        const res = await fetch(`${apiBase}/actions/runs/${runId}`, { headers: apiHeaders });
        const run = await res.json();
        if (run?.status === 'completed') {
          if (run.conclusion === 'success') {
            // Wait 2s for GitHub Pages CDN to pick up the push, then re-render
            setTimeout(async () => {
              try {
                const jr = await fetch(`data/latest.json?t=${Date.now()}`);
                finish(await jr.json());
              } catch (_) { finish(null); }
            }, 2000);
          } else {
            finish(null);
          }
          return;
        }
      } catch (_) {}
      setTimeout(poll, 5000);
    };
    poll();
  };

  setTimeout(findRun, 8000);
}

// ── Runner status ─────────────────────────────────────────────────────────────

/** Returns { anyOnline, runners } for self-hosted runners on the repo. */
async function getRunnerStatus(s) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/runners`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return { anyOnline: true, runners: [] }; // fail open — don't block on API error
    const data = await res.json();
    const selfHosted = (data.runners || []).filter(r =>
      r.labels?.some(l => l.name === 'self-hosted')
    );
    const anyOnline = selfHosted.length > 0 && selfHosted.some(r => r.status === 'online');
    return { anyOnline, runners: selfHosted };
  } catch {
    return { anyOnline: true, runners: [] }; // network error → fail open
  }
}

function showRunnerOfflineBanner() {
  let banner = $('runnerOfflineBanner');
  if (!banner) return;
  banner.classList.add('visible');
}

function hideRunnerOfflineBanner() {
  const banner = $('runnerOfflineBanner');
  if (banner) banner.classList.remove('visible');
}

/** Updates the stale-data banner text to mention the runner being offline. */
function updateStaleBannerForRunner(offline) {
  const banner = $('staleBanner');
  if (!banner) return;
  if (offline) {
    banner.innerHTML = `⚠️ Price data is more than ${STALE_DATA_DAYS} days old — scraper is currently <strong>offline</strong>. Prices cannot be updated until the Windows runner restarts.`;
  } else {
    banner.innerHTML = `⚠️ Price data is more than ${STALE_DATA_DAYS} days old — click <strong>Update Prices</strong> to refresh.`;
  }
}

/** Called by the ↺ Retry button in the offline banner. Re-checks runner status. */
async function retryRunnerCheck() {
  const btn = document.querySelector('.runner-retry-btn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  const s = loadSettings();
  const { anyOnline } = await getRunnerStatus(s);
  if (anyOnline) {
    hideRunnerOfflineBanner();
    updateStaleBannerForRunner(false);
  } else {
    if (btn) { btn.textContent = '↺ Retry'; btn.disabled = false; }
  }
}

// ── LocalStorage settings ────────────────────────────────────────────────────

function loadSettings() {
  return {
    user: localStorage.getItem('gh_user') || '',
    repo: localStorage.getItem('gh_repo') || '',
    token: localStorage.getItem('gh_token') || '',
  };
}

function saveSettings(user, repo, token) {
  localStorage.setItem('gh_user', user);
  localStorage.setItem('gh_repo', repo);
  localStorage.setItem('gh_token', token);
}

// ── Settings modal ───────────────────────────────────────────────────────────

function initSettingsModal() {
  const modal = $('settingsModal');
  if (!modal) return;

  const open = () => {
    const s = loadSettings();
    $('ghUser').value = s.user;
    $('ghRepo').value = s.repo;
    $('ghToken').value = s.token;
    modal.classList.add('open');
  };
  const close = () => modal.classList.remove('open');

  $('settingsBtn').addEventListener('click', open);
  $('modalClose').addEventListener('click', close);
  $('modalCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('modalSave').addEventListener('click', () => {
    saveSettings($('ghUser').value.trim(), $('ghRepo').value.trim(), $('ghToken').value.trim());
    close();
  });
}

// ── Edit name/URL modal ──────────────────────────────────────────────────────

let _editingItem = null;

function initEditModal() {
  const modal = $('editModal');
  if (!modal) return;

  const close = () => { modal.classList.remove('open'); _editingItem = null; };

  $('editModalClose').addEventListener('click', close);
  $('editCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  $('editSave').addEventListener('click', async () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    const prevOv = overrides[_editingItem.list_item] || {};
    const _normaliseUrl = u => { const s = u.trim(); return s && !s.startsWith('http') ? 'https://' + s : s; };
    const newWwUrl   = _normaliseUrl($('editWwUrl').value)   || undefined;
    const newCoUrl   = _normaliseUrl($('editColesUrl').value) || undefined;
    const urlChanged = newWwUrl !== (prevOv.wwUrl || _editingItem.woolworths?.url || '')
                    || newCoUrl !== (prevOv.colesUrl || _editingItem.coles?.url || '');

    overrides[_editingItem.list_item] = {
      displayName: $('editDisplayName').value.trim() || undefined,
      wwUrl:   newWwUrl,
      colesUrl: newCoUrl,
    };
    if (!overrides[_editingItem.list_item].displayName
      && !overrides[_editingItem.list_item].wwUrl
      && !overrides[_editingItem.list_item].colesUrl) {
      delete overrides[_editingItem.list_item];
    }
    saveOverrides(overrides);
    const item = _editingItem;
    close();
    if (_lastData) renderPage(_lastData);

    const s = loadSettings();
    if (s.user && s.repo && s.token) {
      if (_overridesSaving) return; // another PUT is in-flight; skip to avoid SHA race
      _overridesSaving = true;
      $('editSave').disabled = true;
      $('editReset').disabled = true;
      try {
        // Always sync all URL overrides to repo so the scraper never misses a pinned URL
        await persistUrlOverridesToRepo(s, overrides);
        // If a URL was added/changed, trigger an immediate single-item scrape
        if (urlChanged && (newWwUrl || newCoUrl)) {
          triggerItemRefresh(item.list_item, null, { wwUrl: newWwUrl, colesUrl: newCoUrl });
          alert(`Scrape triggered for "${item.list_item}" with the new URL.`);
        }
      } catch (e) {
        alert(`⚠ Could not save URL override to GitHub — check your token.\n${e.message}`);
      } finally {
        _overridesSaving = false;
        $('editSave').disabled = false;
        $('editReset').disabled = false;
      }
    }
  });

  $('editReset').addEventListener('click', async () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    delete overrides[_editingItem.list_item];
    saveOverrides(overrides);
    const s = loadSettings();
    if (s.user && s.repo && s.token) {
      if (_overridesSaving) { close(); if (_lastData) renderPage(_lastData); return; }
      _overridesSaving = true;
      $('editSave').disabled = true;
      $('editReset').disabled = true;
      try {
        await persistUrlOverridesToRepo(s, overrides);
      } catch (e) {
        alert(`⚠ Could not remove URL override from GitHub — check your token.\n${e.message}`);
      } finally {
        _overridesSaving = false;
        $('editSave').disabled = false;
        $('editReset').disabled = false;
      }
    }
    close();
    if (_lastData) renderPage(_lastData);
  });
}

function openEditModal(item) {
  _editingItem = item;
  const overrides = loadOverrides();
  const ov = overrides[item.list_item] || {};
  $('editDisplayName').value = ov.displayName || '';
  $('editWwUrl').value = ov.wwUrl || item.woolworths?.url || '';
  $('editColesUrl').value = ov.colesUrl || item.coles?.url || '';
  // Re-enable in case a previous write completed between modal open/close cycles
  if (!_overridesSaving) {
    $('editSave').disabled = false;
    $('editReset').disabled = false;
  }
  $('editModal').classList.add('open');
}

// ── Price History / Range Manager modal ─────────────────────────────────────

let _historyItem = null;

function initPriceHistoryModal() {
  const modal = $('priceHistoryModal');
  if (!modal) return;

  const close = () => { modal.classList.remove('open'); _historyItem = null; };

  $('priceHistoryClose').addEventListener('click', close);
  $('priceHistoryClose2').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  $('priceHistoryReset').addEventListener('click', () => {
    if (!_historyItem) return;
    const excl = loadExclusions();
    delete excl[_historyItem.list_item];
    saveExclusions(excl);
    openPriceHistoryModal(_historyItem);
    if (_lastData) renderPage(_lastData);
  });
}

function openPriceHistoryModal(item) {
  _historyItem = item;
  $('priceHistoryTitle').textContent = `Price History — ${stripWW(item.list_item)}`;

  const excl = loadExclusions();
  const excludedPrices = new Set((excl[item.list_item] || []).map(p => Number(p).toFixed(2)));

  // Build unified timeline.
  // All price_history entries are WW prices (Coles not tracked historically).
  const excelEntries = (item.price_history || []).map(e => ({
    date: e.date, ww: e.price, coles: null, source: 'excel',
  }));

  // Merge per-scrape WW and Coles by date (always scraped together)
  const wwMap = new Map((item.ww_price_history    || []).map(e => [e.date, e.price]));
  const coMap = new Map((item.coles_price_history || []).map(e => [e.date, e.price]));
  const scrapeDates = new Set([...wwMap.keys(), ...coMap.keys()]);
  const scrapeEntries = [...scrapeDates].map(d => ({
    date: d, ww: wwMap.get(d) ?? null, coles: coMap.get(d) ?? null, source: 'scrape',
  }));

  const allEntries = [...excelEntries, ...scrapeEntries]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const listEl = $('priceHistoryList');
  listEl.innerHTML = '';

  if (!allEntries.length) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-soft);font-size:13px;">No price history available.</div>';
    $('priceHistoryModal').classList.add('open');
    return;
  }

  // Column header
  const hdr = document.createElement('div');
  hdr.className = 'price-history-row';
  hdr.style.cssText = 'background:var(--bg);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;';
  hdr.innerHTML = `
    <span class="price-history-date" style="color:var(--text-soft)">Date</span>
    <span class="price-history-store-col"><span class="store-chip sm ww">W</span></span>
    <span class="price-history-store-col"><span class="store-chip sm coles">C</span></span>
    <span class="price-history-actions-col"></span>`;
  listEl.appendChild(hdr);

  allEntries.forEach(entry => {
    const wwKey    = entry.ww != null ? Number(entry.ww).toFixed(2) : null;
    const isExcluded = wwKey != null && excludedPrices.has(wwKey);
    const row = document.createElement('div');
    row.className = `price-history-row${isExcluded ? ' excluded' : ''}`;

    const wwHtml = entry.ww != null
      ? `<span class="price-history-price">${fmt(entry.ww)}</span>`
      : `<span style="color:var(--text-soft)">—</span>`;
    const coHtml = entry.coles != null
      ? `<span class="price-history-price" style="color:var(--coles)">${fmt(entry.coles)}</span>`
      : `<span style="color:var(--text-soft)">—</span>`;
    const btnHtml = wwKey != null ? `
      <button class="price-exclude-btn" data-price="${wwKey}">${isExcluded ? 'Include' : 'Exclude'}</button>
      <button class="price-diff-btn"    data-price="${wwKey}">Different item</button>` : '';

    row.innerHTML = `
      <span class="price-history-date">${entry.date || 'Unknown date'}</span>
      <span class="price-history-store-col">${wwHtml}</span>
      <span class="price-history-store-col">${coHtml}</span>
      <span class="price-history-actions-col">${btnHtml}</span>`;

    if (wwKey != null) {
      row.querySelector('.price-exclude-btn').addEventListener('click', () => {
        const ex = loadExclusions();
        const list = ex[item.list_item] || [];
        const priceNum = Number(wwKey);
        if (isExcluded) {
          ex[item.list_item] = list.filter(p => Number(p).toFixed(2) !== wwKey);
        } else {
          ex[item.list_item] = [...list, priceNum];
        }
        saveExclusions(ex);
        openPriceHistoryModal(item);
        if (_lastData) renderPage(_lastData);
      });

      row.querySelector('.price-diff-btn').addEventListener('click', () => {
        openDiffItemModal(item, wwKey);
      });
    }

    listEl.appendChild(row);
  });

  $('priceHistoryModal').classList.add('open');
}

// ── Priority filter ──────────────────────────────────────────────────────────

function showToast(msg, durationMs = 3000) {
  const toast = $('toastNotif');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, durationMs);
}

// ── Different Item modal ─────────────────────────────────────────────────────

let _diffItemContext = null; // { item, priceKey, priority }

function initDiffItemModal() {
  const modal = $('diffItemModal');
  if (!modal) return;
  const close = () => { modal.classList.remove('open'); _diffItemContext = null; };
  $('diffItemClose').addEventListener('click', close);
  $('diffItemCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('diffItemInput').addEventListener('input', () => {
    $('diffItemConfirm').disabled = $('diffItemInput').value.trim().length < 3;
  });
  $('diffItemConfirm').addEventListener('click', async () => {
    if (!_diffItemContext) return;
    const newName = $('diffItemInput').value.trim();
    if (newName.length < 3) return;
    const btn = $('diffItemConfirm');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      await doDiffItemAdd(newName, _diffItemContext);
      close();
    } catch (e) {
      showToast(`⚠ Error: ${e.message}`);
      btn.disabled = false;
      btn.textContent = 'Add Item & Scrape';
    }
  });
}

async function openDiffItemModal(item, priceKey) {
  // Step 1: mutate _lastData in memory — delete all entries with this price
  const priceNum = Number(priceKey);
  const liveItem = _lastData?.items?.find(i => i.list_item === item.list_item);
  if (liveItem) {
    liveItem.price_history       = (liveItem.price_history       || []).filter(e => e.price !== priceNum);
    liveItem.ww_price_history    = (liveItem.ww_price_history    || []).filter(e => e.price !== priceNum);
    liveItem.coles_price_history = (liveItem.coles_price_history || []).filter(e => e.price !== priceNum);
  }
  // Clean up exclusions for this price (no longer in history)
  const ex = loadExclusions();
  if (ex[item.list_item]) {
    ex[item.list_item] = ex[item.list_item].filter(p => Number(p).toFixed(2) !== priceKey);
    saveExclusions(ex);
  }

  // Step 1 cont: persist to GitHub — must succeed before dialog opens
  const s = loadSettings();
  if (s.user && s.repo && s.token) {
    try {
      await persistLatestJson(_lastData, `fix: remove misidentified price entries for "${item.list_item}"`);
    } catch (_e) {
      showToast('⚠ Could not save changes — check your GitHub token');
      if (_lastData) renderPage(_lastData);
      return; // do NOT open modal
    }
  }

  // Re-render table with cleaned history
  if (_lastData) renderPage(_lastData);
  const cleanItem = _lastData?.items?.find(i => i.list_item === item.list_item) || item;

  // Step 2: close price history modal, open diff-item modal
  $('priceHistoryModal').classList.remove('open');

  const priority = getPriority(item.list_item);
  _diffItemContext = { item: cleanItem, priceKey, priority };

  const badge = $('diffItemPriorityBadge');
  if (badge) {
    badge.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
    badge.className = `diff-item-priority-badge ${priority}`;
  }
  const priceEl = $('diffItemPrice');
  if (priceEl) priceEl.textContent = fmt(priceNum);

  $('diffItemInput').value = '';
  $('diffItemConfirm').disabled = true;
  $('diffItemConfirm').textContent = 'Add Item & Scrape';
  $('diffItemModal').classList.add('open');
  setTimeout(() => $('diffItemInput')?.focus(), 80);
}

async function doDiffItemAdd(newName, ctx) {
  const s = loadSettings();

  // Duplicate check
  const exists = _lastData?.items?.some(i => i.list_item.toLowerCase() === newName.toLowerCase());
  if (exists) {
    const proceed = window.confirm(`"${newName}" already exists in your list. Add it anyway?`);
    if (!proceed) return;
  }

  // Step 3a: add stub to _lastData so item appears immediately
  const stub = {
    list_item: newName,
    woolworths: null, coles: null,
    cheaper_store: null, saving_per_item: null,
    trip_count: 2,
    price_history: [], ww_price_history: [], coles_price_history: [],
    last_scraped: null, category: '',
  };
  if (_lastData?.items) _lastData.items.push(stub);

  // Step 3b: write to shopping_list.xlsx (no scrape triggered here)
  if (s.user && s.repo && s.token) {
    await writeNewItemToExcel(newName); // throws on failure, caught by caller
  }

  // Persist latest.json (now includes the new stub)
  if (s.user && s.repo && s.token) {
    await persistLatestJson(_lastData, `feat: add "${newName}" from different-item flow`);
  }

  if (_lastData) renderPage(_lastData);

  // Step 4: single-item scrape
  if (!s.user || !s.repo || !s.token) {
    showToast(`✓ "${newName}" saved locally — configure GitHub settings to scrape prices`);
    return;
  }
  const { anyOnline } = await getRunnerStatus(s);
  if (!anyOnline) {
    showRunnerOfflineBanner();
    showToast(`✓ "${newName}" added — update prices when runner is back online`);
    return;
  }
  hideRunnerOfflineBanner();

  const dispRes = await fetch(
    `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { trigger: 'manual', item: newName } }),
    }
  );
  if (dispRes.status === 204) {
    showToast(`✓ "${newName}" added — scraping prices now…`);
    pollItemRefresh(s, null, newName);
  } else {
    showToast(`✓ "${newName}" added — trigger a scrape manually when ready`);
  }
}

function initSearch() {
  const input = $('searchInput');
  const clear = $('searchClear');
  const wrap  = $('searchWrap');
  if (!input) return;
  input.addEventListener('input', () => {
    _searchQuery = input.value.trim();
    if (clear) clear.style.display = _searchQuery ? 'block' : 'none';
    if (_lastData) renderPage(_lastData);
  });
  if (clear) {
    clear.addEventListener('click', () => {
      _searchQuery = '';
      input.value = '';
      clear.style.display = 'none';
      if (_lastData) renderPage(_lastData);
    });
  }
  // Show the search bar (hidden until data loads, revealed in renderPage)
  if (wrap) wrap._ready = true;
}

function initPriorityFilter() {
  const container = $('priorityFilter');
  if (!container) return;

  container.querySelectorAll('.priority-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.priority;
      if (p) {
        // Watchlist toggles off when clicked while already active
        if (p === 'watchlist' && _activePriority === 'watchlist') {
          _activePriority = 'all';
          container.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
          container.querySelector('[data-priority="all"]')?.classList.add('active');
        } else {
          _activePriority = p;
          _showHotOnly = false;
          container.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          $('hotFilterBtn')?.classList.remove('active');
        }
        $('storeFilter').style.display = 'none';
        const scrapeArchBtn = $('scrapeArchivedBtn');
        if (scrapeArchBtn) scrapeArchBtn.style.display = _activePriority === 'archive' ? 'inline-flex' : 'none';
      }
      if (_lastData) renderPage(_lastData);
    });
  });

  const hotBtn = $('hotFilterBtn');
  if (hotBtn) {
    hotBtn.addEventListener('click', () => {
      _showHotOnly = !_showHotOnly;
      hotBtn.classList.toggle('active', _showHotOnly);
      $('storeFilter').style.display = _showHotOnly ? 'flex' : 'none';
      if (!_showHotOnly) _storeFilter = 'all';
      if (_lastData) renderPage(_lastData);
    });
  }

  const storeFilter = $('storeFilter');
  if (storeFilter) {
    storeFilter.querySelectorAll('.store-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _storeFilter = btn.dataset.store;
        storeFilter.querySelectorAll('.store-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (_lastData) renderPage(_lastData);
      });
    });
  }
}

function initPricesOnlyFilter() {
  $('pricesOnlyBtn')?.addEventListener('click', () => {
    _showPricesOnly = !_showPricesOnly;
    $('pricesOnlyBtn')?.classList.toggle('active', _showPricesOnly);
    if (_lastData) renderPage(_lastData);
  });
}

// ── Archive sync (module-level so initBulkBar callbacks can reach it) ─────────

let _archiveSyncTimer = null;
async function syncArchivedToGitHub() {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) return;
  if (_archivedSaving) return;
  const pr = loadPriorities();
  const archivedNames = Object.keys(pr).filter(k => pr[k] === 'archive');
  _archivedSaving = true;
  try {
    await persistArchivedToRepo(s, archivedNames);
  } catch (_) { /* silently ignore */ }
  finally { _archivedSaving = false; }
}
function scheduleArchiveSync() {
  clearTimeout(_archiveSyncTimer);
  _archiveSyncTimer = setTimeout(syncArchivedToGitHub, 2000);
}

// ── Bulk action bar ───────────────────────────────────────────────────────────

function initBulkBar() {
  const bar = $('bulkBar');
  if (!bar) return;

  $('bulkCategorySelect')?.addEventListener('change', () => {
    const cat = $('bulkCategorySelect').value;
    if (!cat) return;
    const ov = loadCategoryOverrides();
    _checkedItems.forEach(name => { ov[name] = cat; });
    saveCategoryOverrides(ov);
    $('bulkCategorySelect').value = '';
    if (_lastData) renderPage(_lastData);
  });

  $('bulkPrioritySelect')?.addEventListener('change', () => {
    const p = $('bulkPrioritySelect').value;
    if (!p) return;
    const pr = loadPriorities();
    _checkedItems.forEach(name => { pr[name] = p; });
    savePriorities(pr);
    $('bulkPrioritySelect').value = '';
    if (_lastData) renderPage(_lastData);
    scheduleArchiveSync();
  });

  $('bulkArchiveBtn')?.addEventListener('click', () => {
    const pr = loadPriorities();
    _checkedItems.forEach(name => { pr[name] = 'archive'; });
    savePriorities(pr);
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
    scheduleArchiveSync();
  });

  $('bulkDeselectBtn')?.addEventListener('click', () => {
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
  });
}

// ── Banner stats (priority-aware) ────────────────────────────────────────────

function computeBannerStats(items) {
  const exclusions = loadExclusions();
  const filtered = items.filter(item => {
    if (_activePriority === 'watchlist') {
      if (!_watchlist.has(item.list_item)) return false;
    } else {
      const p = getPriority(item.list_item);
      if (p === 'archive' || item.archived) {
        if (_activePriority !== 'archive') return false;
      } else {
        if (_activePriority === 'archive') return false;
        if (_activePriority !== 'all' && p !== _activePriority) return false;
      }
    }
    if (_activeCategory !== 'All' && getCategory(item) !== _activeCategory) return false;
    if (_showHotOnly && !isHotDeal(item, exclusions)) return false;
    // Only include items that have prices at both stores
    if (item.woolworths?.price == null || item.coles?.price == null) return false;
    return true;
  });
  const ww_avail = filtered.some(i => i.woolworths?.price != null);
  // Totals weighted by units
  const ww_total = filtered.reduce((s, i) => {
    const u = getUnits(i.list_item);
    return s + (i.woolworths?.price ?? 0) * u;
  }, 0);
  const co_total = filtered.reduce((s, i) => {
    const u = getUnits(i.list_item);
    return s + (i.coles?.price ?? 0) * u;
  }, 0);
  const total_saving = Math.abs(ww_total - co_total);
  let cheaper_store;
  if (!ww_avail) cheaper_store = 'coles_only';
  else if (co_total === 0) cheaper_store = 'ww_only';
  else if (ww_total < co_total) cheaper_store = 'woolworths';
  else if (co_total < ww_total) cheaper_store = 'coles';
  else cheaper_store = 'equal';
  return {
    total_woolworths: Math.round(ww_total * 100) / 100,
    total_coles: Math.round(co_total * 100) / 100,
    cheaper_store,
    ww_data_available: ww_avail,
    total_saving: Math.round(total_saving * 100) / 100,
    items_compared: filtered.length,
  };
}

// ── Category tabs ────────────────────────────────────────────────────────────

let _activeCategory = 'All';

function buildCategoryTabs(items) {
  const container = $('categoryTabs');
  if (!container) return;

  const counts = {};
  items.forEach(i => {
    const c = getCategory(i);
    counts[c] = (counts[c] || 0) + 1;
  });
  const top10 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c]) => c);
  const cats = ['All', ...top10];

  container.innerHTML = '';
  cats.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `category-tab${cat === _activeCategory ? ' active' : ''}`;
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      _activeCategory = cat;
      if (_lastData) renderPage(_lastData);
    });
    container.appendChild(btn);
  });
}

// ── Sticky ghost header ──────────────────────────────────────────────────────

let _stickyGhost = null;
let _stickyGhostTable = null;
let _stickyNeedsSync = false;

function initStickyHeader() {
  const ghost = document.createElement('div');
  ghost.className = 'sticky-header-ghost';
  ghost.style.display = 'none';
  document.body.appendChild(ghost);

  const ghostTable = document.createElement('table');
  ghost.appendChild(ghostTable);

  _stickyGhost = ghost;
  _stickyGhostTable = ghostTable;

  window.addEventListener('scroll', onStickyScroll, { passive: true });
  window.addEventListener('resize', () => {
    _stickyNeedsSync = true;
    if (_stickyGhost.style.display !== 'none') syncStickyNow();
  }, { passive: true });

  // Sync horizontal scroll from table-wrap
  document.querySelector('.table-wrap')?.addEventListener('scroll', (e) => {
    if (_stickyGhostTable) _stickyGhostTable.style.marginLeft = `-${e.target.scrollLeft}px`;
  }, { passive: true });
}

function syncStickyNow() {
  if (!_stickyGhost || !_stickyGhostTable) return;

  const realThead = document.querySelector('#tableHead');
  const tableWrap = document.querySelector('.table-wrap');
  if (!realThead || !tableWrap) return;

  // Clone thead, removing resize handles from ghost (they'd interfere)
  while (_stickyGhostTable.firstChild) _stickyGhostTable.removeChild(_stickyGhostTable.firstChild);
  const cloned = realThead.cloneNode(true);
  cloned.querySelectorAll('.col-resize-handle').forEach(h => h.remove());
  _stickyGhostTable.appendChild(cloned);

  // Sync widths
  const realThs = realThead.querySelectorAll('th');
  const ghostThs = cloned.querySelectorAll('th');
  realThs.forEach((th, i) => {
    if (!ghostThs[i]) return;
    const w = th.getBoundingClientRect().width;
    ghostThs[i].style.width = w + 'px';
    ghostThs[i].style.minWidth = w + 'px';
    ghostThs[i].style.maxWidth = w + 'px';
  });

  // Position ghost over the table-wrap
  const wrapRect = tableWrap.getBoundingClientRect();
  _stickyGhost.style.left = wrapRect.left + 'px';
  _stickyGhost.style.width = wrapRect.width + 'px';

  const realTable = realThead.closest('table');
  if (realTable) _stickyGhostTable.style.width = realTable.getBoundingClientRect().width + 'px';

  _stickyGhostTable.style.marginLeft = `-${tableWrap.scrollLeft}px`;

  // Attach sort + update sort arrow state
  updateSortHeaders(cloned);
  cloned.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', (e) => {
      if (e.target.closest('.col-filter-btn')) return;
      applyColSort(th.dataset.col);
    });
  });

  _stickyNeedsSync = false;
}

function onStickyScroll() {
  if (!_stickyGhost) return;
  const realThead = document.querySelector('#tableHead');
  if (!realThead) { _stickyGhost.style.display = 'none'; return; }

  const rect = realThead.getBoundingClientRect();
  const HEADER_H = document.querySelector('header')?.offsetHeight || 60;

  if (rect.bottom < HEADER_H) {
    if (_stickyNeedsSync) syncStickyNow();
    _stickyGhost.style.display = 'block';
    _stickyGhost.style.top = HEADER_H + 'px';
  } else {
    _stickyGhost.style.display = 'none';
  }
}

// ── Column drag/reorder ──────────────────────────────────────────────────────

let _dragSrcCol = null;

function initColumnDrag() {
  const thead = document.querySelector('#tableHead');
  if (!thead) return;

  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.draggable = true;

    th.addEventListener('dragstart', (e) => {
      if (e.target.classList.contains('col-resize-handle')) { e.preventDefault(); return; }
      _dragSrcCol = th.dataset.col;
      th.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', th.dataset.col);
    });

    th.addEventListener('dragend', () => {
      th.classList.remove('dragging');
      thead.querySelectorAll('th').forEach(t => t.classList.remove('drag-over'));
      _dragSrcCol = null;
    });

    th.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!_dragSrcCol || _dragSrcCol === th.dataset.col) return;
      e.dataTransfer.dropEffect = 'move';
      thead.querySelectorAll('th').forEach(t => t.classList.remove('drag-over'));
      th.classList.add('drag-over');
    });

    th.addEventListener('dragleave', () => th.classList.remove('drag-over'));

    th.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetCol = th.dataset.col;
      if (!_dragSrcCol || _dragSrcCol === targetCol) return;
      const srcIdx = _colOrder.indexOf(_dragSrcCol);
      const tgtIdx = _colOrder.indexOf(targetCol);
      if (srcIdx !== -1 && tgtIdx !== -1) {
        _colOrder.splice(srcIdx, 1);
        _colOrder.splice(tgtIdx, 0, _dragSrcCol);
        saveColOrder();
        if (_lastData) renderPage(_lastData);
      }
    });
  });
}

// ── Column resize ────────────────────────────────────────────────────────────

function initColumnResize() {
  const thead = document.querySelector('#tableHead');
  if (!thead) return;

  thead.querySelectorAll('.col-resize-handle').forEach(handle => {
    const th = handle.closest('th');
    if (!th) return;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      handle.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const colIdx = [...thead.querySelectorAll('th')].indexOf(th);

      function onMove(e) {
        const newW = Math.max(60, startW + e.clientX - startX);
        th.style.width = newW + 'px';
        th.style.minWidth = newW + 'px';
        document.querySelectorAll(`#tableBody tr td:nth-child(${colIdx + 1})`).forEach(td => {
          td.style.width = newW + 'px';
          td.style.minWidth = newW + 'px';
          td.style.maxWidth = newW + 'px';
        });
      }

      function onUp() {
        handle.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const col = th.dataset.col;
        if (col) { _colWidths[col] = th.getBoundingClientRect().width; saveColWidths(); }
        _stickyNeedsSync = true;
        if (_stickyGhost?.style.display !== 'none') syncStickyNow();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Double-click: auto-fit column to minimum content width
    handle.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const col = th.dataset.col;
      if (!col) return;
      const colIdx = [...thead.querySelectorAll('th')].indexOf(th);
      // Remove explicit constraints so browser can measure natural width
      th.style.width = '';
      th.style.minWidth = '';
      document.querySelectorAll(`#tableBody tr td:nth-child(${colIdx + 1})`).forEach(td => {
        td.style.width = '';
        td.style.minWidth = '';
        td.style.maxWidth = '';
      });
      requestAnimationFrame(() => {
        const measured = Math.max(40, Math.round(th.getBoundingClientRect().width));
        _colWidths[col] = measured;
        saveColWidths();
        _stickyNeedsSync = true;
        if (_stickyGhost?.style.display !== 'none') syncStickyNow();
      });
    });
  });
}

// ── Render table head (dynamic, respects _colOrder) ─────────────────────────

function getVisibleCols() {
  return _colOrder.filter(col => _colVisibility[col] !== false);
}

function renderTableHead() {
  const thead = $('tableHead');
  if (!thead) return;
  const visibleCols = getVisibleCols();
  thead.innerHTML = `<tr><th class="check-cell"><input type="checkbox" id="checkAll" title="Select all visible"></th>${visibleCols.map(colHeadHtml).join('')}<th class="actions-th"></th></tr>`;

  // Apply stored column widths (fall back to defaults)
  thead.querySelectorAll('th[data-col]').forEach(th => {
    const w = _colWidths[th.dataset.col] ?? DEFAULT_COL_WIDTHS[th.dataset.col];
    if (w) { th.style.width = w + 'px'; th.style.minWidth = w + 'px'; }
  });

  // Check-all handler
  const checkAllEl = thead.querySelector('#checkAll');
  if (checkAllEl) {
    checkAllEl.addEventListener('change', () => {
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.checked = checkAllEl.checked;
        if (checkAllEl.checked) _checkedItems.add(cb.dataset.item);
        else _checkedItems.delete(cb.dataset.item);
      });
      updateBulkBar();
    });
  }

  initSortHeaders();
  initColumnDrag();
  initColumnResize();
}

// ── Refresh / GitHub Actions trigger ─────────────────────────────────────────

let refreshCooldown = false;

async function triggerRefresh() {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) {
    alert('Please configure your GitHub settings first (⚙ Auto-update Setup button).');
    return;
  }
  if (refreshCooldown) return;
  _progressSeenThisSession = false;

  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">↻</span> Checking…';

  // Pre-flight: confirm the self-hosted runner is online before dispatching
  const { anyOnline } = await getRunnerStatus(s);
  if (!anyOnline) {
    showRunnerOfflineBanner();
    btn.disabled = false;
    btn.innerHTML = '↻ Update Prices';
    return;
  }
  hideRunnerOfflineBanner();
  btn.innerHTML = '<span class="spin">↻</span> Updating…';

  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (res.status === 204) {
      // Show progress strip immediately — don't wait for scraper to push data
      _progressDismissed = false;
      const strip = $('scrapeStrip');
      if (strip) {
        strip.style.display = 'flex';
        strip.classList.remove('stale');
        $('scrapeStripLabel').textContent = 'Waiting for scraper to start…';
        $('scrapeStripFill').style.width = '0%';
        $('scrapeStripPct').textContent = '0%';
        const retryBtn = $('scrapeStripRetry');
        if (retryBtn) retryBtn.style.display = 'none';
      }
      btn.innerHTML = '✓ Triggered — polling…';
      const dispatchedAt = new Date().toISOString();
      pollForCompletion(s, dispatchedAt);
      refreshCooldown = true;
      setTimeout(() => { refreshCooldown = false; }, 10 * 60 * 1000);
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`GitHub API error ${res.status}: ${err.message || 'Unknown error'}`);
      btn.disabled = false;
      btn.innerHTML = '↻ Update Prices';
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
    btn.disabled = false;
    btn.innerHTML = '↻ Update Prices';
  }
}

async function pollForCompletion(s, dispatchedAt) {
  const btn = $('refreshBtn');
  const apiBase = `https://api.github.com/repos/${s.user}/${s.repo}`;
  const apiHeaders = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' };
  let dataPollTimer;

  const finish = (success) => {
    clearInterval(dataPollTimer);
    if (success) {
      btn.innerHTML = '✓ Done — reloading…';
      setTimeout(() => {
        fetch(`data/latest.json?t=${Date.now()}`)
          .then(r => r.json())
          .then(d => { renderPage(d); btn.innerHTML = '↻ Update Prices'; btn.disabled = false; })
          .catch(() => location.reload());
      }, 2000);
    } else {
      btn.innerHTML = '⚠ Run failed';
      setTimeout(() => { btn.innerHTML = '↻ Update Prices'; btn.disabled = false; }, 4000);
    }
  };

  // Live data poll: re-renders the progress bar every 5 s while the scrape runs.
  // Skip renderPage until scrape_progress first appears — calling renderPage before
  // that would hide the manually-set "Waiting to start" strip (no scrape_progress
  // field in latest.json yet). Once seen, always call renderPage so completion
  // state renders correctly even when scrape_progress later disappears.
  dataPollTimer = setInterval(async () => {
    const fresh = await loadProgressData();
    if (!fresh) return;
    // Only accept scrape_progress from this run — stale data on the branch
    // (from a previous scrape) will have last_updated < dispatchedAt.
    if (fresh.scrape_progress && fresh.last_updated >= dispatchedAt) _progressSeenThisSession = true;
    if (!_progressSeenThisSession) return;
    renderPage(fresh);
  }, 5000);

  // Phase 1: find the run created after dispatch (~1 min timeout, 5 s polling)
  let findAttempts = 0;
  const findRun = async () => {
    if (++findAttempts > 12) { finish(false); return; }
    try {
      const r = await fetch(`${apiBase}/actions/workflows/scrape.yml/runs?per_page=10`, { headers: apiHeaders });
      const data = await r.json();
      const run = data.workflow_runs?.find(r => r.created_at >= dispatchedAt);
      if (run) { setTimeout(() => waitForRun(run.id), 5000); return; }
    } catch (_) {}
    setTimeout(findRun, 5000);
  };

  // Phase 2: poll the specific run by ID until completion (~7.5 min max)
  const waitForRun = async (runId) => {
    let waitAttempts = 0;
    const poll = async () => {
      if (++waitAttempts > 90) { finish(false); return; }
      try {
        const r = await fetch(`${apiBase}/actions/runs/${runId}`, { headers: apiHeaders });
        const run = await r.json();
        if (run?.status === 'completed') {
          finish(run.conclusion === 'success');
          return;
        }
      } catch (_) {}
      setTimeout(poll, 5000);
    };
    poll();
  };

  setTimeout(findRun, 8000);
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const res = await fetch(`data/latest.json?t=${Date.now()}`);
    if (!res.ok) throw new Error('not found');
    return await res.json();
  } catch { return null; }
}

// Fetch live progress data from the scrape-progress branch via the GitHub Contents API.
// Authenticated request avoids CDN caching delays that affect raw.githubusercontent.com.
async function loadProgressData() {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/latest.json?ref=scrape-progress&t=${Date.now()}`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return null;
    const meta = await res.json();
    return JSON.parse(atob(meta.content));
  } catch { return null; }
}

async function loadNameChanges() {
  try {
    const res = await fetch(`data/name_changes_detected.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Sort state ───────────────────────────────────────────────────────────────

let sortKeys = [{ col: 'trips', dir: 'desc' }];
let _mobileSortMode = 'trend-asc'; // 'trend-asc' | 'trend-desc' | 'default'

// Re-render when window crosses the 640px mobile breakpoint (e.g. device rotation)
let _prevIsMobile = isMobile();
let _breakpointResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_breakpointResizeTimer);
  _breakpointResizeTimer = setTimeout(() => {
    const nowMobile = isMobile();
    if (nowMobile !== _prevIsMobile) {
      _prevIsMobile = nowMobile;
      if (_lastData) renderPage(_lastData);
    }
  }, 150);
});
let _lastData = null;
let _prevPrices = {};
let _pendingRefreshItem = null;
let _preScrapeData = null;          // snapshot of data when scrape started
let _progressLastDone = null;       // last seen done count
let _progressLastChangeTime = null; // timestamp of last progress change
let _progressDismissed = false;     // user dismissed the header progress widget
let _progressSeenThisSession = false; // true once scrape_progress first appeared this trigger

const PRIORITY_ORDER = { weekly: 0, monthly: 1, rare: 2, archive: 3 };

function sortItems(items) {
  const exclusions = loadExclusions();
  let filtered = items.filter(item => {
    // Watchlist filter: show only watchlisted items; bypass archive/priority checks
    if (_activePriority === 'watchlist') return _watchlist.has(item.list_item);
    const p = getPriority(item.list_item);
    // Archived items (by priority or item.archived flag): only visible in archive view.
    // In archive view, show ONLY those items and nothing else.
    if (p === 'archive' || item.archived) {
      if (_activePriority !== 'archive') return false;
    } else {
      if (_activePriority === 'archive') return false;
      if (_activePriority !== 'all' && p !== _activePriority) return false;
    }
    // Hot deals filter
    if (_showHotOnly && !isHotDeal(item, exclusions)) return false;
    // Store filter (only active when hot filter is on)
    if (_showHotOnly && _storeFilter !== 'all') {
      if (_storeFilter === 'woolworths' && item.cheaper_store !== 'woolworths') return false;
      if (_storeFilter === 'coles' && item.cheaper_store !== 'coles') return false;
    }
    // Prices-only filter — require both stores to have a positive price
    if (_showPricesOnly) {
      const wwP = item.woolworths?.price;
      const coP = item.coles?.price;
      if (!(wwP != null && wwP > 0 && coP != null && coP > 0)) return false;
    }
    return true;
  });

  // Category filter
  if (_activeCategory !== 'All') {
    filtered = filtered.filter(i => getCategory(i) === _activeCategory);
  }

  // Per-column value (checkbox) filters
  for (const [col, vals] of Object.entries(_colFilters)) {
    if (!vals?.size) continue;
    filtered = filtered.filter(i => vals.has(getColValue(col, i)));
  }

  // Per-column numeric filters (AND'd with checkbox filters)
  for (const [col, nf] of Object.entries(_colNumFilters)) {
    if (!nf) continue;
    filtered = filtered.filter(i => {
      const numVal = getColNumericValue(col, i);
      return applyNumFilter(numVal, nf);
    });
  }

  // Search query filter
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    const ovr = loadOverrides();
    filtered = filtered.filter(i => {
      const name = (ovr[i.list_item]?.displayName || i.list_item).toLowerCase();
      return name.includes(q);
    });
  }

  function getSortVal(col, item) {
    switch (col) {
      case 'name':     return item.list_item.toLowerCase();
      case 'ww':       return item.woolworths?.price ?? Infinity;
      case 'coles':    return item.coles?.price ?? Infinity;
      case 'cheaper':  return item.cheaper_store ?? 'zzz';
      case 'saving':   return item.saving_per_item ?? -Infinity;
      case 'trips':    return item.trip_count || 0;
      case 'units':    return getUnits(item.list_item);
      case 'priority': return PRIORITY_ORDER[getPriority(item.list_item)] ?? 99;
      case 'pct': {
        const ww = item.woolworths?.price, co = item.coles?.price;
        return (ww != null && co != null) ? Math.abs(ww - co) / Math.max(ww, co) : -Infinity;
      }
      case 'trend': {
        const history = item.price_history;
        if (!history?.length) return null;
        // Apply same exclusions as buildPriceBar so sort matches the visual bar
        const _excl = loadExclusions();
        const _excluded = new Set((_excl[item.list_item] || []).map(p => Number(p).toFixed(2)));
        const prices = history
          .map(p => p.price)
          .filter((p, i) => p > 0 && !_excluded.has(Number(history[i].price).toFixed(2)));
        if (prices.length < 2) return null;
        const minP = Math.min(...prices), maxP = Math.max(...prices);
        const ref = item.cheaper_store === 'woolworths' ? item.woolworths?.price
                  : item.cheaper_store === 'coles'      ? item.coles?.price
                  : (item.coles?.price ?? item.woolworths?.price);
        if (ref == null) return null;
        // Bucket scheme: 0=below-range, 1=in-range(<0.5), 2=flat, 3=in-range(≥0.5), 4=above-range, null=no-data
        // Flat items sit at the 0.5 midpoint, between the below-centre and above-centre in-range halves
        if (minP === maxP) return [2, 0];  // all flat items → midpoint bucket, name tiebreaker for stability
        const pos = (ref - minP) / (maxP - minP);
        if (pos < 0)   return [0, pos];  // below range
        if (pos < 0.5) return [1, pos];  // in range, below midpoint
        if (pos > 1)   return [4, pos];  // above range
        return [3, pos];                  // in range, at/above midpoint (includes pos === 0.5 and pos === 1.0)
      }
      case 'category':     return getCategory(item).toLowerCase();
      case 'last_scraped': return item.last_scraped || '';
      case 'ww_total':     return (item.woolworths?.price ?? 0) * getUnits(item.list_item);
      case 'coles_total':  return (item.coles?.price ?? 0) * getUnits(item.list_item);
      default: return item.trip_count || 0;
    }
  }

  // Pre-compute sort values once to avoid repeated localStorage reads per comparison
  const sortCache = new Map(filtered.map(item => [item, sortKeys.map(({ col }) => getSortVal(col, item))]));

  return [...filtered].sort((a, b) => {
    const av = sortCache.get(a);
    const bv = sortCache.get(b);
    for (let i = 0; i < sortKeys.length; i++) {
      const { col, dir } = sortKeys[i];
      const mul = dir === 'asc' ? 1 : -1;
      const ai = av[i], bi = bv[i];
      // Trend: [bucket, value] pairs; null = no-data → always last
      if (col === 'trend') {
        const aNul = ai === null, bNul = bi === null;
        if (aNul && bNul) continue;
        if (aNul) return 1;
        if (bNul) return -1;
        const [aBucket, aVal] = ai;
        const [bBucket, bVal] = bi;
        if (aBucket !== bBucket) return (aBucket - bBucket) * mul;
        if (aVal !== bVal) return (aVal - bVal) * mul;
        continue;
      }
      if (ai < bi) return -1 * mul;
      if (ai > bi) return  1 * mul;
    }
    // Name tiebreaker: ensures identical sort values produce a stable, deterministic order
    return a.list_item.localeCompare(b.list_item);
  });
}

function updateSortHeaders(thead) {
  const container = thead || document.querySelector('#tableHead');
  if (!container) return;
  const primary = sortKeys[0];
  container.querySelectorAll('th[data-col]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.col === primary?.col) {
      th.classList.add('sort-active');
      arrow.textContent = primary.dir === 'asc' ? ' ↑' : ' ↓';
    } else {
      th.classList.remove('sort-active');
      arrow.textContent = '';
    }
  });
}

function initSortHeaders() {
  document.querySelectorAll('#tableHead th[data-col]').forEach(th => {
    th.addEventListener('click', (e) => {
      if (e.target.classList.contains('col-resize-handle')) return;
      if (e.target.closest('.col-filter-btn')) return;
      applyColSort(th.dataset.col);
    });
  });
}

function applyColSort(col) {
  if (sortKeys[0]?.col === col) {
    sortKeys[0] = { col, dir: sortKeys[0].dir === 'asc' ? 'desc' : 'asc' };
  } else {
    const defaultDir = col === 'name' || col === 'category' || col === 'trend' ? 'asc' : 'desc';
    sortKeys = [{ col, dir: defaultDir }, ...sortKeys.filter(k => k.col !== col)];
  }
  if (_lastData) renderPage(_lastData);
}

// ── Weekly special detection ─────────────────────────────────────────────────

function pricePercentile(prices, pct) {
  const sorted = [...prices].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * pct)];
}

function isHotDeal(item, exclusions) {
  const history = item.price_history;
  if (!history || history.length < 3) return false;
  const excluded = new Set((exclusions[item.list_item] || []).map(p => Number(p).toFixed(2)));
  const prices = history.map(h => h.price).filter((p, i) => p > 0 && !excluded.has(Number(history[i].price).toFixed(2)));
  if (prices.length < 3) return false;
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  if (minP === maxP) return false; // flat history — no real deal signal
  const ww = item.woolworths?.price;
  const co = item.coles?.price;
  // Check both stores independently — same logic as getDealInfo in hot-deals.html
  if (ww != null && (ww - minP) / (maxP - minP) < HOT_DEAL_TREND_THRESHOLD) return true;
  if (co != null && (co - minP) / (maxP - minP) < HOT_DEAL_TREND_THRESHOLD) return true;
  return false;
}

// ── Card view ─────────────────────────────────────────────────────────────────

function renderCards(items) {
  const grid = $('cardGrid');
  if (!grid) return;
  const overrides = loadOverrides();
  const exclusions = loadExclusions();
  const dismissed = (() => { try { return JSON.parse(localStorage.getItem('pw_dismissed_warns_v1') || '[]'); } catch { return []; } })();
  const parts = [];

  items.forEach(item => {
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;
    const ov = overrides[item.list_item] || {};
    const displayName = ov.displayName || stripWW(item.list_item);
    const cat = getCategory(item);
    const p = getPriority(item.list_item);
    const hotDeal = isHotDeal(item, exclusions);
    const wwUrl  = ov.wwUrl    || ww?.url || '';
    const coUrl  = ov.colesUrl || co?.url || '';
    const safeKey = item.list_item.replace(/"/g, '&quot;');

    const coImgSrc = resolveImgUrl(co?.image_url) || '';
    const wwImgSrc = resolveImgUrl(ww?.image_url) || '';
    const imgSrc = coImgSrc || wwImgSrc;
    const imgFallback = coImgSrc && wwImgSrc ? wwImgSrc : '';
    const imgHtml = imgSrc
      ? `<img class="card-img" src="${imgSrc}" alt="" loading="lazy" onerror="imgError(this,'${imgFallback}')">`
      : '<div class="card-img-placeholder">No Photo</div>';

    const prioOptions = ['weekly','monthly','rare'].map(v =>
      `<option value="${v}"${p===v?' selected':''}>${v[0].toUpperCase()+v.slice(1)}</option>`
    ).join('');

    // Prices
    const wwP100 = clientPer100(ww);
    const coP100 = clientPer100(co);
    const hotBadge = hotDeal ? ' <span class="hot-badge" title="Hot Deal!">🔥</span>' : '';

    let wwHtml;
    if (ww) {
      const pv = wwUrl ? `<a href="${wwUrl}" target="_blank" class="price-link">${fmt(ww.price)}</a>` : fmt(ww.price);
      const fire = hotDeal && cheaper === 'woolworths' ? hotBadge : '';
      const unit = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : fmtUnit(ww.unit_price, ww.unit);
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}</div>`;
    } else {
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span> <a href="https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}" target="_blank" class="search-link">Find →</a></div>`;
    }

    let coHtml;
    if (co) {
      const pv = coUrl ? `<a href="${coUrl}" target="_blank" class="price-link">${fmt(co.price)}</a>` : fmt(co.price);
      const fire = hotDeal && cheaper === 'coles' ? hotBadge : '';
      const unit = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : fmtUnit(co.unit_price, co.unit);
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}</div>`;
    } else {
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span> <a href="https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}" target="_blank" class="search-link">Find →</a></div>`;
    }

    const wwClass   = cheaper === 'woolworths' ? 'winner-ww' : '';
    const coClass   = cheaper === 'coles'      ? 'winner-coles' : '';
    const units     = getUnits(item.list_item);
    const savingAmt = item.saving_per_item != null && item.saving_per_item > 0
      ? fmt(item.saving_per_item * units) : null;
    const savingHtml = savingAmt
      ? `<div class="card-saving">${cheaper==='woolworths'?'<span class="store-chip ww sm">W</span>':'<span class="store-chip coles sm">C</span>'} Save ${savingAmt}</div>`
      : '';

    // Match warning
    let warnHtml = '';
    const mc = item.match_confidence;
    if (mc === 'none' && !dismissed.includes(item.list_item)) {
      warnHtml = ` <span class="match-warn match-warn-none" title="Could not match this item">⚠<button class="warn-dismiss" data-item="${safeKey}">✕</button></span>`;
    } else if ((mc === 'low' || item.size_warning) && !dismissed.includes(item.list_item)) {
      warnHtml = ` <span class="match-warn match-warn-low" title="Low-confidence match — verify these are the same product">⚠<button class="warn-dismiss" data-item="${safeKey}">✕</button></span>`;
    }

    const _allHistory2 = [...(item.price_history||[]), ...(item.ww_price_history||[]), ...(item.coles_price_history||[])];
    const bar = buildPriceBar(item.list_item, _allHistory2, cheaper==='woolworths' ? ww?.price : co?.price, item._ww_price_factor ?? 1);
    const isChecked = _checkedItems.has(item.list_item);
    const notFound = !ww && !co;

    parts.push(`<div class="item-card${notFound ? ' card-not-found' : ''}" data-item="${safeKey}">
      <div class="card-top">
        <div class="card-img-wrap">${imgHtml}</div>
        <div class="card-info">
          <div class="card-name">${displayName}${warnHtml}</div>
          <div class="card-cat">${cat}</div>
        </div>
        <div class="card-right">
          <input type="checkbox" class="row-check card-check" data-item="${safeKey}"${isChecked?' checked':''}>
          <select class="priority-select card-priority-sel" data-item="${safeKey}">
            <option value="">Priority…</option>${prioOptions}
          </select>
        </div>
      </div>
      <div class="card-prices">
        <div class="card-store ${wwClass}">${wwHtml}</div>
        <div class="card-vs">vs</div>
        <div class="card-store ${coClass}">${coHtml}</div>
      </div>
      ${savingHtml}
      ${bar ? `<div class="card-bar">${bar}</div>` : ''}
      <div class="card-footer">
        <button class="item-edit-btn card-btn" data-edit-item="${safeKey}" title="Edit name or URL">✎ Edit</button>
        <button class="item-refresh-btn card-btn" data-item="${safeKey}" title="Refresh this item's prices">↺ Refresh</button>
      </div>
    </div>`);
  });

  grid.innerHTML = parts.join('');
}

// ── Mobile card view (≤640px) ─────────────────────────────────────────────────

function renderMobileCards(items, data) {
  const container = $('mobileCards');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = 'flex';

  const exclusions = loadExclusions();
  const overrides  = loadOverrides();

  // Re-sort for mobile sort modes (desktop sortKeys sort already applied via sortItems())
  let displayItems = [...items];
  if (_mobileSortMode !== 'default') {
    const excl = loadExclusions();
    const getTrendPos = (item) => {
      const hist = item.price_history;
      if (!hist?.length) return 9999;
      const excluded = new Set((excl[item.list_item] || []).map(p => Number(p).toFixed(2)));
      const prices = hist.map(e => e.price)
        .filter((p, i) => p > 0 && !excluded.has(Number(hist[i].price).toFixed(2)));
      if (prices.length < 2) return 9999;
      const minP = Math.min(...prices), maxP = Math.max(...prices);
      if (minP === maxP) return 0.5;
      const ref = item.cheaper_store === 'woolworths' ? item.woolworths?.price
                : item.cheaper_store === 'coles'      ? item.coles?.price
                : (item.coles?.price ?? item.woolworths?.price);
      if (ref == null) return 9999;
      return (ref - minP) / (maxP - minP);
    };
    const mul = _mobileSortMode === 'trend-asc' ? 1 : -1;
    displayItems.sort((a, b) => mul * (getTrendPos(a) - getTrendPos(b)));
  }

  // Sort pill
  const sortLabels = { 'trend-asc': '⬆ Trend', 'trend-desc': '⬇ Trend', 'default': '↕ Default' };
  const pill = document.createElement('button');
  pill.id = 'mobileSortPill';
  pill.textContent = sortLabels[_mobileSortMode];
  pill.classList.toggle('active', _mobileSortMode !== 'default');
  pill.addEventListener('click', () => {
    const modes = ['trend-asc', 'trend-desc', 'default'];
    _mobileSortMode = modes[(modes.indexOf(_mobileSortMode) + 1) % modes.length];
    if (_lastData) renderPage(_lastData);
  });
  container.appendChild(pill);

  if (!displayItems.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:40px 20px;text-align:center;color:var(--text-soft);font-size:14px;';
    empty.textContent = 'No items match the current filters.';
    container.appendChild(empty);
    return;
  }

  displayItems.forEach(item => {
    const ww      = item.woolworths;
    const co      = item.coles;
    const cheaper = item.cheaper_store;
    const ov      = overrides[item.list_item] || {};
    const displayName = ov.displayName || stripWW(item.list_item);
    const cat     = getCategory(item);
    const priority = getPriority(item.list_item);
    const hotDeal  = isHotDeal(item, exclusions);
    const isWatchedMC = _watchlist.has(item.list_item);

    const coImgSrc = resolveImgUrl(co?.image_url) || '';
    const wwImgSrc = resolveImgUrl(ww?.image_url) || '';
    const imgSrc   = coImgSrc || wwImgSrc;
    const imgFallback = coImgSrc && wwImgSrc ? wwImgSrc : '';
    const imgHtml = imgSrc
      ? `<img class="mc-img" src="${imgSrc}" alt="" loading="lazy" onerror="imgError(this,'${imgFallback}')">`
      : '<div class="mc-img-placeholder"></div>';

    const currentRef = cheaper === 'woolworths' ? ww?.price
                     : cheaper === 'coles'      ? co?.price
                     : (co?.price ?? ww?.price);
    const _allHistoryMC = [...(item.price_history||[]), ...(item.ww_price_history||[]), ...(item.coles_price_history||[])];
    const barHtml = _allHistoryMC.length
      ? buildPriceBar(item.list_item, _allHistoryMC, currentRef, item._ww_price_factor ?? 1)
      : '';

    const wwP100 = clientPer100(ww);
    const coP100 = clientPer100(co);
    const wwUnit = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : '';
    const coUnit = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : '';

    const prioLabels = { weekly: 'Weekly', monthly: 'Monthly', rare: 'Rare' };
    const prioHtml = prioLabels[priority]
      ? `<span class="mc-priority ${priority}">${prioLabels[priority]}</span>` : '';
    const catHtml = cat ? `<span class="mc-cat">${cat}</span>` : '';

    const wwCheaper = cheaper === 'woolworths';
    const coCheaper = cheaper === 'coles';
    const saving    = item.saving_per_item;
    const borderCls = wwCheaper ? ' cheaper-ww' : coCheaper ? ' cheaper-coles' : '';

    const card = document.createElement('div');
    card.className = `mobile-card${borderCls}`;
    card.dataset.item = item.list_item;

    card.innerHTML = `
      <div class="mc-top">
        ${imgHtml}
        <div class="mc-name-wrap">
          <div class="mc-name">${displayName}</div>
          <div class="mc-badges">${catHtml}${prioHtml}</div>
        </div>
        <span class="mc-icons">
          ${isWatchedMC ? `<button class="mc-watch-btn active" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Remove from watchlist">👁</button>` : `<button class="mc-watch-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Add to watchlist">👁</button>`}
          ${hotDeal ? '<span class="mc-hot">🔥</span>' : ''}
        </span>
      </div>
      ${barHtml ? `<div class="mc-bar">${barHtml}</div>` : ''}
      <div class="mc-prices">
        <div class="mc-store-col">
          <div class="mc-store-label ww-col"><span class="store-chip sm ww">W</span> Woolworths</div>
          <div class="mc-price${wwCheaper ? ' cheaper' : ''}">${ww ? fmt(ww.price) : '—'}</div>
          ${wwUnit ? `<div class="mc-unit">${wwUnit}</div>` : ''}
        </div>
        <div class="mc-store-col">
          <div class="mc-store-label coles-col"><span class="store-chip sm coles">C</span> Coles</div>
          <div class="mc-price${coCheaper ? ' cheaper-c' : ''}">${co ? fmt(co.price) : '—'}</div>
          ${coUnit ? `<div class="mc-unit">${coUnit}</div>` : ''}
        </div>
      </div>
      ${ww && co ? `
      <div class="mc-summary">
        <span class="mc-winner-badge ${wwCheaper ? 'ww' : coCheaper ? 'coles' : 'equal'}">
          ${wwCheaper ? '✓ WW cheaper' : coCheaper ? '✓ Coles cheaper' : '= Same price'}
        </span>
        ${saving && saving > 0 ? `<span class="mc-saving">Save ${fmt(saving)}</span>` : ''}
      </div>` : ''}`;

    card.addEventListener('click', (e) => {
      // Watch button stops propagation so it doesn't also open the price history modal
      if (e.target.closest('.mc-watch-btn')) {
        toggleWatchlist(e.target.closest('.mc-watch-btn').dataset.item);
        return;
      }
      const fullItem = (_lastData?.items || []).find(i => i.list_item === item.list_item) || item;
      openPriceHistoryModal(fullItem);
    });

    container.appendChild(card);
  });
}

// ── Index page rendering ─────────────────────────────────────────────────────

function renderPage(data) {
  $('loading').style.display = 'none';
  // Reset mobile container on every render; renderMobileCards() re-shows it when on mobile
  const _mcEl = $('mobileCards');
  if (_mcEl) _mcEl.style.display = 'none';

  if (!data?.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Update Prices to fetch prices.';
    return;
  }

  if (daysSince(data.last_updated) > STALE_DATA_DAYS) $('staleBanner').classList.add('visible');

  // Always compute banner stats client-side so savings are units-weighted
  const s = computeBannerStats(data.items);
  const wwCard    = $('wwCard');
  const colesCard = $('colesCard');
  const wwTotalEl = $('wwTotal');

  wwCard.className    = 'store-card';
  colesCard.className = 'store-card';

  if (!s.ww_data_available) {
    wwTotalEl.innerHTML = '<span class="unavailable">Blocked by<br>Woolworths ⚠</span>';
    $('wwBadge').innerHTML = '<span class="blocked-note">Their site blocks automated price checks</span>';
    $('colesTotal').textContent = fmt(s.total_coles);
    $('colesBadge').innerHTML = '<span class="winner-badge only">Only available</span>';
    $('savingInfo').textContent = '';
  } else if (s.cheaper_store === 'woolworths') {
    wwCard.classList.add('winner-ww');
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('wwBadge').innerHTML    = '<span class="winner-badge ww">✓ Cheaper</span>';
    $('colesBadge').innerHTML = '';
    $('savingInfo').innerHTML = `<div class="saving-label">Basket saving</div><span class="saving-chip">${fmt(s.total_saving)}</span>`;
  } else if (s.cheaper_store === 'coles') {
    colesCard.classList.add('winner-coles');
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('colesBadge').innerHTML = '<span class="winner-badge coles">✓ Cheaper</span>';
    $('wwBadge').innerHTML    = '';
    $('savingInfo').innerHTML = `<div class="saving-label">Basket saving</div><span class="saving-chip">${fmt(s.total_saving)}</span>`;
  } else {
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('wwBadge').innerHTML = $('colesBadge').innerHTML = '';
    $('savingInfo').textContent = 'Same price at both stores';
  }

  const prog = data.scrape_progress;

  // ── Pre-scrape snapshot: keep all items visible while scraping ──
  if (prog) {
    if (!_preScrapeData) {
      // Take snapshot: prefer last full data set, fall back to current (may be partial)
      _preScrapeData = _lastData ?? data;
      _progressLastDone = prog.done;
      _progressLastChangeTime = Date.now();
    } else if (_preScrapeData) {
      if (prog.done !== _progressLastDone) {
        _progressLastDone = prog.done;
        _progressLastChangeTime = Date.now();
      }
    }
  } else {
    _preScrapeData = null;
    _progressLastDone = null;
    _progressLastChangeTime = null;
    _progressDismissed = false;
  }

  // ── Scrape strip (full-width row below header) ─────────────────
  const strip = $('scrapeStrip');
  if (strip) {
    if (prog && prog.total > 0 && !_progressDismissed) {
      const pct = Math.round((prog.done / prog.total) * 100);
      const isStale = _progressLastChangeTime && (Date.now() - _progressLastChangeTime > STALE_PROGRESS_MS);
      strip.style.display = 'flex';
      strip.classList.toggle('stale', isStale);
      $('scrapeStripLabel').textContent = isStale
        ? `⚠ Stalled at ${prog.done} of ${prog.total} — try refreshing`
        : pct === 0
          ? `Starting price refresh…`
          : `Refreshing prices… ${prog.done} of ${prog.total}`;
      $('scrapeStripFill').style.width = `${pct}%`;
      $('scrapeStripPct').textContent = `${pct}%`;
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = isStale ? 'inline-block' : 'none';
    } else {
      strip.style.display = 'none';
    }
  }

  const _uiPriorities = loadPriorities();
  const _renderExclusions = loadExclusions();
  const isUiArchived = (i) => i.archived || _uiPriorities[i.list_item] === 'archive';
  const totalNonArchived = (data.items || []).filter(i => !isUiArchived(i)).length;
  const pricedBoth = (data.items || []).filter(i => !isUiArchived(i) && i.woolworths?.price != null && i.coles?.price != null).length;
  const missingCount = totalNonArchived - pricedBoth;
  const coverageText = missingCount > 0
    ? `${pricedBoth}/${totalNonArchived} priced · ${missingCount} missing`
    : `${totalNonArchived} items`;
  const hotCount = (data.items || []).filter(i => !isUiArchived(i) && isHotDeal(i, _renderExclusions)).length;
  $('lastUpdated').innerHTML = `<span>Updated ${formatDate(data.last_updated)}</span><span>${coverageText}</span>${hotCount > 0 ? `<a href="hot-deals.html" class="hot-deals-link">🔥 ${hotCount} deal${hotCount !== 1 ? 's' : ''}</a>` : ''}`;
  $('banner').style.display = 'block';
  const _sw = $('searchWrap');
  if (_sw) _sw.style.display = '';

  _lastData = data;

  // Auto-poll progress while scraping
  if (data.scrape_progress) {
    window._progressNoDataStreak = 0; // reset streak whenever we see progress
    if (!window._progressPollTimer) {
      window._progressPollTimer = setInterval(async () => {
        const fresh = await loadData();
        if (!fresh) return;
        if (!fresh.scrape_progress) {
          // Require 3 consecutive no-progress responses before declaring done.
          // A single missing response could be a CDN hiccup or a between-push window.
          window._progressNoDataStreak = (window._progressNoDataStreak || 0) + 1;
          if (window._progressNoDataStreak >= 3) {
            clearInterval(window._progressPollTimer);
            window._progressPollTimer = null;
            window._progressNoDataStreak = 0;
            renderPage(fresh); // final render to hide bar
          }
          return; // don't hide bar yet
        }
        window._progressNoDataStreak = 0;
        if (fresh.scrape_progress?.done !== _lastData?.scrape_progress?.done) {
          renderPage(fresh);
        }
      }, 7000);
    }
  } else {
    if (window._progressPollTimer) {
      clearInterval(window._progressPollTimer);
      window._progressPollTimer = null;
    }
  }

  // Merge not-found items into the full display list (no prices for either store)
  const notFoundAsItems = (data.not_found_items || []).map(name => ({
    list_item: name,
    woolworths: null,
    coles: null,
    cheaper_store: null,
    saving_per_item: null,
    trip_count: 0,
    price_history: [],
    category: '',
  }));

  // While scraping, merge snapshot items so all products remain visible
  let allDisplayItems;
  if (_preScrapeData && prog) {
    // Start from snapshot (has everything), overwrite with freshly scraped data
    const merged = new Map([
      ...(_preScrapeData.items || []).map(i => [i.list_item, i]),
      ...(_preScrapeData.not_found_items || []).map(n => [n, { list_item: n, woolworths: null, coles: null, cheaper_store: null, saving_per_item: null, trip_count: 0, price_history: [], category: '' }]),
    ]);
    (data.items || []).forEach(i => merged.set(i.list_item, i));
    (data.not_found_items || []).forEach(n => merged.set(n, { list_item: n, woolworths: null, coles: null, cheaper_store: null, saving_per_item: null, trip_count: 0, price_history: [], category: '' }));
    allDisplayItems = [...merged.values()];
  } else {
    allDisplayItems = [...data.items, ...notFoundAsItems];
  }

  const priorities = loadPriorities();
  const categoryTabItems = _activePriority === 'archive'
    ? allDisplayItems.filter(i => i.archived || priorities[i.list_item] === 'archive')
    : _activePriority === 'watchlist'
      ? allDisplayItems.filter(i => _watchlist.has(i.list_item))
      : allDisplayItems.filter(i => !i.archived && priorities[i.list_item] !== 'archive');
  buildCategoryTabs(categoryTabItems);

  // Sync "Priced only" pill state (button is static HTML; click wired in initPricesOnlyFilter)
  $('pricesOnlyBtn')?.classList.toggle('active', _showPricesOnly);

  // ── View mode branch ───────────────────────────────────────────
  const sorted = sortItems(allDisplayItems);

  if (isMobile()) {
    renderMobileCards(sorted, data);
    return;
  }

  if (_viewMode === 'card') {
    $('tableContainer').style.display = 'none';
    renderTableHead(); // keeps column state consistent
    renderCards(sorted);
    const grid = $('cardGrid');
    if (grid) grid.style.display = sorted.length ? 'grid' : 'none';
    updateBulkBar();
    return;
  }

  $('cardGrid').style.display = 'none';
  renderTableHead();

  const tbody = $('tableBody');
  tbody.innerHTML = '';

  updateSortHeaders();

  if (!sorted.length) {
    const emptyMessages = {
      weekly:  { title: 'No weekly items', sub: 'Mark items as Weekly in the Priority column.' },
      monthly: { title: 'No monthly items', sub: 'Mark items as Monthly in the Priority column.' },
      rare:    { title: 'No rare items', sub: 'All items have been categorised.' },
      archive: { title: 'Nothing archived', sub: 'Archive items you no longer need to compare.' },
      all:     { title: 'No items match', sub: 'Try clearing filters or adding items via Import.' },
    };
    const msg = emptyMessages[_activePriority] || emptyMessages.all;
    tbody.innerHTML = `<tr><td colspan="${getVisibleCols().length + 2}"><div class="table-empty-state"><strong>${msg.title}</strong>${msg.sub}</div></td></tr>`;
    $('tableContainer').style.display = 'block';
    return;
  }

  const overrides = loadOverrides();

  sorted.forEach((item) => {
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;
    const ov = overrides[item.list_item] || {};

    const wwUrl  = ov.wwUrl    || ww?.url  || null;
    const coUrl  = ov.colesUrl || co?.url  || null;
    const displayName = ov.displayName || stripWW(item.list_item);

    const coImgSrc = resolveImgUrl(co?.image_url) || '';
    const wwImgSrc = resolveImgUrl(ww?.image_url) || '';
    const imgSrc = coImgSrc || wwImgSrc;
    const imgFallback = coImgSrc && wwImgSrc ? wwImgSrc : '';
    const imgHtml = imgSrc
      ? `<img class="item-img" src="${imgSrc}" alt="" loading="lazy" onerror="imgError(this,'${imgFallback}')" />`
      : '<div class="item-img-placeholder">No Photo</div>';

    const safeKey = item.list_item.replace(/"/g, '&quot;');
    const editBtn = `<button class="item-edit-btn" data-edit-item="${safeKey}" title="Edit name/URL">✎</button>`;

    // Price bar uses cheaper store's price as reference (or fallback)
    const currentRef = cheaper === 'woolworths' ? ww?.price : (cheaper === 'coles' ? co?.price : (co?.price ?? ww?.price));
    const _allHistory = [...(item.price_history||[]), ...(item.ww_price_history||[]), ...(item.coles_price_history||[])];
    const bar = _allHistory.length ? buildPriceBar(item.list_item, _allHistory, currentRef, item._ww_price_factor ?? 1) : '';

    // % Cheaper + discrepancy warning (must be before itemCell)
    const wwPrice = ww?.price;
    const coPrice = co?.price;
    let pctHtml = '';
    if (wwPrice != null && coPrice != null && wwPrice !== coPrice) {
      const pct = Math.round(Math.abs(wwPrice - coPrice) / Math.max(wwPrice, coPrice) * 100);
      pctHtml = `<span class="${cheaper === 'woolworths' ? 'pct-ww' : 'pct-coles'}">${pct}%</span>`;
    }
    const priceDiffPct = (wwPrice != null && coPrice != null)
      ? Math.abs(wwPrice - coPrice) / Math.max(wwPrice, coPrice)
      : 0;
    const _absDiff = (wwPrice != null && coPrice != null) ? Math.abs(wwPrice - coPrice) : 0;
    const discrepancyWarning = priceDiffPct > DISCREPANCY_WARN_THRESHOLD && !isDiffDismissed(item.list_item, _absDiff)
      ? `<span class="discrepancy-warn" title="Large price difference — double check the match is correct">⚠<button class="dismiss-diff-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" data-diff="${_absDiff.toFixed(4)}" title="Dismiss warning">✕</button></span>`
      : '';

    // Match quality warning (from scraper confidence / size validation)
    const matchConf = item.match_confidence;
    const sizeWarn  = item.size_warning;
    let matchWarnHtml = '';
    const _dismissed = (() => { try { return JSON.parse(localStorage.getItem('pw_dismissed_warns_v1') || '[]'); } catch { return []; } })();
    if (matchConf === 'none' && !_dismissed.includes(item.list_item)) {
      matchWarnHtml = `<span class="match-warn match-warn-none" title="Could not confidently match this item across stores — prices may be for different products">⚠ possible mismatch<button class="warn-dismiss" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Dismiss">✕</button></span>`;
    } else if ((matchConf === 'low' || sizeWarn) && !_dismissed.includes(item.list_item)) {
      const tip = sizeWarn
        ? 'Pack sizes differ between stores — per-100g is a better comparison'
        : 'Low-confidence match — verify these are the same product';
      matchWarnHtml = `<span class="match-warn match-warn-low" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="${tip}">⚠<button class="warn-dismiss" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Dismiss">✕</button></span>`;
    }

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${displayName}${discrepancyWarning}${matchWarnHtml}${editBtn}</div>
        </div>
      </div>`;

    // Hot deal: fire goes on the cheaper store's price cell
    const hotDeal = isHotDeal(item, _renderExclusions);
    const hotBadge = `<span class="hot-badge" title="Hot Deal!">🔥</span>`;

    // Per-100g/ml — computed from product name (reliable for packs); falls back to scraped cup price
    const wwP100 = clientPer100(ww);
    const coP100 = clientPer100(co);

    // WW price cell
    let wwCellContent;
    if (ww) {
      const wwPriceVal = wwUrl
        ? `<a href="${wwUrl}" target="_blank" class="price-link">${fmt(ww.price)}</a>`
        : fmt(ww.price);
      const wwFire = hotDeal && (cheaper === 'woolworths' || (cheaper == null && ww && !co)) ? hotBadge : '';
      const wwNameTip = ww.name ? ` title="${ww.name.replace(/"/g, '&quot;')}"` : '';
      const wwUnitStr = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : fmtUnit(ww.unit_price, ww.unit);
      wwCellContent = `<div class="price-main"${wwNameTip}>${wwPriceVal}${wwFire}</div><div class="price-unit">${wwUnitStr}</div>`;
    } else {
      const searchUrl = `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}`;
      wwCellContent = `<a href="${searchUrl}" target="_blank" class="search-link">Find on WW →</a>`;
    }

    // Coles price cell
    let coCellContent;
    if (co) {
      const coPriceVal = coUrl
        ? `<a href="${coUrl}" target="_blank" class="price-link">${fmt(co.price)}</a>`
        : fmt(co.price);
      const coFire = hotDeal && (cheaper === 'coles' || (cheaper == null && co && !ww)) ? hotBadge : '';
      const coNameTip = co.name ? ` title="${co.name.replace(/"/g, '&quot;')}"` : '';
      const coUnitStr = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : fmtUnit(co.unit_price, co.unit);
      coCellContent = `<div class="price-main"${coNameTip}>${coPriceVal}${coFire}</div><div class="price-unit">${coUnitStr}</div>`;
    } else {
      const searchUrl = `https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}`;
      coCellContent = `<a href="${searchUrl}" target="_blank" class="search-link">Find on Coles →</a>`;
    }

    // Best Price — N/A when one store is missing
    let badgeHtml = '';
    if (!ww || !co) {
      badgeHtml = '<span class="cheaper-badge na">N/A</span>';
    } else if (cheaper === 'woolworths') {
      badgeHtml = '<span class="store-chip ww sm">W</span>';
    } else if (cheaper === 'coles') {
      badgeHtml = '<span class="store-chip coles sm">C</span>';
    } else if (cheaper === 'equal') {
      badgeHtml = '<span class="cheaper-badge equal">=</span>';
    }

    // Units cell (declared before unitsSaving so it's in scope)
    const units = getUnits(item.list_item);

    const hasBothPrices = ww?.price != null && co?.price != null;
    let savingContent;
    if (!hasBothPrices) {
      savingContent = `<span class="no-data">—</span>`;
    } else {
      const unitsSaving = (item.saving_per_item ?? 0) * units;
      savingContent = unitsSaving > 0
        ? `<span class="saving-cell">${fmt(unitsSaving)}</span>`
        : `<span class="no-data">$0.00</span>`;
    }

    const tripsHtml = item.trip_count != null ? `<span class="trips-cell">${item.trip_count}</span>` : '';

    const isWatched = _watchlist.has(item.list_item);
    const watchBtn  = `<button class="item-watch-btn${isWatched ? ' active' : ''}" data-item="${safeKey}" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}">👁</button>`;
    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;

    const wwClass  = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass  = cheaper === 'coles'      ? 'cell-coles' : '';

    // Priority cell (uses analysis data as fallback)
    const itemPriority = getPriority(item.list_item);
    const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${safeKey}">
      <option value="weekly"${itemPriority === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${itemPriority === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${itemPriority === 'rare' ? ' selected' : ''}>Rare</option>
    </select></td>`;

    const unitsDisplay = Number.isInteger(units) ? units : units.toFixed(1);
    const unitsCell = `<td class="units-cell">
      <div class="units-ctrl">
        <button class="units-dec" data-item="${safeKey}">−</button>
        <span class="units-val">${unitsDisplay}</span>
        <button class="units-inc" data-item="${safeKey}">+</button>
      </div>
    </td>`;

    const wwTotalVal   = ww?.price != null ? ww.price * units : null;
    const colesTotalVal = co?.price != null ? co.price * units : null;
    const scrapedDate = item.last_scraped
      ? new Date(item.last_scraped).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '—';

    // Build cell map keyed by col id
    const tdMap = {
      name:         `<td class="item-name">${itemCell}</td>`,
      trend:        `<td class="trend-cell">${bar}</td>`,
      priority:     priorityCell,
      units:        unitsCell,
      ww:           `<td class="price-cell ${wwClass}">${wwCellContent}</td>`,
      coles:        `<td class="price-cell ${coClass}">${coCellContent}</td>`,
      cheaper:      `<td class="cheaper-cell">${badgeHtml}</td>`,
      pct:          `<td class="pct-cell">${pctHtml}</td>`,
      saving:       `<td><div class="saving-row">${savingContent}</div></td>`,
      trips:        `<td class="trips-cell">${tripsHtml}</td>`,
      category:     `<td style="font-size:12px;color:var(--text-mid)">${getCategory(item)}</td>`,
      last_scraped: `<td style="font-size:11px;color:var(--text-soft);white-space:nowrap">${scrapedDate}</td>`,
      ww_total:     `<td style="font-size:13px;font-weight:600">${wwTotalVal != null ? fmt(wwTotalVal) : '<span class="no-data">—</span>'}</td>`,
      coles_total:  `<td style="font-size:13px;font-weight:600">${colesTotalVal != null ? fmt(colesTotalVal) : '<span class="no-data">—</span>'}</td>`,
    };

    const checked = _checkedItems.has(item.list_item) ? ' checked' : '';
    const isPending = _pendingRefreshItem === item.list_item;
    const prevWw = _prevPrices[item.list_item]?.ww;
    const prevCo = _prevPrices[item.list_item]?.co;
    const priceChanged = (prevWw != null && prevWw !== ww?.price) || (prevCo != null && prevCo !== co?.price);
    const rowClass = isPending ? ' class="row-pending"' : (priceChanged ? ' class="row-flash"' : '');
    tbody.insertAdjacentHTML('beforeend', `<tr${rowClass} data-item="${safeKey}"><td class="check-cell"><input type="checkbox" class="row-check" data-item="${safeKey}"${checked}></td>${getVisibleCols().map(col => tdMap[col] || '').join('')}<td class="actions-cell">${watchBtn}${refreshBtn}</td></tr>`);

    _prevPrices[item.list_item] = { ww: ww?.price, co: co?.price };
    if (priceChanged && _pendingRefreshItem === item.list_item) _pendingRefreshItem = null;
  });

  // Tfoot — dynamic to match column order
  // Single pass over sorted visible rows: base totals (qty=1) for the price columns,
  // qty-adjusted totals for the total columns, and per-item savings for the savings cell.
  let _fWWBase = 0, _fCoBase = 0, _fWWQty = 0, _fCoQty = 0, _fSaving = 0;
  let _fWWAvail = false, _fCoAvail = false;
  for (const item of sorted) {
    const wwP = item.woolworths?.price ?? 0;
    const coP = item.coles?.price ?? 0;
    const qty = getUnits(item.list_item);
    if (item.woolworths?.price != null) _fWWAvail = true;
    if (item.coles?.price    != null)   _fCoAvail = true;
    _fWWBase += wwP;
    _fCoBase += coP;
    _fWWQty  += wwP * qty;
    _fCoQty  += coP * qty;
    _fSaving += (item.saving_per_item ?? 0) * qty;
  }
  const footWWBase   = Math.round(_fWWBase  * 100) / 100;
  const footCoBase   = Math.round(_fCoBase  * 100) / 100;
  const footWWQty    = Math.round(_fWWQty   * 100) / 100;
  const footCoQty    = Math.round(_fCoQty   * 100) / 100;
  const footerSaving = Math.round(_fSaving  * 100) / 100;

  const tfootRow = document.querySelector('tfoot tr');
  if (tfootRow) {
    const footMap = {
      name:         `<td><div style="font-weight:700;white-space:nowrap">${sorted.length} product${sorted.length !== 1 ? 's' : ''}</div></td>`,
      trend:        `<td></td>`,
      priority:     `<td></td>`,
      units:        `<td></td>`,
      ww:           `<td id="footWW">${_fWWAvail ? fmt(footWWBase) : '—'}</td>`,
      coles:        `<td id="footColes">${_fCoAvail ? fmt(footCoBase) : '—'}</td>`,
      cheaper:      `<td></td>`,
      pct:          `<td></td>`,
      saving:       `<td id="footSaving" style="text-align:right" title="Total savings vs most expensive store"><span class="saving-cell">${fmt(footerSaving)}</span><div style="font-size:11px;color:var(--text-soft);font-weight:400">saved</div></td>`,
      trips:        `<td></td>`,
      category:     `<td></td>`,
      last_scraped: `<td></td>`,
      ww_total:     `<td style="font-weight:700">${_fWWAvail ? fmt(footWWQty) : '—'}</td>`,
      coles_total:  `<td style="font-weight:700">${_fCoAvail ? fmt(footCoQty) : '—'}</td>`,
    };
    tfootRow.innerHTML = '<td></td>' + getVisibleCols().map(col => footMap[col] || '<td></td>').join('') + '<td></td>';
  }

  $('tableContainer').style.display = 'block';

  // Not-found items are now shown in the main table — hide the old separate section
  $('notFoundSection').style.display = 'none';

  // Sync check-all indeterminate state
  const allChecks = document.querySelectorAll('.row-check');
  const checkAll = $('checkAll');
  if (checkAll && allChecks.length) {
    const numChecked = [...allChecks].filter(c => c.checked).length;
    checkAll.checked = numChecked === allChecks.length;
    checkAll.indeterminate = numChecked > 0 && numChecked < allChecks.length;
  }
  updateBulkBar();

  // Signal sticky header to re-sync next scroll
  _stickyNeedsSync = true;
  onStickyScroll(); // update immediately if already scrolled past thead

  updateValidateNavBadge(data?.pending_validation?.length ?? 0);
}

// ── Validate nav badge ────────────────────────────────────────────────────────

function updateValidateNavBadge(count) {
  const link = document.getElementById('validateNavLink');
  if (!link) return;
  link.style.display = count > 0 ? '' : 'none';
  link.textContent = `⚠️ Validate (${count})`;
}

// ── Name changes notice ───────────────────────────────────────────────────────

async function showNameChangesNotice() {
  const changes = await loadNameChanges();
  const notifBtn = $('notifBtn');
  const notifBadge = $('notifBadge');
  const notifItems = $('notifItems');
  if (!notifBtn || !changes || Object.keys(changes).length === 0) return;
  const keys = Object.keys(changes).sort();
  const fingerprint = keys.join('|');

  // Don't re-show if user already dismissed this exact set of changes
  if (localStorage.getItem('pw_notif_dismissed_v1') === fingerprint) return;

  notifBadge.textContent = keys.length;
  notifBtn.style.display = 'inline-flex';
  notifItems.innerHTML = keys.map(k => `<span class="notif-item">${k}</span>`).join('');

  notifBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('notifDropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { $('notifDropdown').style.display = 'none'; });
  $('notifDismissAll')?.addEventListener('click', () => {
    localStorage.setItem('pw_notif_dismissed_v1', fingerprint);
    notifBtn.style.display = 'none';
    $('notifDropdown').style.display = 'none';
  });
}

// ── Mass upload ───────────────────────────────────────────────────────────────

let _uploadNewItems = [];

function initUploadModal() {
  const modal = $('uploadModal');
  if (!modal) return;

  const close = () => {
    modal.classList.remove('open');
    _uploadNewItems = [];
    $('uploadPreview').style.display = 'none';
    $('uploadConfirm').style.display = 'none';
    const fi = $('uploadFile');
    if (fi) fi.value = '';
  };

  $('importBtn')?.addEventListener('click', () => {
    modal.classList.add('open');
    renderPendingItems();
  });
  $('uploadModalClose').addEventListener('click', close);
  $('uploadCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const fileInput = $('uploadFile');
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) processUploadFile(e.target.files[0]);
  });

  const dropZone = $('uploadDropZone');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-active'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-active'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-active');
    if (e.dataTransfer.files[0]) processUploadFile(e.dataTransfer.files[0]);
  });

  $('uploadConfirm').addEventListener('click', async () => {
    if (!_uploadNewItems.length) return;
    const btn = $('uploadConfirm');
    btn.disabled = true;
    btn.textContent = 'Adding items…';
    await addItemsToShoppingList(_uploadNewItems);
    close();
  });
}

function renderPendingItems() {
  let section = $('pendingItemsSection');
  if (!section) return;
  const pending = loadPending();
  if (!pending.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  const list = section.querySelector('.pending-list');
  if (!list) return;
  list.innerHTML = '';
  pending.forEach((p, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="pending-price">${fmt(p.price)}</span> from <em>${p.from_item}</em> on ${p.date?.split('T')[0] || '?'}
      <button class="pending-remove-btn" data-idx="${idx}">✕</button>`;
    li.querySelector('.pending-remove-btn').addEventListener('click', () => {
      const arr = loadPending();
      arr.splice(idx, 1);
      savePending(arr);
      updateImportBadge();
      renderPendingItems();
    });
    list.appendChild(li);
  });
}

async function processUploadFile(file) {
  if (!window.XLSX) { alert('SheetJS not loaded — please reload the page.'); return; }

  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });

    const sheetName = wb.SheetNames.includes('Data') ? 'Data' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!rows.length) { alert('No data found in the file.'); return; }

    // Find "Item" column
    const header = rows[0].map(h => String(h).trim().toLowerCase());
    const itemCol = header.findIndex(h => h === 'item' || h === 'item name' || h === 'name');
    if (itemCol === -1) {
      alert('Could not find an "Item" column. Make sure your file has an "Item" header row.');
      return;
    }

    const uploadedItems = [...new Set(
      rows.slice(1).map(r => String(r[itemCol] || '').trim()).filter(Boolean)
    )];

    const existingNames = new Set((_lastData?.items || []).map(i => i.list_item.toLowerCase()));
    const newItems = uploadedItems.filter(n => !existingNames.has(n.toLowerCase()));
    const alreadyTracked = uploadedItems.filter(n => existingNames.has(n.toLowerCase()));

    _uploadNewItems = newItems;

    $('uploadPreviewTitle').textContent =
      `${newItems.length} new item${newItems.length !== 1 ? 's' : ''} to add` +
      (alreadyTracked.length ? `, ${alreadyTracked.length} already tracked` : '');

    $('uploadPreviewList').innerHTML = [
      ...newItems.map(n => `<li class="new-item">${n}</li>`),
      ...alreadyTracked.map(n => `<li>${n} (already tracked)</li>`),
    ].join('');

    $('uploadPreview').style.display = 'block';

    const confirmBtn = $('uploadConfirm');
    if (newItems.length > 0) {
      confirmBtn.style.display = 'inline-flex';
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Add ${newItems.length} Item${newItems.length !== 1 ? 's' : ''} & Scrape`;
    } else {
      confirmBtn.style.display = 'none';
    }
  } catch (err) {
    alert(`Error reading file: ${err.message}`);
  }
}

async function writeNewItemToExcel(itemName) {
  if (!window.XLSX) throw new Error('SheetJS not loaded');
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) throw new Error('GitHub settings not configured');

  // GET current file + SHA
  const getRes = await fetch(
    `https://api.github.com/repos/${s.user}/${s.repo}/contents/shopping_list.xlsx`,
    { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
  );
  if (!getRes.ok) throw new Error(`GitHub ${getRes.status}: could not read shopping_list.xlsx`);
  let { content, sha } = await getRes.json();

  // Decode base64 → Uint8Array → XLSX workbook
  const binaryStr = atob(content.replace(/\s/g, ''));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames.includes('Data') ? 'Data' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!data.length) throw new Error('shopping_list.xlsx has no data');

  const header   = data[0];
  const itemIdx  = header.findIndex(h => String(h).toLowerCase().includes('item'));
  const dateIdx  = header.findIndex(h => String(h).toLowerCase().includes('date'));
  const priceIdx = header.findIndex(h => String(h).toLowerCase().includes('price') || String(h).toLowerCase().includes('unit'));
  const today     = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Add 2 trips (meets min_trips=2 threshold in scraper)
  for (const d of [yesterday, today]) {
    const row = Array(Math.max(header.length, 3)).fill('');
    if (itemIdx  >= 0) row[itemIdx]  = itemName;
    if (dateIdx  >= 0) row[dateIdx]  = d;
    if (priceIdx >= 0) row[priceIdx] = 0;
    data.push(row);
  }
  wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(data);
  const newContent = XLSX.write(wb, { type: 'base64', bookType: 'xlsx', cellDates: true });

  // PUT — retry once on 409 with freshly fetched SHA
  const doPut = async (currentSha) => fetch(
    `https://api.github.com/repos/${s.user}/${s.repo}/contents/shopping_list.xlsx`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add "${itemName}" via different-item flow`, content: newContent, sha: currentSha }),
    }
  );
  let putRes = await doPut(sha);
  if (putRes.status === 409) {
    // Stale SHA — re-fetch and retry once
    const retryGet = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/contents/shopping_list.xlsx`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
    );
    if (retryGet.ok) ({ sha } = await retryGet.json());
    putRes = await doPut(sha);
  }
  if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: could not update shopping_list.xlsx`);
}

async function addItemsToShoppingList(newItems) {
  if (!window.XLSX) { alert('SheetJS not loaded.'); return; }
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) {
    alert('Please configure GitHub settings (Auto-update Setup) first.');
    return;
  }

  try {
    // Fetch current shopping_list.xlsx
    const getRes = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/contents/shopping_list.xlsx`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!getRes.ok) throw new Error(`GitHub ${getRes.status}: could not read shopping_list.xlsx`);
    const { content, sha } = await getRes.json();

    // Decode base64 → Uint8Array
    const binaryStr = atob(content.replace(/\s/g, ''));
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

    const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames.includes('Data') ? 'Data' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!data.length) throw new Error('shopping_list.xlsx has no data');

    const header = data[0];
    const itemIdx  = header.findIndex(h => String(h).toLowerCase().includes('item'));
    const dateIdx  = header.findIndex(h => String(h).toLowerCase().includes('date'));
    const priceIdx = header.findIndex(h => String(h).toLowerCase().includes('price') || String(h).toLowerCase().includes('unit'));

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Add 2 trips per new item (meets min_trips=2 threshold in scraper)
    for (const itemName of newItems) {
      const tripDates = [yesterday, today];
      for (let t = 0; t < 2; t++) {
        const row = Array(Math.max(header.length, 3)).fill('');
        if (itemIdx >= 0)  row[itemIdx]  = itemName;
        if (dateIdx >= 0)  row[dateIdx]  = tripDates[t];
        if (priceIdx >= 0) row[priceIdx] = 0;
        data.push(row);
      }
    }

    const newWs = XLSX.utils.aoa_to_sheet(data);
    wb.Sheets[sheetName] = newWs;
    const newContent = XLSX.write(wb, { type: 'base64', bookType: 'xlsx', cellDates: true });

    // Write back to GitHub
    const putRes = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/contents/shopping_list.xlsx`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${s.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Add ${newItems.length} item(s) via mass upload`,
          content: newContent,
          sha,
        }),
      }
    );
    if (!putRes.ok) throw new Error(`GitHub PUT ${putRes.status}: could not update shopping_list.xlsx`);

    // Trigger scrape workflow
    const { anyOnline } = await getRunnerStatus(s);
    if (!anyOnline) {
      showRunnerOfflineBanner();
      alert('Items added to your shopping list, but the scraper is offline — prices will update when the runner restarts.');
      return;
    }
    hideRunnerOfflineBanner();
    await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    alert(`✓ Added ${newItems.length} item(s) to your shopping list and triggered a price scrape!`);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ── Column chooser ────────────────────────────────────────────────────────────

const COL_LABELS = {
  name: 'Item name', priority: 'Priority', ww: 'WW price', coles: 'Coles price',
  cheaper: 'Best store', pct: 'Diff %', saving: 'Savings', units: 'Qty', trips: 'Buys',
  category: 'Category', last_scraped: 'Last scraped',
  ww_total: 'WW total (qty × price)', coles_total: 'Coles total (qty × price)',
};

function initColumnChooser() {
  const btn = $('colChooserBtn');
  const dropdown = $('colChooserDropdown');
  if (!btn || !dropdown) return;

  const coreGroups = [
    ['name', 'priority', 'ww', 'coles', 'cheaper', 'pct', 'saving', 'units', 'trips'],
    ['category', 'last_scraped', 'ww_total', 'coles_total'],
  ];

  function renderDropdown() {
    dropdown.innerHTML = coreGroups.map((group, gi) => {
      const items = group.map(col => {
        const checked = _colVisibility[col] !== false;
        return `<label class="col-chooser-item"><input type="checkbox" data-col="${col}" ${checked ? 'checked' : ''}> ${COL_LABELS[col] || col}</label>`;
      }).join('');
      return (gi > 0 ? '<div class="col-chooser-sep"></div>' : '') + items;
    }).join('') +
    `<div class="col-chooser-sep"></div>
     <button class="col-chooser-reset-btn" id="resetColsBtnInner">
       <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3"/></svg>
       Reset Columns
     </button>`;
    // Wire up the reset button each time dropdown is rendered
    dropdown.querySelector('#resetColsBtnInner')?.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = 'none';
      resetColumns();
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (dropdown.style.display === 'none') {
      renderDropdown();
      dropdown.style.display = 'block';
    } else {
      dropdown.style.display = 'none';
    }
  });

  document.addEventListener('click', () => { if (dropdown) dropdown.style.display = 'none'; });
  dropdown.addEventListener('click', (e) => e.stopPropagation());
  dropdown.addEventListener('change', (e) => {
    const col = e.target.dataset?.col;
    if (col) {
      _colVisibility[col] = e.target.checked;
      saveColVisibility();
      if (_lastData) renderPage(_lastData);
    }
  });
}

// ── Column filter dropdown ────────────────────────────────────────────────────

let _cfdCol = null;
let _cfdAllValues = [];
let _cfdTempValues = null;

function initColFilterDropdown() {
  const dd = $('colFilterDropdown');
  if (!dd) return;

  dd.addEventListener('click', (e) => e.stopPropagation());

  dd.querySelector('.cfd-sort-asc')?.addEventListener('click', () => {
    if (_cfdCol) {
      sortKeys = [{ col: _cfdCol, dir: 'asc' }, ...sortKeys.filter(k => k.col !== _cfdCol)];
      closeColFilter();
      if (_lastData) renderPage(_lastData);
    }
  });
  dd.querySelector('.cfd-sort-desc')?.addEventListener('click', () => {
    if (_cfdCol) {
      sortKeys = [{ col: _cfdCol, dir: 'desc' }, ...sortKeys.filter(k => k.col !== _cfdCol)];
      closeColFilter();
      if (_lastData) renderPage(_lastData);
    }
  });

  dd.querySelector('.cfd-search')?.addEventListener('input', (e) => renderCfdValues(e.target.value));

  dd.querySelector('.cfd-select-all')?.addEventListener('change', (e) => {
    const search = dd.querySelector('.cfd-search').value.toLowerCase();
    const visible = _cfdAllValues.filter(v => !search || v.toLowerCase().includes(search));
    if (e.target.checked) visible.forEach(v => _cfdTempValues.add(v));
    else visible.forEach(v => _cfdTempValues.delete(v));
    renderCfdValues(search, false);
  });

  dd.querySelector('.cfd-ok')?.addEventListener('click', () => {
    if (_cfdCol) {
      // Save numeric filter if column supports it
      if (NUMERIC_COLS.has(_cfdCol)) {
        const op1  = $('cfdNumOp1').value;
        const val1 = $('cfdNumVal1').value.trim();
        if (val1 !== '') {
          _colNumFilters[_cfdCol] = { op1, val1 };
        } else {
          delete _colNumFilters[_cfdCol];
        }
      }
      // Save checkbox filter
      if (_cfdTempValues.size === _cfdAllValues.length || _cfdTempValues.size === 0) {
        delete _colFilters[_cfdCol];
      } else {
        _colFilters[_cfdCol] = new Set(_cfdTempValues);
      }
    }
    closeColFilter();
    if (_lastData) renderPage(_lastData);
  });

  dd.querySelector('.cfd-clear')?.addEventListener('click', () => {
    if (_cfdCol) {
      delete _colFilters[_cfdCol];
      delete _colNumFilters[_cfdCol];
    }
    closeColFilter();
    if (_lastData) renderPage(_lastData);
  });

  document.addEventListener('click', closeColFilter);
}

function closeColFilter(e) {
  if (e?.target?.closest?.('.col-filter-btn')) return;
  const dd = $('colFilterDropdown');
  if (dd) dd.style.display = 'none';
  _cfdCol = null;
}

function openColFilter(col, btn) {
  const dd = $('colFilterDropdown');
  if (!dd || !_lastData) return;

  if (_cfdCol === col && dd.style.display !== 'none') { closeColFilter(); return; }

  _cfdCol = col;
  const existing = _colFilters[col];

  // Gather all unique values from full (unfiltered by this col) items
  const allItems = [...(_lastData.items || []), ...(_lastData.not_found_items || []).map(n => ({ list_item: n }))];
  _cfdAllValues = [...new Set(allItems.map(i => getColValue(col, i)))].sort((a, b) => {
    // Numeric sort for price/numeric-looking values
    const na = parseFloat(a.replace(/[$,]/g, '')), nb = parseFloat(b.replace(/[$,]/g, ''));
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  _cfdTempValues = existing ? new Set(existing) : new Set(_cfdAllValues);

  // Update sort labels — context-aware per column type
  const asc = dd.querySelector('.cfd-sort-asc');
  const desc = dd.querySelector('.cfd-sort-desc');
  const sortLabel = (() => {
    if (col === 'trend')        return { asc: 'Best value first',   desc: 'Worst value first' };
    if (col === 'name')         return { asc: 'A → Z',              desc: 'Z → A' };
    if (col === 'category')     return { asc: 'A → Z',              desc: 'Z → A' };
    if (col === 'cheaper')      return { asc: 'A → Z',              desc: 'Z → A' };
    if (col === 'priority')     return { asc: 'Weekly first',        desc: 'Rare first' };
    if (col === 'last_scraped') return { asc: 'Oldest first',        desc: 'Newest first' };
    if (col === 'trips')        return { asc: 'Fewest buys first',   desc: 'Most bought first' };
    if (col === 'saving')       return { asc: 'Least savings first', desc: 'Most savings first' };
    if (NUMERIC_COLS.has(col))  return { asc: 'Low → High',          desc: 'High → Low' };
    return { asc: 'A → Z', desc: 'Z → A' };
  })();
  if (asc)  asc.textContent  = sortLabel.asc;
  if (desc) desc.textContent = sortLabel.desc;

  // Show/hide and populate numeric filter section
  const numSec = $('cfdNumFilter');
  if (numSec) {
    if (NUMERIC_COLS.has(col)) {
      numSec.style.display = 'block';
      const nf = _colNumFilters[col] || {};
      $('cfdNumOp1').value = nf.op1 || '>';
      $('cfdNumVal1').value = nf.val1 ?? '';
    } else {
      numSec.style.display = 'none';
    }
  }

  // Columns with no meaningful discrete values — hide search/values section
  const NO_VALUE_FILTER_COLS = new Set(['trend', 'last_scraped']);
  const showValueFilter = !NO_VALUE_FILTER_COLS.has(col);
  dd.querySelector('.cfd-search-wrap').style.display  = showValueFilter ? '' : 'none';
  dd.querySelector('.cfd-select-all-row').style.display = showValueFilter ? '' : 'none';
  dd.querySelector('.cfd-values').style.display       = showValueFilter ? '' : 'none';

  dd.querySelector('.cfd-search').value = '';
  if (showValueFilter) renderCfdValues('');

  // Position dropdown under button
  const rect = btn.getBoundingClientRect();
  dd.style.display = 'block';
  const ddW = 220;
  let left = rect.left;
  if (left + ddW > window.innerWidth - 8) left = window.innerWidth - ddW - 8;
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = left + 'px';
}

function renderCfdValues(search, resetScroll = true) {
  const dd = $('colFilterDropdown');
  if (!dd) return;
  const term = (search || '').toLowerCase();
  const visible = _cfdAllValues.filter(v => !term || v.toLowerCase().includes(term));

  const container = dd.querySelector('.cfd-values');
  if (!container) return;

  const allChecked = visible.every(v => _cfdTempValues.has(v));
  const someChecked = visible.some(v => _cfdTempValues.has(v));
  const saEl = dd.querySelector('.cfd-select-all');
  if (saEl) { saEl.checked = allChecked; saEl.indeterminate = !allChecked && someChecked; }

  container.innerHTML = visible.map(v => {
    const checked = _cfdTempValues.has(v) ? ' checked' : '';
    const safe = v.replace(/"/g, '&quot;');
    const label = (_cfdCol === 'cheaper' && v === 'equal') ? '=' : safe;
    return `<label class="cfd-item"><input type="checkbox" value="${safe}"${checked}> ${label}</label>`;
  }).join('');

  if (resetScroll) container.scrollTop = 0;

  container.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) _cfdTempValues.add(cb.value);
      else _cfdTempValues.delete(cb.value);
      renderCfdValues(dd.querySelector('.cfd-search').value, false);
    });
  });
}

// ── Export shopping list ──────────────────────────────────────────────────────

function exportShoppingList(useChecked) {
  const sel = (useChecked && _checkedItems.size > 0)
    ? { type: 'checked', items: [..._checkedItems] }
    : { type: 'filter', priority: _activePriority, category: _activeCategory, hotOnly: _showHotOnly, pricesOnly: _showPricesOnly };
  localStorage.setItem('pw_export_sel', JSON.stringify(sel));
  window.open('shopping-list.html', '_blank');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  // Sync any localStorage URL overrides to the repo immediately so the scraper always
  // uses pinned URLs even if they were set before the persist-on-save fix was deployed.
  (() => {
    const s = loadSettings();
    if (s.user && s.repo && s.token) {
      const ov = loadOverrides();
      if (Object.values(ov).some(v => v.wwUrl || v.colesUrl)) {
        persistUrlOverridesToRepo(s, ov).catch(() => {});
      }
    }
  })();

  initSettingsModal();
  initEditModal();
  initPriceHistoryModal();
  initTooltip();
  initStickyHeader();
  initUploadModal();
  initSearch();
  initDiffItemModal();
  initPriorityFilter();
  initPricesOnlyFilter();
  initBulkBar();
  initColumnChooser();
  initColFilterDropdown();
  updateImportBadge();

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerRefresh);

  $('shopListBtn')?.addEventListener('click', () => exportShoppingList(false));
  $('bulkExportBtn')?.addEventListener('click', () => exportShoppingList(true));

  // Scrape strip dismiss & retry
  // Scrape Archived button — persists archived list to GitHub then dispatches workflow
  $('scrapeArchivedBtn')?.addEventListener('click', async () => {
    const s = loadSettings();
    if (!s.user || !s.repo || !s.token) {
      alert('Please configure Auto-update Setup first.');
      return;
    }
    const pr = loadPriorities();
    const archivedNames = Object.keys(pr).filter(k => pr[k] === 'archive');
    if (!archivedNames.length) {
      alert('No archived items found.');
      return;
    }
    const btn = $('scrapeArchivedBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // Write archived_items.json to repo via GitHub API
      _archivedSaving = true;
      try {
        await persistArchivedToRepo(s, archivedNames, 'Update archived items list');
      } finally {
        _archivedSaving = false;
      }
      // Pre-flight runner check before dispatching
      const { anyOnline } = await getRunnerStatus(s);
      if (!anyOnline) {
        showRunnerOfflineBanner();
        alert('Archived list saved, but the scraper is offline — prices will update when the runner restarts.');
        btn.disabled = false;
        return;
      }
      hideRunnerOfflineBanner();
      // Dispatch scrape_archived workflow
      btn.textContent = 'Dispatching…';
      await fetch(
        `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'main', inputs: { trigger: 'scrape_archived' } }),
        }
      );
      btn.textContent = '✓ Triggered';
      setTimeout(() => { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Archived'; }, 4000);
    } catch (e) {
      alert(`Error: ${e.message}`);
      btn.disabled = false;
    }
  });

  // ── View toggle ──────────────────────────────────────────────
  const viewToggleBtn = $('viewToggleBtn');
  const TABLE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
  const CARD_ICON  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
  function syncViewToggleBtn() {
    if (!viewToggleBtn) return;
    if (_viewMode === 'card') {
      viewToggleBtn.innerHTML = TABLE_ICON;
      viewToggleBtn.title = 'Switch to table view';
      viewToggleBtn.classList.add('view-active');
    } else {
      viewToggleBtn.innerHTML = CARD_ICON;
      viewToggleBtn.title = 'Switch to card view';
      viewToggleBtn.classList.remove('view-active');
    }
  }
  syncViewToggleBtn();
  viewToggleBtn?.addEventListener('click', () => {
    _viewMode = _viewMode === 'table' ? 'card' : 'table';
    localStorage.setItem('pw_view_mode', _viewMode);
    syncViewToggleBtn();
    if (_lastData) renderPage(_lastData);
  });

  // ── Card grid event delegation ────────────────────────────────
  const cardGrid = $('cardGrid');
  if (cardGrid) {
    cardGrid.addEventListener('click', (e) => {
      const warnDismiss = e.target.closest('.warn-dismiss');
      if (warnDismiss) {
        e.stopPropagation();
        const itemName = warnDismiss.dataset.item;
        try { const d = JSON.parse(localStorage.getItem('pw_dismissed_warns_v1')||'[]'); if (!d.includes(itemName)) d.push(itemName); localStorage.setItem('pw_dismissed_warns_v1', JSON.stringify(d)); } catch {}
        warnDismiss.closest('.match-warn')?.remove();
        return;
      }
      const rowCheck = e.target.closest('.row-check');
      if (rowCheck) {
        const name = rowCheck.dataset.item;
        if (rowCheck.checked) _checkedItems.add(name); else _checkedItems.delete(name);
        updateBulkBar();
        return;
      }
      const editBtn = e.target.closest('.item-edit-btn');
      if (editBtn && _lastData) {
        const item = _lastData.items.find(i => i.list_item === editBtn.dataset.editItem);
        if (item) openEditModal(item);
        return;
      }
      const refreshBtn = e.target.closest('.item-refresh-btn');
      if (refreshBtn) {
        const ov = loadOverrides()[refreshBtn.dataset.item] || {};
        triggerItemRefresh(refreshBtn.dataset.item, refreshBtn, { wwUrl: ov.wwUrl, colesUrl: ov.colesUrl });
        return;
      }
    });
    cardGrid.addEventListener('change', (e) => {
      const sel = e.target.closest('.priority-select');
      if (sel) {
        const pr = loadPriorities();
        if (sel.value) pr[sel.dataset.item] = sel.value;
        else delete pr[sel.dataset.item];
        savePriorities(pr);
        if (_lastData) renderPage(_lastData);
        scheduleArchiveSync();
      }
    });
  }

  // ── Reset dismissed warnings ──────────────────────────────────
  $('resetWarningsBtn')?.addEventListener('click', () => {
    localStorage.removeItem('pw_dismissed_warns_v1');
    if (_lastData) renderPage(_lastData);
    $('settingsModal').style.display = 'none';
  });

  $('scrapeStripDismiss')?.addEventListener('click', () => {
    _progressDismissed = true;
    const strip = $('scrapeStrip');
    if (strip) strip.style.display = 'none';
  });
  $('scrapeStripRetry')?.addEventListener('click', () => {
    _progressDismissed = false;
    triggerRefresh();
  });

  // Store banner clicks → show that store's total column
  $('wwCard')?.addEventListener('click', () => {
    _colVisibility.ww_total    = true;
    _colVisibility.coles_total = false;
    saveColVisibility();
    if (_lastData) renderPage(_lastData);
  });
  $('colesCard')?.addEventListener('click', () => {
    _colVisibility.coles_total = true;
    _colVisibility.ww_total    = false;
    saveColVisibility();
    if (_lastData) renderPage(_lastData);
  });

  // More menu dropdown
  const moreBtn = $('moreMenuBtn');
  const moreDd  = $('moreMenuDropdown');
  if (moreBtn && moreDd) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreDd.style.display = moreDd.style.display === 'none' ? 'block' : 'none';
    });
    moreDd.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { if (moreDd) moreDd.style.display = 'none'; });
  }

  // Column filter button clicks (delegated from thead, re-bound after each render via renderTableHead)
  document.addEventListener('click', (e) => {
    const fb = e.target.closest('.col-filter-btn');
    if (fb) {
      e.stopPropagation();
      const col = fb.dataset.filterCol;
      if (col) openColFilter(col, fb);
    }
  });

  // Load analysis data and watchlist before first render
  await Promise.all([loadItemAnalysis(), initWatchlist()]);
  const data = await loadData();

  {
    renderPage(data);
    showNameChangesNotice();

    // Auto-dismiss low-confidence badges after 8 s (not "none" — those need manual action)
    setTimeout(() => {
      document.querySelectorAll('.match-warn-low').forEach(el => {
        el.style.transition = 'opacity 0.5s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 500);
      });
    }, 8000);

    const tbody = $('tableBody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        // Row checkbox
        const rowCheck = e.target.closest('.row-check');
        if (rowCheck) {
          const name = rowCheck.dataset.item;
          if (rowCheck.checked) _checkedItems.add(name);
          else _checkedItems.delete(name);
          // Sync check-all state
          const allChecks = document.querySelectorAll('.row-check');
          const numChecked = [...allChecks].filter(c => c.checked).length;
          const ca = $('checkAll');
          if (ca) { ca.checked = numChecked === allChecks.length; ca.indeterminate = numChecked > 0 && numChecked < allChecks.length; }
          updateBulkBar();
          return;
        }

        // Units increment/decrement
        const incBtn = e.target.closest('.units-inc, .units-dec');
        if (incBtn) {
          const itemName = incBtn.dataset.item;
          const delta = incBtn.classList.contains('units-inc') ? 1 : -1;
          const ov = loadUnitOverrides();
          const cur = getUnits(itemName);
          ov[itemName] = Math.max(1, Math.round(cur) + delta);
          saveUnitOverrides(ov);
          if (_lastData) renderPage(_lastData);
          return;
        }

        const refreshBtn = e.target.closest('.item-refresh-btn');
        if (refreshBtn) {
          const ov = loadOverrides()[refreshBtn.dataset.item] || {};
          triggerItemRefresh(refreshBtn.dataset.item, refreshBtn, { wwUrl: ov.wwUrl, colesUrl: ov.colesUrl });
          return;
        }
        const dismissDiffBtn = e.target.closest('.dismiss-diff-btn');
        if (dismissDiffBtn) {
          e.stopPropagation();
          dismissDiff(dismissDiffBtn.dataset.item, parseFloat(dismissDiffBtn.dataset.diff));
          if (_lastData) renderPage(_lastData);
          return;
        }

        const warnDismiss = e.target.closest('.warn-dismiss');
        if (warnDismiss) {
          e.stopPropagation();
          const itemName = warnDismiss.dataset.item;
          try {
            const d = JSON.parse(localStorage.getItem('pw_dismissed_warns_v1') || '[]');
            if (!d.includes(itemName)) d.push(itemName);
            localStorage.setItem('pw_dismissed_warns_v1', JSON.stringify(d));
          } catch {}
          warnDismiss.closest('.match-warn')?.remove();
          return;
        }

        const watchBtn = e.target.closest('.item-watch-btn');
        if (watchBtn) { toggleWatchlist(watchBtn.dataset.item); return; }

        const editBtn = e.target.closest('.item-edit-btn');
        if (editBtn && _lastData) {
          const itemName = editBtn.dataset.editItem;
          const item = _lastData.items.find(i => i.list_item === itemName);
          if (item) openEditModal(item);
          return;
        }
        const manageBtn = e.target.closest('.price-bar-manage');
        if (manageBtn && _lastData) {
          const itemName = manageBtn.dataset.manageItem;
          const item = _lastData.items.find(i => i.list_item === itemName);
          if (item) openPriceHistoryModal(item);
          return;
        }
      });

      // Priority dropdown changes
      tbody.addEventListener('change', (e) => {
        const sel = e.target.closest('.priority-select');
        if (sel) {
          const p = loadPriorities();
          p[sel.dataset.item] = sel.value;
          savePriorities(p);
          if (_lastData) renderPage(_lastData);
          scheduleArchiveSync();
        }
      });
    }
  }

  // One-time sync on load: push current archived items to archived_items.json
  // Fixes case where localStorage has archived items but the repo file was empty/stale.
  const _initPr = loadPriorities();
  if (Object.values(_initPr).includes('archive')) {
    syncArchivedToGitHub();
  }

  // Background runner-status check: silently show the offline banner if the runner
  // is down, and update the stale-data banner text to match.
  const _bootSettings = loadSettings();
  if (_bootSettings.user && _bootSettings.repo && _bootSettings.token) {
    getRunnerStatus(_bootSettings).then(({ anyOnline }) => {
      if (!anyOnline) {
        showRunnerOfflineBanner();
        updateStaleBannerForRunner(true);
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', boot);
