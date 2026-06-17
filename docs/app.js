// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—';

// Strip "Woolworths " prefix for display. The underlying list_item key stays
// unchanged so price history and localStorage keys keep working.
const stripWW  = (name) => name.replace(/^Woolworths\s+/i, '');
// Short telegram display name (from name_map.js); falls back to stripWW.
const shortName = (name) => (window.PW_NAME_MAP && window.PW_NAME_MAP[name]) || stripWW(name);
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

function clientPerKg(result) {
  if (!result || result.price == null) return null;
  const p = clientPer100(result);
  return p.value != null ? +(p.value * 10).toFixed(2) : null;
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

const DISCREPANCY_WARN_THRESHOLD = 0.31; // price diff % above which ⚠ is shown
const STALE_DATA_DAYS          = 5;      // days before "data is stale" banner appears
const STALE_PROGRESS_MS        = 5 * 60 * 1000; // ms with no progress update → ⚠ Stalled

// ── Overrides (edit name / URL) ──────────────────────────────────────────────

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_overrides_v1') || '{}'); } catch { return {}; }
}

function saveOverrides(obj) {
  localStorage.setItem('pw_overrides_v1', JSON.stringify(obj));
}

// ── Rejected product URLs (from "Different item") ────────────────────────────
// Shape: { "<item>": { "ww": ["url", ...], "coles": ["url", ...] } }
// The scraper reads docs/data/rejected_urls.json and drops these candidates so
// it never re-matches a product the user has flagged as belonging elsewhere.
function loadRejected() {
  try { return JSON.parse(localStorage.getItem('pw_rejected_urls_v1') || '{}'); } catch { return {}; }
}
function saveRejected(obj) {
  localStorage.setItem('pw_rejected_urls_v1', JSON.stringify(obj));
}
async function persistRejectedToRepo(s, rejected) {
  if (!s?.user || !s?.repo || !s?.token) return;
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/rejected_urls.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

  // Merge with repo copy so entries from other sessions are preserved.
  const getRes = await fetch(apiPath, { headers });
  const getJson = getRes.ok ? await getRes.json() : {};
  let existing = {};
  if (getJson.content) {
    try { existing = JSON.parse(atob(getJson.content.replace(/\n/g, ''))); } catch {}
  }
  const merged = { ...existing };
  for (const [item, stores] of Object.entries(rejected)) {
    merged[item] = merged[item] || {};
    for (const store of ['ww', 'coles']) {
      const urls = new Set([...(merged[item][store] || []), ...((stores && stores[store]) || [])]);
      if (urls.size) merged[item][store] = [...urls];
    }
  }
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(merged, null, 2) + '\n')));
  const doPut = async () => {
    const shaRes = await fetch(apiPath, { headers });
    const shaJson = shaRes.ok ? await shaRes.json() : {};
    const body = { message: 'chore: sync rejected product URLs', content };
    if (shaJson.sha) body.sha = shaJson.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(body) });
  };
  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
  if (!putRes.ok) {
    const msg = await putRes.text().catch(() => String(putRes.status));
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg}`);
  }
}

// ── Image overrides ───────────────────────────────────────────────────────────
// Stores { [list_item]: 'ww' | 'coles' } — user-chosen image source per item
function loadImgOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_img_overrides_v1') || '{}'); } catch { return {}; }
}
function saveImgOverrides(obj) { localStorage.setItem('pw_img_overrides_v1', JSON.stringify(obj)); }

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
  if (!s.token) return;
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

// ── Cross-device sync of priorities + unit quantities ─────────────────────────
// Item priorities (weekly/monthly/rare) and per-item quantities live only in
// localStorage, so two devices can disagree on which items the "Weekly" basket
// contains and how many of each — which makes the basket total, basket saving
// and max saving differ between phone and computer. We mirror both maps to
// docs/data/user_settings.json (same mechanism as watchlist.json): the device
// holding a token publishes on change; every device merges the file in on boot
// so the baskets always agree.
function loadPerkgLocal() {
  try { return new Set(JSON.parse(localStorage.getItem('pw_perkg_v1') || '[]')); } catch { return new Set(); }
}
function savePerkgLocal(set) {
  localStorage.setItem('pw_perkg_v1', JSON.stringify([...set]));
}
let _userSettingsTimer = null;
function scheduleUserSettingsSync() {
  clearTimeout(_userSettingsTimer);
  _userSettingsTimer = setTimeout(persistUserSettingsToRepo, 1500);
}
async function persistUserSettingsToRepo() {
  const s = loadSettings();
  if (!s.token) return;
  const payload = { priorities: loadPriorities(), units: loadUnitOverrides(), perkg: [..._perkgSet] };
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/user_settings.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2) + '\n')));
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const meta = getRes.ok ? await getRes.json() : {};
    const body = { message: 'chore: sync user settings (priorities + quantities)', content };
    if (meta.sha) body.sha = meta.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(body) });
  };
  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
  // fire-and-forget — errors are silently ignored
}
async function initUserSettings() {
  _perkgSet = loadPerkgLocal();
  try {
    const res = await fetch(`data/user_settings.json?t=${Date.now()}`);
    if (res.ok) {
      const remote = await res.json();
      if (remote && typeof remote === 'object') {
        // Merge so the repo and this device agree. Repo values win on conflict
        // (changes push immediately, so the repo is the freshest source); any
        // local-only keys are preserved, so nothing is ever silently deleted.
        localStorage.setItem('pw_priorities_v1', JSON.stringify({ ...loadPriorities(), ...(remote.priorities || {}) }));
        localStorage.setItem('pw_units_v1',      JSON.stringify({ ...loadUnitOverrides(), ...(remote.units || {}) }));
        if (Array.isArray(remote.perkg)) {
          _perkgSet = new Set([..._perkgSet, ...remote.perkg]);
          savePerkgLocal(_perkgSet);
        }
      }
    }
  } catch {}
  // Publish the merged set so any local-only tags on this device reach the repo.
  scheduleUserSettingsSync();
}

async function persistLatestJson(data, message = 'chore: update latest.json') {
  const s = loadSettings();
  if (!s.token) return;
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
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/docs/data/url_overrides.json`;
  const headers = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };

  // Fetch the current file so we can merge rather than overwrite.
  // Entries already in the repo but not in localStorage (e.g. manually added by Claude)
  // are preserved; localStorage entries take priority on conflict.
  const getRes = await fetch(apiPath, { headers });
  const getJson = getRes.ok ? await getRes.json() : {};
  let existing = {};
  if (getJson.content) {
    try { existing = JSON.parse(atob(getJson.content.replace(/\n/g, ''))); } catch {}
  }

  // Merge: start with repo copy, then overlay localStorage entries
  const merged = { ...existing };
  for (const [item, ov] of Object.entries(overrides)) {
    if (ov.wwUrl || ov.colesUrl) {
      merged[item] = { ...(merged[item] || {}) };
      if (ov.wwUrl)    merged[item].ww_url    = ov.wwUrl;
      if (ov.colesUrl) merged[item].coles_url = ov.colesUrl;
    }
  }

  const content = JSON.stringify(merged, null, 2) + '\n';
  const encoded = btoa(unescape(encodeURIComponent(content)));

  // PUT with retry on 409 (stale SHA)
  const doPut = async () => {
    const shaRes = await fetch(apiPath, { headers });
    const shaJson = shaRes.ok ? await shaRes.json() : {};
    const putBody = { message: 'Update URL overrides', content: encoded };
    if (shaJson.sha) putBody.sha = shaJson.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(putBody) });
  };

  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
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
  scheduleUserSettingsSync();
}

// Archived items are persisted to docs/data/archived_items.json (the shared,
// cross-device source of truth) but the archive VIEW reads only from local
// priorities. On a fresh browser / cleared storage that view was empty even
// though the repo file had items. Pull the file in and merge any names that
// aren't already assigned a local priority, so archives show up everywhere.
let _repoArchivedSet = new Set(); // names from docs/data/archived_items.json

async function mergeArchivedFromRepo() {
  try {
    const res = await fetch(`data/archived_items.json?t=${Date.now()}`);
    if (!res.ok) return;
    const names = await res.json();
    if (!Array.isArray(names) || !names.length) return;
    _repoArchivedSet = new Set(names);
    const pr = loadPriorities();
    let changed = false;
    names.forEach(name => {
      if (pr[name] == null) { pr[name] = 'archive'; changed = true; }
    });
    if (changed) savePriorities(pr);
  } catch { /* offline / missing file — non-fatal */ }
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
  scheduleUserSettingsSync();
}

// ── Category overrides ───────────────────────────────────────────────────────

const KNOWN_CATEGORIES = [
  'Fruit & Veg', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen Foods',
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
  // Variant groups carry their own priority under the synthetic group key; default Weekly.
  if (typeof itemName === 'string' && itemName.startsWith('__group_')) {
    return loadPriorities()[itemName] || 'weekly';
  }
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
  if (_perkgSet.has(itemName) || (typeof itemName === 'string' && itemName.startsWith('__group_'))) return 1.0;
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

// Per-item category corrections — applied after CATEGORY_REMAP, before user localStorage overrides win.
// These fix scraper mismatches without needing to edit latest.json.
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

function getCategory(item) {
  const ov = loadCategoryOverrides()[item.list_item];
  if (ov) return ov;
  const c = (item.category || '').trim();
  const remapped = CATEGORY_REMAP[c] || c || 'Other';
  return ITEM_CATEGORY_DEFAULTS[item.list_item] || remapped;
}

// ── Filter state ─────────────────────────────────────────────────────────────

let _activePriority = 'weekly';
let _showHotOnly = false;
let _storeFilter = 'all';
let _showPricesOnly = false;

function _updateStoreCycleBtn() {
  const btn = $('storeCycleBtn');
  if (!btn) return;
  const faces = {
    all:         'All stores',
    woolworths:  '<span class="store-chip ww sm">W</span> only',
    coles:       '<span class="store-chip coles sm">C</span> only',
  };
  btn.innerHTML = faces[_storeFilter] || faces.all;
  btn.classList.toggle('active', _storeFilter !== 'all');
}
let _searchQuery = '';
let _perkgSet = new Set();   // items compared by $/kg (synced via user_settings.json)
let _showPerKgOnly = false;  // TEMP dev filter (web only) — show only per-kg items

// Per-kg categories. Each is a comparable product type; the two near-identical
// salmon-fillet and basa entries are merged so each category holds its real
// equivalents. Membership can be fine-tuned in the edit dialog (DEFAULT_VARIANT_GROUPS
// is the seed; user overrides live in localStorage — see loadVariantGroups()).
const DEFAULT_VARIANT_GROUPS = [
  { key: 'chicken_breast', label: 'Chicken Breast', items: [
    'Woolworths RSPCA Approved Chicken Breast Fillet',
  ]},
  { key: 'chicken_drumsticks', label: 'Chicken Drumsticks', items: [
    'Woolworths RSPCA Approved Chicken Drumsticks',
  ]},
  { key: 'chicken_thigh', label: 'Chicken Thigh', items: [
    'Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone-In',
  ]},
  { key: 'chicken_roast', label: 'Chicken Roast Portions', items: [
    'Woolworths Cook Chicken Roasting Portions Italian Style',
  ]},
  { key: 'salmon_fillets', label: 'Salmon Fillets', items: [
    'Woolworths Fresh Tasmanian Atlantic Skin On Salmon Fillets',
    'Woolworths Salmon Tasmanian Atlantic Fillets Skin On',
  ]},
  { key: 'salmon_portions', label: 'Salmon Portions', items: [
    'Woolworths Salmon Portions Skin On',
  ]},
  { key: 'basa_fillets', label: 'Basa Fillets', items: [
    'Woolworths Basa Fillets Boneless With Skin Off',
  ]},
  { key: 'beef_mince', label: 'Beef Mince', items: [
    'Woolworths Lean Beef Mince',
  ]},
  { key: 'lamb_mince', label: 'Lamb Mince', items: [
    'Woolworths Lamb Mince',
  ]},
];

// Effective categories = seed defaults merged with the user's saved label/membership
// overrides (pw_perkg_cats_v1). Returns a fresh array each call.
function loadVariantGroups() {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  return DEFAULT_VARIANT_GROUPS.map(g => {
    const o = ov[g.key] || {};
    return {
      key: g.key,
      label: o.label || g.label,
      items: Array.isArray(o.items) ? o.items : g.items.slice(),
    };
  });
}
function saveVariantGroupOverride(key, patch) {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  ov[key] = { ...(ov[key] || {}), ...patch };
  localStorage.setItem('pw_perkg_cats_v1', JSON.stringify(ov));
}
// Products excluded from a category's $/kg (per category+item+store). Key form:
// "catKey::list_item::ww|coles". Stored in pw_perkg_excl_v1.
function loadPerKgExclusions() {
  try { return new Set(JSON.parse(localStorage.getItem('pw_perkg_excl_v1') || '[]')); } catch { return new Set(); }
}
function savePerKgExclusions(set) {
  localStorage.setItem('pw_perkg_excl_v1', JSON.stringify([...set]));
}
let _expandedGroups = new Set();
let _watchlist = new Set(); // loaded on boot from localStorage + watchlist.json
let _approvedWarns = new Set(); // loaded from approved_warns.json
let _selectedItems = new Set(); // session-only mobile card selection
let _viewMode = localStorage.getItem('pw_view_mode') || 'table'; // 'table' | 'card'
let _mcView = localStorage.getItem('pw_mc_view_v1') || 'detailed'; // mobile card view: 'detailed' | 'compact'
let _density = localStorage.getItem('pw_density') || 'comfortable'; // 'comfortable' | 'compact'

// ── Bulk selection ────────────────────────────────────────────────────────────

let _checkedItems = new Set();

function updateBulkBar() {
  const bar = $('bulkToolbar');
  if (!bar) return;
  const count = _checkedItems.size;
  bar.style.display = count > 0 ? 'flex' : 'none';
  const pill = bar.querySelector('.bt-count-pill');
  if (pill) pill.textContent = count;
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
    case 'saving':    { const s = savingAmount(item); return s != null ? s * getUnits(item.list_item) : null; }
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
    case 'saving':       { const s = savingAmount(item); return s > 0 ? fmt(s * getUnits(item.list_item)) : '—'; }
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

function savingAmount(item) {
  const w = item.woolworths?.price, c = item.coles?.price;
  if (w == null || c == null) return item.saving_per_item ?? 0;
  return Math.abs(w - c);
}

function buildPriceBar(itemName, priceHistory, currentPrice, factor = 1) {
  if (!priceHistory?.length || currentPrice == null) return '';

  const exclusions = loadExclusions();
  // Support new "ww:X.XX"/"coles:X.XX" format and old bare-number format (treated as ww).
  // For trend bars (mixed WW+Coles series) we exclude a price if excluded for any store.
  const excluded = new Set((exclusions[itemName] || []).map(k => {
    if (typeof k === 'number') return Number(k).toFixed(2);
    const str = String(k);
    return str.includes(':') ? str.split(':')[1] : Number(str).toFixed(2);
  }));
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
  if (!s.token) {
    alert('Please add your GitHub token first (⚙ Auto-update Setup button).');
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
    user:  localStorage.getItem('gh_user')  || 'jtsenter',
    repo:  localStorage.getItem('gh_repo')  || 'price-comparison',
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
let _priceHistChart = null;
let _pendingExcl = null; // staged exclusions (Set), null when modal is closed

function _closePriceHistoryModal() {
  const modal = $('priceHistoryModal');
  if (!modal) return;
  modal.classList.remove('open');
  _historyItem = null;
  _pendingExcl = null;
  if (_priceHistChart) { _priceHistChart.destroy(); _priceHistChart = null; }
  document.body.style.overflow = '';
  const leg = document.getElementById('priceHistChartLegend');
  if (leg) leg.remove();
}

function initPriceHistoryModal() {
  const modal = $('priceHistoryModal');
  if (!modal) return;

  $('priceHistoryClose').addEventListener('click', _closePriceHistoryModal);
  $('priceHistoryClose2').addEventListener('click', _closePriceHistoryModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) _closePriceHistoryModal(); });

  $('priceHistoryReset').addEventListener('click', () => {
    if (!_historyItem) return;
    _pendingExcl = new Set();
    openPriceHistoryModal(_historyItem);
  });

  $('priceHistorySave').addEventListener('click', () => {
    if (!_historyItem || _pendingExcl === null) return;
    const itemName = _historyItem.list_item;
    // Snapshot the previously-saved exclusions for this item so Save is reversible.
    const before = loadExclusions();
    const prevForItem = before[itemName] ? [...before[itemName]] : null;
    const newCount = _pendingExcl.size;

    // Snapshot the new value BEFORE closing (close() nulls _pendingExcl).
    const newForItem = newCount === 0 ? null : [..._pendingExcl];

    const ex = loadExclusions();
    if (newCount === 0) {
      delete ex[itemName];
    } else {
      ex[itemName] = newForItem;
    }
    saveExclusions(ex);
    if (_lastData) renderPage(_lastData);
    _closePriceHistoryModal();

    // Only offer Undo when something actually changed.
    const changed = JSON.stringify(prevForItem) !== JSON.stringify(newForItem);
    if (changed) {
      showUndoToast(`Saved price exclusions for ${stripWW(itemName)}`, () => {
        const cur = loadExclusions();
        if (prevForItem) cur[itemName] = prevForItem;
        else delete cur[itemName];
        saveExclusions(cur);
        if (_lastData) renderPage(_lastData);
        showToast('Reverted');
      });
    }
  });
}


function buildPriceHistChart(item, excludedPrices) {
  const wrap = document.getElementById('priceHistChartWrap');
  const canvas = document.getElementById('priceHistChart');
  if (!wrap || !canvas || typeof Chart === 'undefined') return;

  if (_priceHistChart) { _priceHistChart.destroy(); _priceHistChart = null; }

  // WW: merge price_history (legacy/excel, WW-only) + ww_price_history (scraper)
  // Same merge logic as getTrendSeries: scraper entries win on same date
  const legacyMap = new Map(
    (item.price_history || [])
      .filter(e => e.date && e.price > 0)
      .map(e => [e.date, e.price])
  );
  const wwScrapeMap = new Map(
    (item.ww_price_history || [])
      .filter(e => e.date && e.price > 0)
      .map(e => [e.date, e.price])
  );
  const mergedWWMap = new Map([...legacyMap, ...wwScrapeMap]);
  const wwRaw = [...mergedWWMap.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Coles: coles_price_history only (no legacy equivalent)
  const coRaw = (item.coles_price_history || [])
    .filter(e => e.date && e.price > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  // excludedPrices is now a Set of "ww:X.XX" / "coles:X.XX" keys (or legacy bare numbers → ww)
  const exclWW = new Set([...excludedPrices].filter(k => !k.includes(':') || k.startsWith('ww:')).map(k => k.includes(':') ? k.split(':')[1] : k));
  const exclCo = new Set([...excludedPrices].filter(k => k.startsWith('coles:')).map(k => k.split(':')[1]));
  const isExclWW = v => v != null && exclWW.has(Number(v).toFixed(2));
  const isExclCo = v => v != null && exclCo.has(Number(v).toFixed(2));
  const wwFullMap = new Map(wwRaw.filter(e => !isExclWW(e.price)).map(e => [e.date, e.price]));
  const coMap     = new Map(coRaw.filter(e => !isExclCo(e.price)).map(e => [e.date, e.price]));

  const allDates = [...new Set([...wwFullMap.keys(), ...coMap.keys()])].sort();
  if (allDates.length < 2) {
    const el = document.getElementById('priceHistChartLegend'); if (el) el.remove();
    wrap.style.display = 'none'; return;
  }

  const wwData = [], coData = [], wwIsActual = [], coIsActual = [];
  let lastWW = null, lastCo = null;

  for (const date of allDates) {
    if (wwFullMap.has(date)) {
      lastWW = wwFullMap.get(date);
      wwData.push(lastWW); wwIsActual.push(true);
    } else if (lastWW !== null) {
      wwData.push(lastWW); wwIsActual.push(false);  // carry forward
    } else {
      wwData.push(null); wwIsActual.push(false);    // before first WW point
    }

    if (coMap.has(date)) {
      lastCo = coMap.get(date);
      coData.push(lastCo); coIsActual.push(true);
    } else if (lastCo !== null) {
      coData.push(lastCo); coIsActual.push(false);
    } else {
      coData.push(null); coIsActual.push(false);
    }
  }

  const allPrices = [...wwData, ...coData].filter(p => p != null);
  if (!allPrices.length) {
    const el = document.getElementById('priceHistChartLegend'); if (el) el.remove();
    wrap.style.display = 'none'; return;
  }
  const dataMin = Math.min(...allPrices);
  const dataMax = Math.max(...allPrices);
  const range = dataMax - dataMin;
  const padding = range < 0.01 ? 0.50 : range * 0.4;
  const yMin = Math.max(0, Math.floor((dataMin - padding) * 10) / 10);
  const yMax = Math.ceil((dataMax + padding * 0.5) * 10) / 10;

  const yRange = yMax - yMin;
  const coOffset = yRange * 0.02;
  const coDataOffset = coData.map(v => v !== null ? Math.round((v + coOffset) * 1000) / 1000 : null);

  const labels = allDates.map(d => {
    const [y, mo, day] = d.split('-').map(Number);
    return new Date(y, mo - 1, day)
      .toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
  });

  const makeDataset = (label, data, isActual, color) => ({
    label,
    data,
    borderColor: color,
    backgroundColor: 'transparent',
    stepped: 'before',
    tension: 0,
    spanGaps: true,
    pointRadius: isActual.map(a => a ? 4 : 0),
    pointHoverRadius: 5,
    pointBackgroundColor: isActual.map(a => a ? color : 'transparent'),
    pointBorderColor:     isActual.map(a => a ? color : 'transparent'),
  });

  // Insert custom HTML legend
  const existingLeg = document.getElementById('priceHistChartLegend');
  if (existingLeg) existingLeg.remove();
  const chartLegend = document.createElement('div');
  chartLegend.id = 'priceHistChartLegend';
  chartLegend.style.cssText = 'display:flex;align-items:center;gap:20px;margin-bottom:10px;font-size:12px;color:var(--color-text-secondary,#888);';
  chartLegend.innerHTML =
    '<span style="display:flex;align-items:center;gap:6px;">'
    + '<span style="width:20px;height:3px;background:#16a34a;display:inline-block;border-radius:2px;"></span>'
    + 'Woolworths</span>'
    + '<span style="display:flex;align-items:center;gap:6px;">'
    + '<span style="width:20px;height:3px;background:#dc2626;display:inline-block;border-radius:2px;"></span>'
    + 'Coles</span>';
  wrap.parentNode.insertBefore(chartLegend, wrap);
  wrap.style.display = 'block';

  _priceHistChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        makeDataset('Woolworths', wwData, wwIsActual, '#22c55e'),
        { ...makeDataset('Coles', coDataOffset, coIsActual, '#dc2626'),
          borderWidth: 2.5 },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const store = ctx.dataset.label;
              const raw = ctx.raw;
              if (raw === null) return `${store}: no data yet`;
              const display = store === 'Coles'
                ? Math.round((raw - coOffset) * 100) / 100
                : raw;
              return `${store}: $${display.toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 }, maxRotation: 45, color: '#6b7280' },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: { callback: v => '$' + Number(v).toFixed(2), font: { size: 11 }, color: '#6b7280' },
          grid: { color: 'rgba(107,114,128,0.12)' },
        },
      },
    },
  });
}

function openPriceHistoryModal(item) {
  _historyItem = item;
  $('priceHistoryTitle').textContent = `Price History — ${stripWW(item.list_item)}`;

  // Initialize pending on fresh open; re-renders reuse existing _pendingExcl
  if (_pendingExcl === null) {
    const excl = loadExclusions();
    _pendingExcl = new Set((excl[item.list_item] || []).map(k => String(k)));
  }
  const isWWExcl  = price => price != null && _pendingExcl.has(`ww:${Number(price).toFixed(2)}`);
  const isCoExcl  = price => price != null && _pendingExcl.has(`coles:${Number(price).toFixed(2)}`);
  const excludedPrices = _pendingExcl;

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

  // If the current live price isn't already the top history entry, inject it so it's always visible
  const wwLive = item.woolworths?.price ?? null;
  const coLive = item.coles?.price ?? null;
  const wwScraped = item.woolworths?.scraped_at?.slice(0, 10) ?? null;
  const coScraped = item.coles?.scraped_at?.slice(0, 10) ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const liveDate = wwScraped || coScraped || today;
  const wwAlreadyIn = wwLive == null || wwMap.has(liveDate);
  const coAlreadyIn = coLive == null || coMap.has(liveDate);
  const alreadyInHistory = wwAlreadyIn && coAlreadyIn;
  const liveEntry = !alreadyInHistory && (wwLive != null || coLive != null)
    ? [{ date: liveDate, ww: wwLive, coles: coLive, source: 'live' }]
    : [];

  const allEntries = [...liveEntry, ...excelEntries, ...scrapeEntries]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Merge same-date entries: if prices match, collapse into one row; if prices differ, keep both
  const _dateGroups = new Map();
  allEntries.forEach(e => {
    const g = _dateGroups.get(e.date);
    if (g) g.push(e); else _dateGroups.set(e.date, [e]);
  });
  const dedupedEntries = [];
  _dateGroups.forEach((group, date) => {
    if (group.length === 1) { dedupedEntries.push(group[0]); return; }
    const wwPrices = [...new Set(group.map(e => e.ww).filter(p => p != null))];
    const coPrices = [...new Set(group.map(e => e.coles).filter(p => p != null))];
    if (wwPrices.length <= 1 && coPrices.length <= 1) {
      dedupedEntries.push({ date, ww: wwPrices[0] ?? null, coles: coPrices[0] ?? null, source: group.map(e => e.source).join(',') });
    } else {
      group.forEach(e => dedupedEntries.push(e));
    }
  });

  const listEl = $('priceHistoryList');
  listEl.innerHTML = '';

  if (!allEntries.length) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-soft);font-size:13px;">No price history available.</div>';
    document.body.style.overflow = 'hidden';
    $('priceHistoryModal').classList.add('open');
    return;
  }
  const displayEntries = dedupedEntries.length ? dedupedEntries : allEntries;

  // Column header
  const hdr = document.createElement('div');
  hdr.className = 'price-history-row';
  hdr.style.cssText = 'background:var(--bg);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;';
  hdr.innerHTML = `
    <span class="price-history-date" style="color:var(--text-soft)">Date</span>
    <span class="price-history-store-col"><span class="store-chip sm ww">W</span></span>
    <span class="price-history-store-col"><span class="store-chip sm coles">C</span></span>`;
  listEl.appendChild(hdr);

  displayEntries.forEach((entry, idx) => {
    const wwExcluded = isWWExcl(entry.ww);
    const coExcluded = isCoExcl(entry.coles);
    let rowClass = 'price-history-row';
    if (wwExcluded)  rowClass += ' excluded-ww';
    if (coExcluded)  rowClass += ' excluded-coles';

    const row = document.createElement('div');
    row.className = rowClass;

    // Horizontal stem on the left that splits into two diverging arrows (one up,
    // one down) on the right — matches the requested "split into two directions" icon.
    const forkSvg = `<svg class="fork-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="10" y2="12"/><line x1="10" y1="12" x2="21" y2="4"/><line x1="10" y1="12" x2="21" y2="20"/><polyline points="19,8 21,4 17,5"/><polyline points="19,16 21,20 17,19"/></svg>`;

    const wwHtml = entry.ww != null
      ? `<span class="price-history-store-cell price-history-store-ww">
           <span class="price-history-price">${fmt(entry.ww)}</span>
           <button class="price-excl-x" data-store="ww" data-price="${Number(entry.ww).toFixed(2)}" title="${wwExcluded ? 'Re-include' : 'Exclude'}">✕</button>
           <button class="price-fork-btn" data-store="ww" data-price="${Number(entry.ww).toFixed(2)}" title="Different item">${forkSvg}</button>
         </span>`
      : `<span style="color:var(--text-soft)">—</span>`;

    const coHtml = entry.coles != null
      ? `<span class="price-history-store-cell price-history-store-coles">
           <span class="price-history-price" style="color:var(--coles)">${fmt(entry.coles)}</span>
           <button class="price-excl-x" data-store="coles" data-price="${Number(entry.coles).toFixed(2)}" title="${coExcluded ? 'Re-include' : 'Exclude'}">✕</button>
           <button class="price-fork-btn" data-store="coles" data-price="${Number(entry.coles).toFixed(2)}" title="Different item">${forkSvg}</button>
         </span>`
      : `<span style="color:var(--text-soft)">—</span>`;

    row.innerHTML = `
      <span class="price-history-date${idx === 0 ? ' ph-latest-date' : ''}">${entry.date || 'Unknown date'}</span>
      ${wwHtml}
      ${coHtml}`;

    row.querySelectorAll('.price-excl-x').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = `${btn.dataset.store}:${btn.dataset.price}`;
        if (_pendingExcl.has(key)) {
          _pendingExcl.delete(key);
        } else {
          _pendingExcl.add(key);
        }
        openPriceHistoryModal(item);
      });
    });

    row.querySelectorAll('.price-fork-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openDiffItemModal(item, btn.dataset.price, btn.dataset.store);
      });
    });

    listEl.appendChild(row);
  });

  buildPriceHistChart(item, excludedPrices);
  document.body.style.overflow = 'hidden';
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

// Toast with a one-click Undo button. `onUndo` is invoked if the user clicks
// Undo before the toast auto-dismisses. Single-level (latest action only).
function showUndoToast(msg, onUndo, durationMs = 8000) {
  const toast = $('toastNotif');
  if (!toast) { if (onUndo) {/* no UI: leave change applied */} return; }
  clearTimeout(toast._timer);
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo-btn';
  btn.textContent = 'Undo';
  const hide = () => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; toast.textContent = ''; }, 300);
  };
  btn.addEventListener('click', () => {
    clearTimeout(toast._timer);
    hide();
    try { onUndo && onUndo(); } catch (e) { console.error('undo failed', e); }
  });
  toast.appendChild(span);
  toast.appendChild(btn);
  toast.style.display = 'block';
  toast.style.opacity = '1';
  toast._timer = setTimeout(hide, durationMs);
}

// ── Image hover preview + picker modal ───────────────────────────────────────

function initImgPicker() {
  const preview = document.getElementById('imgHoverPreview');
  const previewImg = document.getElementById('imgHoverImg');
  const modal = document.getElementById('imgPickerModal');
  if (!preview || !modal) return;

  // Hover: show large preview near the thumbnail
  let _hoverTarget = null;
  document.addEventListener('mouseover', (e) => {
    const img = e.target.closest('.img-hoverable');
    if (!img) return;
    _hoverTarget = img;
    previewImg.src = img.src;
    preview.style.display = 'block';
  });
  document.addEventListener('mousemove', (e) => {
    if (!_hoverTarget) return;
    const margin = 12;
    let top = e.clientY + margin;
    let left = e.clientX + margin;
    const pw = preview.offsetWidth || 228, ph = preview.offsetHeight || 228;
    if (left + pw > window.innerWidth - 8) left = e.clientX - pw - margin;
    if (top + ph > window.innerHeight - 8) top = e.clientY - ph - margin;
    preview.style.top = `${top}px`;
    preview.style.left = `${left}px`;
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.img-hoverable')) {
      _hoverTarget = null;
      preview.style.display = 'none';
    }
  });

  // Click: open picker modal
  let _pickerItem = null;
  const closeModal = () => { modal.classList.remove('open'); _pickerItem = null; };
  document.getElementById('imgPickerClose')?.addEventListener('click', closeModal);
  document.getElementById('imgPickerCancel')?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  document.addEventListener('click', (e) => {
    const img = e.target.closest('.img-hoverable');
    if (!img) return;
    e.stopPropagation();
    const itemName = img.dataset.item;
    const wwImg    = img.dataset.wwImg || '';
    const coImg    = img.dataset.coImg || '';
    if (!wwImg && !coImg) return; // nothing to pick
    _pickerItem = itemName;

    const current = loadImgOverrides()[itemName] || (coImg ? 'coles' : 'ww');
    const opts = document.getElementById('imgPickerOptions');
    opts.innerHTML = '';

    const makeOpt = (store, src, label) => {
      if (!src) return;
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer';
      const isActive = current === store;
      wrap.innerHTML = `
        <img src="${src}" style="width:150px;height:150px;object-fit:contain;border-radius:8px;
          border:3px solid ${isActive ? 'var(--accent)' : 'var(--border)'};
          background:var(--bg);padding:4px" onerror="this.style.display='none'" />
        <span style="font-size:12px;font-weight:600;color:${isActive ? 'var(--accent)' : 'var(--text-soft)'}">
          ${label}${isActive ? ' ✓' : ''}
        </span>
        <button class="btn btn-ghost" style="font-size:12px;padding:4px 12px"
          data-store="${store}" data-item="${itemName.replace(/"/g, '&quot;')}">Use this</button>`;
      opts.appendChild(wrap);
    };
    makeOpt('ww', wwImg, 'Woolworths');
    makeOpt('coles', coImg, 'Coles');

    opts.querySelectorAll('[data-store]').forEach(btn => {
      btn.addEventListener('click', () => {
        const ov = loadImgOverrides();
        ov[btn.dataset.item] = btn.dataset.store;
        saveImgOverrides(ov);
        closeModal();
        if (_lastData) renderPage(_lastData);
      });
    });

    modal.classList.add('open');
  });
}

// ── Different Item modal ─────────────────────────────────────────────────────

let _diffItemContext = null; // { item, priceKey, priority }

function initDiffItemModal() {
  const modal = $('diffItemModal');
  if (!modal) return;
  const close = () => {
    modal.classList.remove('open');
    // If price history modal was open behind this, reopen it
    if (_diffItemContext?.fromHistory && _historyItem) {
      $('priceHistoryModal').classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    _diffItemContext = null;
  };
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

async function openDiffItemModal(item, priceKey, store) {
  const priority = getPriority(item.list_item);
  // Store context — mutation deferred until Confirm is clicked.
  // `store` ('ww'|'coles') identifies which store's matched product was wrong,
  // so on confirm we can blocklist that product for this item AND pin it to the new one.
  _diffItemContext = { item, priceKey, priority, store, fromHistory: true };

  const badge = $('diffItemPriorityBadge');
  if (badge) {
    badge.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
    badge.className = `diff-item-priority-badge ${priority}`;
  }
  const priceEl = $('diffItemPrice');
  if (priceEl) priceEl.textContent = fmt(Number(priceKey));

  $('diffItemInput').value = '';
  $('diffItemConfirm').disabled = true;
  $('diffItemConfirm').textContent = 'Add Item & Scrape';
  // Keep price history modal in the DOM (just hidden) so Cancel can restore it
  $('priceHistoryModal').classList.remove('open');
  $('diffItemModal').classList.add('open');
  setTimeout(() => $('diffItemInput')?.focus(), 80);
}

async function doDiffItemAdd(newName, ctx) {
  const s = loadSettings();
  const priceNum = Number(ctx.priceKey);

  // Now that user confirmed — remove the misidentified price from history
  const liveItem = _lastData?.items?.find(i => i.list_item === ctx.item.list_item);
  if (liveItem) {
    liveItem.price_history       = (liveItem.price_history       || []).filter(e => e.price !== priceNum);
    liveItem.ww_price_history    = (liveItem.ww_price_history    || []).filter(e => e.price !== priceNum);
    liveItem.coles_price_history = (liveItem.coles_price_history || []).filter(e => e.price !== priceNum);
  }
  const ex = loadExclusions();
  if (ex[ctx.item.list_item]) {
    ex[ctx.item.list_item] = ex[ctx.item.list_item].filter(p => Number(p).toFixed(2) !== ctx.priceKey);
    saveExclusions(ex);
  }

  // #5: the product the scraper wrongly matched to this item IS the "different item".
  // Capture that store's current product URL so we can (a) blocklist it for the original
  // item and (b) pin it onto the new item. Only possible when we know the URL.
  const store = ctx.store === 'coles' ? 'coles' : (ctx.store === 'ww' ? 'ww' : null);
  const wrongUrl = store === 'ww'    ? (ctx.item.woolworths?.url || '')
                 : store === 'coles' ? (ctx.item.coles?.url || '')
                 : '';
  if (wrongUrl) {
    const rej = loadRejected();
    rej[ctx.item.list_item] = rej[ctx.item.list_item] || {};
    rej[ctx.item.list_item][store] = [...new Set([...(rej[ctx.item.list_item][store] || []), wrongUrl])];
    saveRejected(rej);
  }

  // Persist the removal to GitHub before adding new item
  if (s.user && s.repo && s.token) {
    try {
      await persistLatestJson(_lastData, `fix: remove misidentified price entries for "${ctx.item.list_item}"`);
    } catch (_e) {
      showToast('⚠ Could not save changes — check your GitHub token');
      if (_lastData) renderPage(_lastData);
      return;
    }
  }

  // Duplicate check
  const exists = _lastData?.items?.some(i => i.list_item.toLowerCase() === newName.toLowerCase());
  if (exists) {
    const proceed = window.confirm(`"${newName}" already exists in your list. Add it anyway?`);
    if (!proceed) return;
  }

  // #5: pin the wrongly-matched product URL onto the NEW item so it scrapes the
  // correct product from the first run (the matcher is bypassed for pinned URLs).
  if (wrongUrl) {
    const ov = loadOverrides();
    ov[newName] = ov[newName] || {};
    if (store === 'ww') ov[newName].wwUrl = wrongUrl;
    else                ov[newName].colesUrl = wrongUrl;
    saveOverrides(ov);
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

  // Persist latest.json (now includes the new stub) + the blocklist/pin files
  if (s.user && s.repo && s.token) {
    await persistLatestJson(_lastData, `feat: add "${newName}" from different-item flow`);
    if (wrongUrl) {
      try {
        await persistRejectedToRepo(s, loadRejected());
        await persistUrlOverridesToRepo(s, loadOverrides());
      } catch (_e) {
        showToast('⚠ Item added, but saving the URL correction to GitHub failed');
      }
    }
  }

  if (_lastData) renderPage(_lastData);

  // Step 4: single-item scrape
  if (!s.token) {
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

  const _inputs = { trigger: 'manual', item: newName };
  if (wrongUrl && store === 'ww')    _inputs.ww_url = wrongUrl;
  if (wrongUrl && store === 'coles') _inputs.coles_url = wrongUrl;
  const dispRes = await fetch(
    `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: _inputs }),
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
        _storeFilter = 'all';
        const scrapeArchBtn = $('scrapeArchivedBtn');
        if (scrapeArchBtn) scrapeArchBtn.style.display = _activePriority === 'archive' ? 'inline-flex' : 'none';
        // Keep the mobile frequency dropdown in sync with the active frequency.
        const fs = $('freqSelect');
        if (fs && ['all', 'weekly', 'monthly', 'rare', 'archive'].includes(_activePriority)) fs.value = _activePriority;
        // Search is intentionally preserved across priority/category tab switches
      }
      if (_lastData) renderPage(_lastData);
    });
  });

  // Mobile frequency dropdown — drives the same logic by clicking the hidden pill.
  const freqSelect = $('freqSelect');
  if (freqSelect) {
    freqSelect.value = ['all', 'weekly', 'monthly', 'rare', 'archive'].includes(_activePriority) ? _activePriority : 'weekly';
    freqSelect.addEventListener('change', () => {
      container.querySelector(`.priority-pill[data-priority="${freqSelect.value}"]`)?.click();
    });
  }

  function _toggleHotDeals() {
    _showHotOnly = !_showHotOnly;
    $('hotFilterBtn')?.classList.toggle('active', _showHotOnly);
    $('mobileHotBtn')?.classList.toggle('active', _showHotOnly);
    const cycleBtn = $('storeCycleBtn');
    if (cycleBtn) cycleBtn.style.display = _showHotOnly ? 'inline-flex' : 'none';
    if (!_showHotOnly) { _storeFilter = 'all'; _updateStoreCycleBtn(); }
    if (_lastData) renderPage(_lastData);
  }

  const hotBtn = $('hotFilterBtn');
  if (hotBtn) hotBtn.addEventListener('click', _toggleHotDeals);

  const mobileHotBtn = $('mobileHotBtn');
  if (mobileHotBtn) mobileHotBtn.addEventListener('click', _toggleHotDeals);

  // Mobile watchlist header icon — drives the (hidden-on-mobile) watchlist pill,
  // which already toggles itself off when re-clicked.
  const mobileWatchBtn = $('mobileWatchBtn');
  if (mobileWatchBtn) {
    mobileWatchBtn.addEventListener('click', () => {
      container.querySelector('.watchlist-pill')?.click();
      mobileWatchBtn.classList.toggle('active', _activePriority === 'watchlist');
    });
  }

  const cycleBtn = $('storeCycleBtn');
  if (cycleBtn) {
    cycleBtn.addEventListener('click', () => {
      const order = ['all', 'woolworths', 'coles'];
      _storeFilter = order[(order.indexOf(_storeFilter) + 1) % order.length];
      _updateStoreCycleBtn();
      if (_lastData) renderPage(_lastData);
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

// ── Mobile card selection pill ────────────────────────────────────────────────

function _updateSelectedPill() {
  // Floating "+ Basket (n)" button — visible whenever ≥1 item is selected
  const fab = $('basketFab');
  if (fab) {
    const fc = $('basketFabCount');
    if (fc) fc.textContent = _selectedItems.size;
    fab.classList.toggle('show', _selectedItems.size > 0);
    document.getElementById('mobileCards')?.classList.toggle('fab-visible', _selectedItems.size > 0);
  }
  const pill = $('selectedPill');
  const count = $('selectedCount');
  if (!pill) return;
  const n = _selectedItems.size;
  pill.style.display = n > 0 ? '' : 'none';
  if (count) count.textContent = n;
  // If now 0, exit selected filter
  if (n === 0 && _activePriority === 'selected') {
    _activePriority = 'all';
    document.querySelector('#priorityFilter [data-priority="all"]')?.classList.add('active');
    pill.classList.remove('active');
    if (_lastData) renderPage(_lastData);
  }
}

function initSelectedPill() {
  $('selectedPill')?.addEventListener('click', () => {
    if (_selectedItems.size === 0) return;
    if (_activePriority === 'selected') {
      // Toggle off
      _activePriority = 'all';
      $('selectedPill')?.classList.remove('active');
      document.querySelector('#priorityFilter .priority-pill[data-priority="all"]')?.classList.add('active');
    } else {
      _activePriority = 'selected';
      document.querySelectorAll('#priorityFilter .priority-pill').forEach(b => b.classList.remove('active'));
      $('selectedPill')?.classList.add('active');
    }
    if (_lastData) renderPage(_lastData);
  });
}

// ── Archive sync (module-level so initBulkBar callbacks can reach it) ─────────

let _archiveSyncTimer = null;
async function syncArchivedToGitHub() {
  const s = loadSettings();
  if (!s.token) return;
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

function unarchiveItem(itemName) {
  const pr = loadPriorities();
  if (pr[itemName] === 'archive') {
    pr[itemName] = 'monthly'; // restore to monthly (safest default)
  } else {
    delete pr[itemName];
  }
  savePriorities(pr);
  scheduleArchiveSync(); // debounced write to archived_items.json
  if (_lastData) renderPage(_lastData);
}

// ── Bulk action bar ───────────────────────────────────────────────────────────

function initBulkBar() {
  const bar = $('bulkToolbar');
  if (!bar) return;

  // Helper: floating chip dropdown anchored above its button
  function openChipDropdown(btn, items, onSelect) {
    document.querySelectorAll('.bt-dropdown').forEach(d => d.remove());
    const drop = document.createElement('div');
    drop.className = 'bt-dropdown';
    items.forEach(({ label, value }) => {
      const el = document.createElement('button');
      el.className = 'bt-dropdown-item';
      el.textContent = label;
      el.addEventListener('click', () => { onSelect(value); drop.remove(); });
      drop.appendChild(el);
    });
    document.body.appendChild(drop);
    const rect = btn.getBoundingClientRect();
    drop.style.left = rect.left + 'px';
    drop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!drop.contains(e.target) && e.target !== btn) {
          drop.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 0);
  }

  bar.querySelector('.bt-deselect')?.addEventListener('click', () => {
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
  });

  bar.querySelector('.bt-cat')?.addEventListener('click', (e) => {
    openChipDropdown(e.currentTarget, KNOWN_CATEGORIES.map(c => ({ label: c, value: c })), (cat) => {
      const ov = loadCategoryOverrides();
      _checkedItems.forEach(name => { ov[name] = cat; });
      saveCategoryOverrides(ov);
      if (_lastData) renderPage(_lastData);
    });
  });

  bar.querySelector('.bt-pri')?.addEventListener('click', (e) => {
    openChipDropdown(e.currentTarget, [
      { label: '⭐ Weekly',  value: 'weekly'  },
      { label: '📅 Monthly', value: 'monthly' },
      { label: '🔵 Rare',    value: 'rare'    },
    ], (p) => {
      const pr = loadPriorities();
      _checkedItems.forEach(name => { pr[name] = p; });
      savePriorities(pr);
      if (_lastData) renderPage(_lastData);
      scheduleArchiveSync();
    });
  });

  bar.querySelector('.bt-sl')?.addEventListener('click', () => exportShoppingList(true));

  bar.querySelector('.bt-archive')?.addEventListener('click', () => {
    const pr = loadPriorities();
    _checkedItems.forEach(name => { pr[name] = 'archive'; });
    savePriorities(pr);
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
    scheduleArchiveSync();
  });
}

// ── Banner stats (priority-aware) ────────────────────────────────────────────

function computeBannerStats(items) {
  const exclusions = loadExclusions();
  const filtered = items.filter(item => {
    if (_activePriority === 'watchlist') {
      if (!_watchlist.has(item.list_item)) return false;
    } else if (_activePriority === 'selected') {
      if (!_selectedItems.has(item.list_item)) return false;
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
    if (_showHotOnly && !isHotDeal(item)) return false;
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
  // "Max saving": buy each item at whichever store is cheapest, vs doing the
  // whole shop at the more expensive single store. This is the most you could
  // possibly save by splitting the basket across both stores.
  const cherry_total = filtered.reduce((s, i) => {
    const u = getUnits(i.list_item);
    return s + Math.min(i.woolworths.price, i.coles.price) * u;
  }, 0);
  const max_saving = Math.max(ww_total, co_total) - cherry_total;
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
    max_saving: Math.round(max_saving * 100) / 100,
    items_compared: filtered.length,
  };
}

// Renders the two saving figures shown between the store cards:
//   • Basket saving — the gap between the two whole-basket totals (matches the cards).
//   • Max saving — buy each item at its cheaper store vs the dearer single store.
//     Only shown when splitting the shop beats just visiting the cheaper store.
function renderSavingInfo(s) {
  // Basket saving carries the cheaper store's logo; max saving carries a split
  // W│C disc to signal "buy across both stores".
  const cheaperChip = s.cheaper_store === 'coles'
    ? '<span class="store-chip coles sm">C</span>'
    : '<span class="store-chip ww sm">W</span>';
  const splitIcon = `<svg class="split-icon" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 A14 14 0 0 0 16 30 Z" fill="var(--ww)"/><path d="M16 2 A14 14 0 0 1 16 30 Z" fill="var(--coles)"/><line x1="16" y1="2" x2="16" y2="30" stroke="var(--card)" stroke-width="2.5"/></svg>`;
  const basket = `<div class="saving-line"><span class="saving-icon">${cheaperChip}</span><div class="saving-text"><div class="saving-label">Basket saving</div><span class="saving-amount">${fmt(s.total_saving)}</span></div></div>`;
  let maxRow = '';
  if (s.max_saving > s.total_saving + 0.005) {
    maxRow = `<div class="saving-line" title="Buy each item at whichever store is cheapest, vs doing your whole shop at the dearer store"><span class="saving-icon">${splitIcon}</span><div class="saving-text"><div class="saving-label">Max saving · split shop</div><span class="saving-amount">${fmt(s.max_saving)}</span></div></div>`;
  }
  return basket + maxRow;
}

// ── Category tabs ────────────────────────────────────────────────────────────

let _activeCategory = 'All';

function buildCategoryTabs(items) {
  const container = $('categoryTabs');
  if (!container) return;

  const present = new Set();
  items.forEach(i => present.add(getCategory(i)));

  // Order: KNOWN_CATEGORIES first (in defined grocery-store order), then any unknowns, then Other last
  const ordered = [
    ...KNOWN_CATEGORIES.filter(c => present.has(c)),
    ...[...present].filter(c => !KNOWN_CATEGORIES.includes(c) && c !== 'Other').sort(),
    ...(present.has('Other') ? ['Other'] : []),
  ];
  const cats = ['All', ...ordered];

  // The frequency dropdown leads the category row on mobile (one row instead of
  // two). Hold a reference across the innerHTML reset, then re-insert it first.
  // It's display:none on desktop, so living here is harmless there.
  const freqSel = $('freqSelect');
  container.innerHTML = '';
  if (freqSel) container.appendChild(freqSel);
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
  if (!s.token) {
    alert('Please add your GitHub token first (⚙ Auto-update Setup button).');
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

  // finish(true)  — run succeeded: clear timer, reload data
  // finish(false) — run explicitly failed (bad conclusion from GitHub API)
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

  // lostConnection() — poll timed out or network error, NOT an explicit failure.
  // Keep the progress bar visible at its last known %, show a recoverable message
  // with a Refresh button that restarts polling from Phase 1.
  const lostConnection = () => {
    // Do NOT clear dataPollTimer — the data poll keeps running in case the
    // scrape-progress branch catches up later.
    btn.innerHTML = '↻ Update Prices';
    btn.disabled = false;
    const strip = $('scrapeStrip');
    if (strip && strip.style.display !== 'none') {
      $('scrapeStripLabel').innerHTML =
        '⚠ Lost connection — <a href="https://github.com/' +
        `${s.user}/${s.repo}/actions" target="_blank" style="color:inherit">check GitHub Actions</a>`;
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = 'inline-block';
    }
    // Restart Phase 1 polling after a short delay so the user can recover
    // by waiting rather than having to click Refresh themselves.
    findAttempts = 0;
    setTimeout(findRun, 15000);
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
    if (++findAttempts > 12) { lostConnection(); return; }
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
      if (++waitAttempts > 90) { lostConnection(); return; }
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
  if (!s.token) return null;
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

let sortKeys = [{ col: 'trend', dir: 'asc' }];
let _mobileSortMode = 'trend'; // 'default' | 'trend' | 'az' | 'savings'
let _mobileSortDir  = 'asc';  // 'asc' | 'desc'

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
    // TEMP dev filter (web only): show only the per-kg variant groups, ignore all else
    if (_showPerKgOnly) return !!item._isGroup;
    // Watchlist filter: show only watchlisted items; bypass archive/priority checks
    if (_activePriority === 'watchlist') return _watchlist.has(item.list_item);
    // Mobile selection filter
    if (_activePriority === 'selected') return _selectedItems.has(item.list_item);
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
    if (_showHotOnly && !isHotDeal(item)) return false;
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
    // Hide items priced at neither store by default — they're noise in the main
    // list (the footer's coverage count still reports how many are missing).
    // Single-store items stay visible since one price is still useful. The
    // archive view is exempt so archived-but-unpriced items remain reachable.
    if (_activePriority !== 'archive' &&
        item.woolworths?.price == null && item.coles?.price == null) return false;
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
      case 'saving':   return savingAmount(item) ?? -Infinity;
      case 'trips':    return item.trip_count || 0;
      case 'units':    return getUnits(item.list_item);
      case 'priority': return PRIORITY_ORDER[getPriority(item.list_item)] ?? 99;
      case 'pct': {
        const ww = item.woolworths?.price, co = item.coles?.price;
        return (ww != null && co != null) ? Math.abs(ww - co) / Math.max(ww, co) : -Infinity;
      }
      case 'trend': return calcTrendPosition(item); // 0.0=best deal, 1.0=expensive, 999=no history (sorts last)
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
      // NaN guard: NaN comparisons always return false in JS, silently breaking sort stability.
      // Treat NaN as larger than everything so it sinks to the bottom regardless of direction.
      const aNan = typeof ai === 'number' && isNaN(ai);
      const bNan = typeof bi === 'number' && isNaN(bi);
      if (aNan && bNan) continue;
      if (aNan) return 1;
      if (bNan) return -1;
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
// isHotDeal() and calcTrendPosition() are provided by utils.js (loaded before app.js in index.html).
// Do not redefine them here — both pages must share the exact same implementation.

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
    const hotDeal = isHotDeal(item);
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
    const savingAmt = savingAmount(item) != null && savingAmount(item) > 0
      ? fmt(savingAmount(item) * units) : null;
    const savingHtml = savingAmt
      ? `<div class="card-saving">${cheaper==='woolworths'?'<span class="store-chip ww sm">W</span>':'<span class="store-chip coles sm">C</span>'} Save ${savingAmt}</div>`
      : '';

    // Match warning
    let warnHtml = '';
    const mc = item.match_confidence;
    if (mc === 'none' && !dismissed.includes(item.list_item) && !_approvedWarns.has(item.list_item)) {
      warnHtml = ` <span class="match-warn match-warn-none" title="Could not match this item" data-item="${safeKey}">⚠<button class="warn-dismiss" data-item="${safeKey}">✕</button></span>`;
    } else if ((mc === 'low' || item.size_warning) && !dismissed.includes(item.list_item) && !_approvedWarns.has(item.list_item)) {
      warnHtml = ` <span class="match-warn match-warn-low" title="Low-confidence match — verify these are the same product" data-item="${safeKey}">⚠<button class="warn-dismiss" data-item="${safeKey}">✕</button></span>`;
    }

    const _trendSeries = getTrendSeries(item);
    const bar = buildPriceBar(item.list_item, _trendSeries.prices.map(p => ({price: p})), _trendSeries.current);
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

// ── Variant groups (per-kg comparison) ────────────────────────────────────────
// Per-kg items (meat/fish) are collapsed into one synthetic "group" row each, so
// they render inline in the main table looking like normal product rows — image,
// WW-vs-Coles columns, links — but with $/kg as the headline (pack size varies
// across stores, so only $/kg is comparable). Expanding lists every member
// product as its own row with $/kg at each store.

// Pull a human pack-size label ("600g", "1.2kg") out of a scraped product name.
function perKgPackLabel(result) {
  if (!result) return '';
  const m = (result.name || '').match(/(\d[\d.]*\s*(?:kg|g|ml|l))\b/i);
  return m ? m[1].replace(/\s+/g, '') : '';
}

// Build synthetic group items from the per-kg member products present in the list.
function buildVariantGroups(byName) {
  const out = [];
  const excl = loadPerKgExclusions();
  for (const g of loadVariantGroups()) {
    // Members that aren't in latest.json yet (never scraped / scrape failed)
    // are kept as pending placeholders so they remain visible in the panel.
    const members = g.items.map(n => byName.get(n) || { list_item: n, _pending: true, woolworths: null, coles: null, price_history: [] });
    if (!members.length) continue;

    // Each member carries BOTH a WW and a Coles price, so collect per-store rankings.
    // A product excluded for this category (via the edit dialog) is skipped here.
    const ww = members
      .filter(m => !excl.has(`${g.key}::${m.list_item}::ww`))
      .map(m => ({ name: m.list_item, result: m.woolworths, perkg: clientPerKg(m.woolworths) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);
    const co = members
      .filter(m => !excl.has(`${g.key}::${m.list_item}::coles`))
      .map(m => ({ name: m.list_item, result: m.coles, perkg: clientPerKg(m.coles) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);

    const wwBest = ww[0] || null;
    const coBest = co[0] || null;
    let cheaper = null;
    if (wwBest && coBest) cheaper = wwBest.perkg < coBest.perkg ? 'woolworths' : (coBest.perkg < wwBest.perkg ? 'coles' : 'equal');
    else if (wwBest) cheaper = 'woolworths';
    else if (coBest) cheaper = 'coles';

    out.push({
      list_item: `__group_${g.key}`,
      _isGroup: true,
      _groupKey: g.key,
      _groupLabel: g.label,
      _members: members,
      _wwBest: wwBest,
      _coBest: coBest,
      _wwPerKg: wwBest ? wwBest.perkg : null,
      _coPerKg: coBest ? coBest.perkg : null,
      // Shape like a normal item so sort/helpers work; price = best variant's pack price.
      woolworths: wwBest ? wwBest.result : null,
      coles: coBest ? coBest.result : null,
      cheaper_store: cheaper,
      category: 'Meat & Seafood',
      trip_count: null,
      price_history: [],
    });
  }
  return out;
}

// A $/kg price cell: just the $/kg headline (linked). No pack-price subline —
// that lives in the expanded panel, where pack size actually matters.
function perKgCellHTML(perkg, url) {
  if (perkg == null) return '<span class="no-data">—</span>';
  const head = `$${perkg.toFixed(2)}<span class="perkg-suffix">/kg</span>`;
  const linked = url ? `<a href="${url}" target="_blank" class="price-link">${head}</a>` : head;
  return `<div class="price-main">${linked}</div>`;
}

// Trend cell for a group: the historic price bar of the group's cheapest current
// variant, with a Manage button. The variant is a real item still in data.items,
// so buildPriceBar's Manage button opens its real price-history modal unchanged.
function groupTrendCellHTML(group) {
  const cands = [group._wwBest, group._coBest].filter(Boolean);
  if (!cands.length) return '';
  const best = cands.reduce((a, b) => (a.perkg <= b.perkg ? a : b));
  const member = group._members.find(m => m.list_item === best.name);
  if (!member || !best.result?.price) return '';
  // Convert the recorded pack prices to $/kg using the current pack→$/kg ratio,
  // so the bar and its current marker are both in $/kg (assumes pack size is
  // stable). Pre-drop any prices the user excluded so Manage still curates them.
  const ratio = best.perkg / best.result.price;
  const exArr = loadExclusions()[member.list_item] || [];
  const exSet = new Set(exArr.map(k => {
    if (typeof k === 'number') return Number(k).toFixed(2);
    const s = String(k); return s.includes(':') ? s.split(':')[1] : Number(s).toFixed(2);
  }));
  const hist = (member.price_history || [])
    .filter(e => e.price > 0 && !exSet.has(Number(e.price).toFixed(2)))
    .map(e => ({ date: e.date, price: +(e.price * ratio).toFixed(2) }));
  return buildPriceBar(member.list_item, hist, best.perkg);
}

// Assemble a <tr> from a column→<td> map, respecting current visible columns.
function assembleGroupTr(tds, { rowClass, dataAttrs = '', checkCell = '<td class="check-cell"></td>', actionsCell = '<td class="actions-cell"></td>' } = {}) {
  return `<tr${rowClass ? ` class="${rowClass}"` : ''}${dataAttrs}>`
    + checkCell
    + getVisibleCols().map(c => tds[c] || '<td></td>').join('')
    + actionsCell + '</tr>';
}

// Build the per-store variant list for the expanded panel: every member that has
// a price at `store`, sorted by $/kg ascending, cheapest flagged as the winner.
function groupStoreVariantsHTML(group, store, overrides) {
  const storeKey = store === 'woolworths' ? 'ww' : 'coles';

  // Pending members: in the category but never scraped / scrape failed.
  const pendingRows = group._members
    .filter(m => m._pending)
    .map(m => {
      const ov = overrides[m.list_item] || {};
      const hasUrl = storeKey === 'ww' ? ov.wwUrl : ov.colesUrl;
      if (!hasUrl) return '';
      const name = ov.displayName || stripWW(m.list_item);
      const safeItem = m.list_item.replace(/"/g, '&quot;');
      return `<div class="vg-pv vg-pv-pending">
          <span class="vg-pv-img vg-pv-noimg"></span>
          <a class="vg-pv-name" href="${hasUrl}" target="_blank" rel="noopener">${name}</a>
          <span class="vg-pv-pack vg-pv-pending-tag">Pending price fetch</span>
          <button class="vg-pv-fetch btn btn-ghost" data-item="${safeItem}" data-store="${storeKey}" title="Fetch price now">↻</button>
        </div>`;
    }).filter(Boolean).join('');

  const variants = group._members
    .filter(m => !m._pending)
    .map(m => {
      const res = store === 'woolworths' ? m.woolworths : m.coles;
      return { name: m.list_item, res, pk: clientPerKg(res) };
    })
    .filter(v => v.pk != null)
    .sort((a, b) => a.pk - b.pk);

  if (!variants.length && !pendingRows) return '<div class="vg-pv empty">No matches at this store</div>';

  const variantRows = variants.map((v, i) => {
    const ov = overrides[v.name] || {};
    const name = ov.displayName || stripWW(v.name);
    const size = perKgPackLabel(v.res);
    const pack = v.res.price != null ? `${fmt(v.res.price)}${size ? ` / ${size}` : ''}` : '';
    const safeKey = v.name.replace(/"/g, '&quot;');
    const url = (store === 'woolworths' ? ov.wwUrl : ov.colesUrl) || v.res.url || null;
    const wwImg = resolveImgUrl(group._members.find(m => m.list_item === v.name)?.woolworths?.image_url) || '';
    const coImg = resolveImgUrl(group._members.find(m => m.list_item === v.name)?.coles?.image_url) || '';
    const ownImg = resolveImgUrl(v.res.image_url) || coImg || wwImg;
    const imgHtml = ownImg
      ? `<img class="vg-pv-img img-hoverable" src="${ownImg}" alt="" loading="lazy" data-item="${safeKey}" data-ww-img="${wwImg}" data-co-img="${coImg}" />`
      : '<span class="vg-pv-img vg-pv-noimg"></span>';
    const nameHtml = url
      ? `<a class="vg-pv-name" href="${url}" target="_blank" rel="noopener">${name}</a>`
      : `<span class="vg-pv-name">${name}</span>`;
    return `<div class="vg-pv${i === 0 ? ' win' : ''}">
        ${imgHtml}
        ${nameHtml}
        <span class="vg-pv-pack">${pack}</span>
        <span class="vg-pv-kg">$${v.pk.toFixed(2)}/kg</span>
      </div>`;
  }).join('');

  return variantRows + pendingRows;
}

// Render one variant group: a collapsed table row, plus (if open) a full-width
// panel row that lays out each store's variants ranked by $/kg.
function appendGroupRowDesktop(tbody, group, overrides) {
  const isExpanded = _expandedGroups.has(group._groupKey);
  const wwBest = group._wwBest, coBest = group._coBest;
  const cheaper = group.cheaper_store;

  // Group image is editable like any product: hover to preview, click to pick the
  // WW or Coles photo. Keyed under the group key via the shared image picker.
  const wwImg = resolveImgUrl(wwBest?.result?.image_url) || '';
  const coImg = resolveImgUrl(coBest?.result?.image_url) || '';
  const imgPref = loadImgOverrides()[group.list_item];
  const imgSrc = (imgPref === 'ww' ? wwImg : imgPref === 'coles' ? coImg : null)
    || (cheaper === 'coles' ? (coImg || wwImg) : (wwImg || coImg));
  const imgHtml = imgSrc
    ? `<img class="item-img img-hoverable" src="${imgSrc}" alt="" loading="lazy" data-item="${group.list_item}" data-ww-img="${wwImg}" data-co-img="${coImg}" />`
    : '<div class="item-img-placeholder">No Photo</div>';

  const chev = isExpanded ? '▾' : '▸';
  const nameCell = `<td class="item-name vg-group-name-cell">
    <div class="item-row">
      ${imgHtml}
      <div class="item-info">
        <span class="vg-group-title">
          <span class="vg-chevron">${chev}</span>
          <span class="vg-group-label">${group._groupLabel}</span>
          <button class="item-edit-btn" data-edit-item="${group.list_item}" title="Edit category">✎</button>
        </span>
        <span class="vg-group-sub">${group._members.length} ${group._members.length === 1 ? 'product' : 'products'}</span>
      </div>
    </div></td>`;

  const wwUrl = wwBest ? (overrides[wwBest.name]?.wwUrl || wwBest.result?.url || null) : null;
  const coUrl = coBest ? (overrides[coBest.name]?.colesUrl || coBest.result?.url || null) : null;

  const wwClass = cheaper === 'woolworths' ? 'cell-ww' : '';
  const coClass = cheaper === 'coles' ? 'cell-coles' : '';

  // % cheaper by $/kg
  let pctHtml = '';
  if (group._wwPerKg != null && group._coPerKg != null && group._wwPerKg !== group._coPerKg) {
    const pct = Math.round(Math.abs(group._wwPerKg - group._coPerKg) / Math.max(group._wwPerKg, group._coPerKg) * 100);
    pctHtml = `<span class="${cheaper === 'woolworths' ? 'pct-ww' : 'pct-coles'}">${pct}%</span>`;
  }

  let badgeHtml = '';
  if (!wwBest || !coBest) badgeHtml = '<span class="cheaper-badge na">N/A</span>';
  else if (cheaper === 'woolworths') badgeHtml = '<span class="store-chip ww sm">W</span>';
  else if (cheaper === 'coles') badgeHtml = '<span class="store-chip coles sm">C</span>';
  else badgeHtml = '<span class="cheaper-badge equal">=</span>';

  const units = getUnits(group.list_item);
  const unitsCell = `<td class="units-cell">
    <div class="units-ctrl">
      <button class="units-dec" data-item="${group.list_item}">−</button>
      <span class="units-val">${units.toFixed(1)} kg</span>
      <button class="units-inc" data-item="${group.list_item}">+</button>
    </div></td>`;

  // Per-group priority (stored under the synthetic group key, shared by all members).
  const gp = getPriority(group.list_item);
  const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${group.list_item}">
      <option value="weekly"${gp === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${gp === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${gp === 'rare' ? ' selected' : ''}>Rare</option>
    </select></td>`;

  const wwTotal = group._wwPerKg != null ? group._wwPerKg * units : null;
  const coTotal = group._coPerKg != null ? group._coPerKg * units : null;
  let savingContent = '<span class="no-data">—</span>';
  if (group._wwPerKg != null && group._coPerKg != null) {
    const sav = Math.abs(group._wwPerKg - group._coPerKg) * units;
    savingContent = sav > 0 ? `<span class="saving-cell">${fmt(sav)}</span>` : '<span class="no-data">$0.00</span>';
  }

  const tds = {
    name:         nameCell,
    trend:        `<td class="trend-cell">${groupTrendCellHTML(group)}</td>`,
    priority:     priorityCell,
    units:        unitsCell,
    ww:           `<td class="price-cell ${wwClass}">${perKgCellHTML(group._wwPerKg, wwUrl)}</td>`,
    coles:        `<td class="price-cell ${coClass}">${perKgCellHTML(group._coPerKg, coUrl)}</td>`,
    cheaper:      `<td class="cheaper-cell">${badgeHtml}</td>`,
    pct:          `<td class="pct-cell">${pctHtml}</td>`,
    saving:       `<td><div class="saving-row">${savingContent}</div></td>`,
    trips:        `<td class="trips-cell"></td>`,
    category:     `<td style="font-size:12px;color:var(--text-mid)">${getCategory(group)}</td>`,
    last_scraped: `<td></td>`,
    ww_total:     `<td style="font-size:13px;font-weight:600">${wwTotal != null ? fmt(wwTotal) : '<span class="no-data">—</span>'}</td>`,
    coles_total:  `<td style="font-size:13px;font-weight:600">${coTotal != null ? fmt(coTotal) : '<span class="no-data">—</span>'}</td>`,
  };

  // Selection checkbox (selects the whole category — basket uses its cheapest option).
  const checked = _checkedItems.has(group.list_item) ? ' checked' : '';
  const checkCell = `<td class="check-cell"><input type="checkbox" class="row-check" data-item="${group.list_item}"${checked}></td>`;

  // Actions: watchlist + refresh — identical classes/markup to normal product rows
  // (edit ✎ lives in the name cell, same as normal items).
  const isWatched = _watchlist.has(group.list_item);
  const actionsCell = `<td class="actions-cell">
    <button class="item-watch-btn${isWatched ? ' active' : ''}" data-item="${group.list_item}" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}">👁</button>
    <button class="item-refresh-btn" data-item="${group.list_item}" title="Refresh prices for this category">↻</button>
  </td>`;

  tbody.insertAdjacentHTML('beforeend', assembleGroupTr(tds, {
    rowClass: `vg-group-row${isExpanded ? ' vg-group-open' : ''}`,
    dataAttrs: ` data-group="${group._groupKey}"`,
    checkCell,
    actionsCell,
  }));

  if (!isExpanded) return;

  // Expanded: one full-width panel row laying out WW and Coles variants side by side.
  const winnerTag = (!wwBest || !coBest) ? ''
    : cheaper === 'woolworths' ? '<span class="vg-panel-winner ww">Cheapest: Woolworths</span>'
    : cheaper === 'coles' ? '<span class="vg-panel-winner coles">Cheapest: Coles</span>'
    : '<span class="vg-panel-winner">Same price</span>';

  const colSpan = getVisibleCols().length + 2;
  const panel = `<tr class="vg-panel-row" data-group="${group._groupKey}"><td colspan="${colSpan}">
    <div class="vg-panel">
      <div class="vg-panel-head">
        <span class="vg-panel-title">${group._groupLabel}</span>
        ${winnerTag}
      </div>
      <div class="vg-panel-cols">
        <div class="vg-panel-store">
          <div class="vg-store-h"><span class="store-chip ww sm">W</span> Woolworths</div>
          ${groupStoreVariantsHTML(group, 'woolworths', overrides)}
        </div>
        <div class="vg-panel-store">
          <div class="vg-store-h"><span class="store-chip coles sm">C</span> Coles</div>
          ${groupStoreVariantsHTML(group, 'coles', overrides)}
        </div>
      </div>
      <div class="vg-panel-note">Highlighted = lowest $/kg at each store. The cheapest sticker price isn't always cheapest per kilo.</div>
    </div>
  </td></tr>`;
  tbody.insertAdjacentHTML('beforeend', panel);
}

// Render one variant group as a mobile card: collapsed comparison + expanded
// per-store variant lists (cheapest highlighted).
function appendGroupCardMobile(container, group, overrides) {
  const isExpanded = _expandedGroups.has(group._groupKey);
  const cheaper = group.cheaper_store;

  const card = document.createElement('div');
  card.className = 'mc-card vg-mobile-card vg-expand-btn' + (isExpanded ? ' vg-mobile-open' : '');
  card.dataset.group = group._groupKey;

  const wwWin = cheaper === 'woolworths', coWin = cheaper === 'coles';
  let html = `
    <div class="vgm-head">
      <span class="vg-chevron">${isExpanded ? '▾' : '▸'}</span>
      <span class="vgm-head-label">${group._groupLabel}</span>
      <span class="vgm-head-count">${group._members.length} options</span>
    </div>
    <div class="vgm-cmp">
      <div class="vgm-cmp-store ${wwWin ? 'win' : ''}">
        <span class="store-chip ww sm">W</span>
        <span class="vgm-cmp-kg">${group._wwPerKg != null ? `$${group._wwPerKg.toFixed(2)}/kg` : '—'}</span>
        ${wwWin ? '<span class="vgm-cmp-tag">cheaper</span>' : ''}
      </div>
      <div class="vgm-cmp-store ${coWin ? 'win' : ''}">
        <span class="store-chip coles sm">C</span>
        <span class="vgm-cmp-kg">${group._coPerKg != null ? `$${group._coPerKg.toFixed(2)}/kg` : '—'}</span>
        ${coWin ? '<span class="vgm-cmp-tag">cheaper</span>' : ''}
      </div>
    </div>`;

  if (isExpanded) {
    html += `<div class="vgm-body">
      <div class="vgm-store-sec">
        <div class="vg-store-h"><span class="store-chip ww sm">W</span> Woolworths</div>
        ${groupStoreVariantsHTML(group, 'woolworths', overrides)}
      </div>
      <div class="vgm-store-sec">
        <div class="vg-store-h"><span class="store-chip coles sm">C</span> Coles</div>
        ${groupStoreVariantsHTML(group, 'coles', overrides)}
      </div>
    </div>`;
  }

  card.innerHTML = html;
  container.appendChild(card);
}

// ── Per-kg category edit modal ────────────────────────────────────────────────
let _catEditKey = null;

function openCategoryEditModal(groupKey) {
  const cat = loadVariantGroups().find(g => g.key === groupKey);
  if (!cat || !_lastData) return;
  _catEditKey = groupKey;
  const byName = new Map(_lastData.items.map(i => [i.list_item, i]));
  const members = cat.items.map(n => byName.get(n)).filter(Boolean);
  const ov = loadOverrides();
  const excl = loadPerKgExclusions();

  $('catEditName').value = cat.label;

  const colHTML = (store) => {
    const lines = members.map(m => {
      const res = store === 'ww' ? m.woolworths : m.coles;
      if (!res) return '';
      const o = ov[m.list_item] || {};
      const name = (o.displayName || stripWW(m.list_item)).replace(/"/g, '&quot;');
      const included = !excl.has(`${groupKey}::${m.list_item}::${store}`);
      const url = ((store === 'ww' ? o.wwUrl : o.colesUrl) || res.url || '').replace(/"/g, '&quot;');
      const safeKey = m.list_item.replace(/"/g, '&quot;');
      return `<div class="cat-prod" data-item="${safeKey}" data-store="${store}">
          <input type="checkbox" class="cat-incl"${included ? ' checked' : ''} title="Include in this category" />
          <div class="cat-prod-main">
            <input type="text" class="cat-name" value="${name}" placeholder="Name" />
            <input type="text" class="cat-url" value="${url}" placeholder="Pinned ${store === 'ww' ? 'Woolworths' : 'Coles'} URL" />
          </div>
        </div>`;
    }).filter(Boolean).join('');
    const addBtn = `<button class="cat-add-product" data-store="${store}">+ Add ${store === 'ww' ? 'Woolworths' : 'Coles'} product</button>`;
    return (lines || '<div class="cat-prod-empty">No product at this store yet</div>') + addBtn;
  };

  // Add button handler: drop an empty, editable product row right above the button
  // (same look as existing rows, plus a ✕ to discard). It's committed on Save category.
  const addProductHandler = (e) => {
    const btn = e.target.closest('.cat-add-product');
    if (!btn) return;
    const store = btn.dataset.store;
    const col = btn.closest('.cat-col');
    const row = document.createElement('div');
    row.className = 'cat-prod cat-prod-new';
    row.dataset.store = store;
    row.innerHTML = `
      <input type="checkbox" class="cat-incl" checked title="Include in this category" />
      <div class="cat-prod-main">
        <input type="text" class="cat-name" placeholder="New product name" />
        <input type="text" class="cat-url" placeholder="${store === 'ww' ? 'Woolworths' : 'Coles'} product URL" />
      </div>
      <button class="cat-prod-remove" title="Discard">✕</button>`;
    col.insertBefore(row, btn);
    row.querySelector('.cat-prod-remove').addEventListener('click', () => row.remove());
    row.querySelector('.cat-name').focus();
  };

  $('catEditBody').innerHTML = `
    <div class="cat-cols">
      <div class="cat-col">
        <div class="cat-col-h"><span class="store-chip ww sm">W</span> Woolworths</div>
        ${colHTML('ww')}
      </div>
      <div class="cat-col">
        <div class="cat-col-h"><span class="store-chip coles sm">C</span> Coles</div>
        ${colHTML('coles')}
      </div>
    </div>`;

  // Wire up Add product buttons
  const editBody = $('catEditBody');
  [...editBody.querySelectorAll('.cat-add-product')].forEach(btn => {
    btn.addEventListener('click', addProductHandler);
  });

  document.body.style.overflow = 'hidden';
  $('categoryEditModal').classList.add('open');
}

function saveCategoryEdit() {
  if (!_catEditKey) return;
  const key = _catEditKey;
  const label = $('catEditName').value.trim();
  if (label) saveVariantGroupOverride(key, { label });

  const ov = loadOverrides();
  const excl = loadPerKgExclusions();

  // New (URL-added) products aren't in _lastData yet — collect them so we can add
  // their name to the category, pin the URL, and fetch them into latest.json.
  const cat = loadVariantGroups().find(g => g.key === key);
  const items = cat ? [...cat.items] : [];
  const newFetches = [];

  document.querySelectorAll('#catEditBody .cat-prod').forEach(row => {
    const store = row.dataset.store;
    const included = row.querySelector('.cat-incl').checked;
    const nm = row.querySelector('.cat-name').value.trim();
    const url = row.querySelector('.cat-url').value.trim();

    if (!row.dataset.item) {
      // Brand-new product: needs a name and a URL to be fetchable.
      if (!nm || !url) return;
      if (!items.includes(nm)) items.push(nm);
      ov[nm] = ov[nm] || {};
      if (store === 'ww') ov[nm].wwUrl = url; else ov[nm].colesUrl = url;
      if (!included) excl.add(`${key}::${nm}::${store}`);
      newFetches.push({ name: nm, wwUrl: store === 'ww' ? url : undefined, colesUrl: store === 'coles' ? url : undefined });
      return;
    }

    const item = row.dataset.item;
    const ek = `${key}::${item}::${store}`;
    if (included) excl.delete(ek); else excl.add(ek);
    ov[item] = ov[item] || {};
    if (nm) ov[item].displayName = nm; else delete ov[item].displayName;
    if (store === 'ww') { url ? ov[item].wwUrl = url : delete ov[item].wwUrl; }
    else { url ? ov[item].colesUrl = url : delete ov[item].colesUrl; }
  });

  if (cat && items.length !== cat.items.length) saveVariantGroupOverride(key, { items });
  savePerKgExclusions(excl);
  saveOverrides(ov);
  closeCategoryEditModal();
  if (_lastData) renderPage(_lastData);

  // Persist new products' URLs to url_overrides.json so the scraper includes
  // them on every full run (otherwise they vanish the next time a full scrape
  // overwrites latest.json — the Excel shopping list doesn't know about them).
  if (newFetches.length) {
    const s = loadSettings();
    if (!s.token) {
      alert(`Saved. ${newFetches.length} new product(s) added — add your GitHub token (Auto-update Setup) then hit ↻ on the category to fetch their prices.`);
    } else {
      persistUrlOverridesToRepo(s, ov).catch(() => {});
      newFetches.forEach(f => triggerItemRefresh(f.name, null, { wwUrl: f.wwUrl, colesUrl: f.colesUrl }));
      alert(`Saved. Fetching ${newFetches.length} new product(s) — they'll appear once the next price check finishes.`);
    }
  }
}

function closeCategoryEditModal() {
  _catEditKey = null;
  document.body.style.overflow = '';
  $('categoryEditModal')?.classList.remove('open');
}

function initCategoryEditModal() {
  $('catEditClose')?.addEventListener('click', closeCategoryEditModal);
  $('catEditCancel')?.addEventListener('click', closeCategoryEditModal);
  $('catEditSave')?.addEventListener('click', saveCategoryEdit);
  $('categoryEditModal')?.addEventListener('click', (e) => { if (e.target.id === 'categoryEditModal') closeCategoryEditModal(); });
}

// Refresh every product in a category (each is a real item; dispatch one scrape each).
function refreshCategory(groupKey, btn) {
  const cat = loadVariantGroups().find(g => g.key === groupKey);
  if (!cat) return;
  const ov = loadOverrides();
  cat.items.forEach((name, i) => {
    const o = ov[name] || {};
    triggerItemRefresh(name, i === 0 ? btn : null, { wwUrl: o.wwUrl, colesUrl: o.colesUrl });
  });
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
  const sortDir = _mobileSortDir === 'asc' ? 1 : -1;
  if (_mobileSortMode === 'trend') {
    // calcTrendPosition() from utils.js: 0.0=best deal, 0.5=flat/middle, 999=no history
    displayItems.sort((a, b) => (calcTrendPosition(a) - calcTrendPosition(b)) * sortDir);
  } else if (_mobileSortMode === 'az') {
    displayItems.sort((a, b) => shortName(a.list_item).localeCompare(shortName(b.list_item)) * sortDir);
  } else if (_mobileSortMode === 'savings') {
    const sv = it => (savingAmount(it) || 0) * getUnits(it.list_item);
    displayItems.sort((a, b) => (sv(b) - sv(a)) * sortDir);
  }

  // Toolbar: sort chips (left) + view toggle (right)
  const toolbar = document.createElement('div');
  toolbar.className = 'mc-toolbar';

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'mc-sort-chips';

  const CHIPS = [
    { mode: 'az',      label: 'A–Z'      },
    { mode: 'savings', label: 'Savings'  },
    { mode: 'trend',   label: 'Trend'},
  ];
  CHIPS.forEach(({ mode, label }) => {
    const chip = document.createElement('button');
    chip.className = 'mc-sort-chip';
    const isActive = _mobileSortMode === mode;
    if (isActive) chip.classList.add('active');
    const arrow = isActive ? (_mobileSortDir === 'asc' ? ' ↑' : ' ↓') : '';
    chip.textContent = label + arrow;
    chip.addEventListener('click', () => {
      if (_mobileSortMode === mode) {
        _mobileSortDir = _mobileSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _mobileSortMode = mode;
        _mobileSortDir  = 'asc';
      }
      if (_lastData) renderPage(_lastData);
    });
    chipsWrap.appendChild(chip);
  });
  toolbar.appendChild(chipsWrap);

  // View toggle — single icon-only button; glyph shows the layout you'll switch TO
  const ICON_LIST = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
  const ICON_CARDS = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/></svg>';
  const viewBtn = document.createElement('button');
  viewBtn.id = 'mcViewToggle';
  viewBtn.setAttribute('aria-label', _mcView === 'detailed' ? 'Switch to compact view' : 'Switch to detailed view');
  viewBtn.title = _mcView === 'detailed' ? 'Compact view' : 'Detailed view';
  viewBtn.innerHTML = _mcView === 'detailed' ? ICON_LIST : ICON_CARDS;
  viewBtn.addEventListener('click', () => {
    _mcView = _mcView === 'detailed' ? 'compact' : 'detailed';
    localStorage.setItem('pw_mc_view_v1', _mcView);
    // Preserve scroll position so toggling views doesn't jump to the top
    const y = window.scrollY;
    if (_lastData) renderPage(_lastData);
    window.scrollTo(0, y);
  });
  toolbar.appendChild(viewBtn);

  container.appendChild(toolbar);

  if (!displayItems.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:40px 20px;text-align:center;color:var(--text-soft);font-size:14px;';
    empty.textContent = 'No items match the current filters.';
    container.appendChild(empty);
    return;
  }

  displayItems.forEach(item => {
    if (item._isGroup) { appendGroupCardMobile(container, item, overrides); return; }
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
    const _trendSeriesMC = getTrendSeries(item);
    const barHtml = _trendSeriesMC.prices.length
      ? buildPriceBar(item.list_item, _trendSeriesMC.prices.map(p => ({price: p})), _trendSeriesMC.current)
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
    const saving    = savingAmount(item);
    const borderCls = wwCheaper ? ' cheaper-ww' : coCheaper ? ' cheaper-coles' : '';

    const isSelected = _selectedItems.has(item.list_item);
    const card = document.createElement('div');
    const compact = _mcView === 'compact';
    card.className = `mobile-card${borderCls}${isSelected ? ' mc-selected' : ''}${compact ? ' mobile-card-compact' : ''}`;
    card.dataset.item = item.list_item;

    const watchBtn = isWatchedMC
      ? `<button class="mc-watch-btn active" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Remove from watchlist">👁</button>`
      : `<button class="mc-watch-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Add to watchlist">👁</button>`;

    const savingTag = saving && saving > 0 ? `<span class="mc-saving">Save ${fmt(saving)}</span>` : '';

    if (compact) {
      // Single-line row: fire, SHORT name, W chip + price, C chip + price (cheaper bold).
      // No eye — there's no horizontal room in this layout.
      const unarch = _activePriority === 'archive'
        ? `<button class="mc-unarchive-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Unarchive">↩</button>` : '';
      card.innerHTML = `
        ${hotDeal ? '<span class="mc-hot">🔥</span>' : ''}
        <span class="mcc-name">${ov.displayName || shortName(item.list_item)}</span>
        <span class="mcc-price"><span class="store-chip sm ww">W</span><span class="${wwCheaper ? 'mcc-bold' : ''}">${ww ? fmt(ww.price) : '—'}</span></span>
        <span class="mcc-price"><span class="store-chip sm coles">C</span><span class="${coCheaper ? 'mcc-bold' : ''}">${co ? fmt(co.price) : '—'}</span></span>
        ${unarch ? `<span class="mc-icons">${unarch}</span>` : ''}`;
    } else {
      card.innerHTML = `
      <div class="mc-top">
        ${imgHtml}
        <div class="mc-name-wrap">
          <div class="mc-name-row">
            <div class="mc-name">${displayName}</div>
            <span class="mc-icons">
              ${hotDeal ? '<span class="mc-hot">🔥</span>' : ''}
              ${watchBtn}
              ${_activePriority === 'archive' ? `<button class="mc-unarchive-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Unarchive">↩</button>` : ''}
            </span>
          </div>
          <div class="mc-badges">
            <div class="mc-badges-left">${catHtml}${prioHtml}</div>
            ${savingTag}
          </div>
        </div>
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
        <span class="mc-cheaper-tag ${wwCheaper ? 'ww' : coCheaper ? 'coles' : 'equal'}" title="${wwCheaper ? 'Woolworths is cheaper' : coCheaper ? 'Coles is cheaper' : 'Same price at both stores'}">
          ${wwCheaper ? '<span class="store-chip sm ww">W</span>' : coCheaper ? '<span class="store-chip sm coles">C</span>' : ''}
          ${(wwCheaper || coCheaper)
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<span class="mc-eq">=</span>'}
        </span>
      </div>` : ''}`;
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('.mc-watch-btn')) {
        toggleWatchlist(e.target.closest('.mc-watch-btn').dataset.item);
        return;
      }
      if (e.target.closest('.mc-unarchive-btn')) {
        unarchiveItem(e.target.closest('.mc-unarchive-btn').dataset.item);
        return;
      }
      // Mobile-only (≤700px): tap card to toggle selection
      if (window.innerWidth <= 700) {
        const name = item.list_item;
        if (_selectedItems.has(name)) _selectedItems.delete(name);
        else _selectedItems.add(name);
        card.classList.toggle('mc-selected', _selectedItems.has(name));
        _updateSelectedPill();
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

  // Keep the mobile header filter icons (🔥 / 👁) in sync with current state
  $('mobileHotBtn')?.classList.toggle('active', _showHotOnly);
  $('mobileWatchBtn')?.classList.toggle('active', _activePriority === 'watchlist');

  // Always compute banner stats client-side so savings are units-weighted
  const s = computeBannerStats(data.items);
  const wwCard    = $('wwCard');
  const colesCard = $('colesCard');
  const wwTotalEl = $('wwTotal');

  wwCard.className    = 'store-card';
  colesCard.className = 'store-card';

  if (!s.ww_data_available && s.items_compared > 0) {
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
    $('savingInfo').innerHTML = renderSavingInfo(s);
  } else if (s.cheaper_store === 'coles') {
    colesCard.classList.add('winner-coles');
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('colesBadge').innerHTML = '<span class="winner-badge coles">✓ Cheaper</span>';
    $('wwBadge').innerHTML    = '';
    $('savingInfo').innerHTML = renderSavingInfo(s);
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
  // Deal count uses the SAME canonical function the Hot Deals page uses, with the
  // same inputs, so this number always equals the rows shown there (no drift).
  const hotCount = getHotDealItems(data.items, {
    exclusions: _renderExclusions,
    archivedSet: _repoArchivedSet,
    priorities: _uiPriorities,
  }).length;
  $('lastUpdated').innerHTML = `<span>Updated ${formatDate(data.last_updated)}</span><span>${coverageText}</span>${hotCount > 0 ? `<a href="hot-deals.html" class="hot-deals-link">🔥 ${hotCount} deal${hotCount !== 1 ? 's' : ''}</a>` : ''}`;
  // Red dot on the Hot Deals bottom tab when there are active deals
  const btbHotTab = document.querySelector('#bottomTabBar a[href="hot-deals.html"]');
  if (btbHotTab) {
    let dot = btbHotTab.querySelector('.btb-hot-dot');
    if (hotCount > 0) {
      if (!dot) { dot = document.createElement('span'); dot.className = 'btb-hot-dot'; btbHotTab.appendChild(dot); }
    } else {
      dot?.remove();
    }
  }
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

  // Archived items are excluded from latest.json by the scraper, so the archive
  // view would otherwise be empty (no item objects to render). Inject lightweight
  // stub rows for any archived name not already present, so the user can always
  // see, manage, and unarchive them. Stubs carry no price data until re-scraped.
  {
    const present = new Set(allDisplayItems.map(i => i.list_item));
    Object.keys(priorities).forEach(name => {
      if (priorities[name] === 'archive' && !present.has(name)) {
        allDisplayItems.push({
          list_item: name, archived: true, woolworths: null, coles: null,
          cheaper_store: null, saving_per_item: null, trip_count: 0,
          price_history: [], category: '',
        });
      }
    });
  }

  // Collapse per-kg member products into synthetic variant-group rows so they
  // render inline as normal-looking rows (treated as Weekly). Skip in archive
  // view so the raw items remain individually reachable/unarchivable there.
  if (_activePriority !== 'archive') {
    const memberNames = new Set(loadVariantGroups().flatMap(g => g.items));
    const byName = new Map(allDisplayItems.map(i => [i.list_item, i]));
    const groups = buildVariantGroups(byName);
    if (groups.length) {
      allDisplayItems = allDisplayItems.filter(i => !memberNames.has(i.list_item));
      allDisplayItems.push(...groups);
    }
  }

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
    // Clear tfoot so stale totals don't show when no rows are visible
    const tfootRowEmpty = document.querySelector('tfoot tr');
    if (tfootRowEmpty) {
      tfootRowEmpty.innerHTML = '<td></td>' + getVisibleCols().map(col =>
        col === 'name' ? `<td><div style="font-weight:700">0 products</div></td>` : '<td></td>'
      ).join('') + '<td></td>';
    }
    $('tableContainer').style.display = 'block';
    return;
  }

  const overrides = loadOverrides();

  sorted.forEach((item) => {
    if (item._isGroup) { appendGroupRowDesktop(tbody, item, overrides); return; }
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;
    const ov = overrides[item.list_item] || {};

    const wwUrl  = ov.wwUrl    || ww?.url  || null;
    const coUrl  = ov.colesUrl || co?.url  || null;
    const displayName = ov.displayName || stripWW(item.list_item);

    const coImgSrc = resolveImgUrl(co?.image_url) || '';
    const wwImgSrc = resolveImgUrl(ww?.image_url) || '';
    const _imgPref  = loadImgOverrides()[item.list_item];
    const imgSrc = (_imgPref === 'ww' ? wwImgSrc : _imgPref === 'coles' ? coImgSrc : null)
                   || coImgSrc || wwImgSrc;
    const imgFallback = coImgSrc && wwImgSrc ? wwImgSrc : '';
    const safeKey = item.list_item.replace(/"/g, '&quot;');
    const imgHtml = imgSrc
      ? `<img class="item-img img-hoverable" src="${imgSrc}" alt="" loading="lazy"
           data-item="${safeKey}" data-ww-img="${wwImgSrc}" data-co-img="${coImgSrc}"
           onerror="imgError(this,'${imgFallback}')" />`
      : '<div class="item-img-placeholder">No Photo</div>';

    const editBtn = `<button class="item-edit-btn" data-edit-item="${safeKey}" title="Edit name/URL">✎</button>`;

    // Price bar uses cheaper store's price as reference (or fallback)
    const currentRef = cheaper === 'woolworths' ? ww?.price : (cheaper === 'coles' ? co?.price : (co?.price ?? ww?.price));
    const _trendSeriesPage = getTrendSeries(item);
    const bar = _trendSeriesPage.prices.length ? buildPriceBar(item.list_item, _trendSeriesPage.prices.map(p => ({price: p})), _trendSeriesPage.current) : '';

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
    if (matchConf === 'none' && !_dismissed.includes(item.list_item) && !_approvedWarns.has(item.list_item)) {
      matchWarnHtml = `<span class="match-warn match-warn-none" title="Could not confidently match this item across stores — prices may be for different products" data-item="${item.list_item.replace(/"/g,'&quot;')}">⚠ possible mismatch<button class="warn-dismiss" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Dismiss">✕</button></span>`;
    } else if ((matchConf === 'low' || sizeWarn) && !_dismissed.includes(item.list_item) && !_approvedWarns.has(item.list_item)) {
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
    const hotDeal = isHotDeal(item);
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
      const unitsSaving = (savingAmount(item) ?? 0) * units;
      savingContent = unitsSaving > 0
        ? `<span class="saving-cell">${fmt(unitsSaving)}</span>`
        : `<span class="no-data">$0.00</span>`;
    }

    const tripsHtml = item.trip_count != null ? `<span class="trips-cell">${item.trip_count}</span>` : '';

    const isWatched = _watchlist.has(item.list_item);
    const watchBtn  = `<button class="item-watch-btn${isWatched ? ' active' : ''}" data-item="${safeKey}" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}">👁</button>`;
    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;
    const unarchiveBtn = _activePriority === 'archive'
      ? `<button class="item-unarchive-btn" data-item="${safeKey}" title="Unarchive this item">↩ Unarchive</button>`
      : '';

    const wwClass  = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass  = cheaper === 'coles'      ? 'cell-coles' : '';

    // Priority cell (uses analysis data as fallback)
    const itemPriority = getPriority(item.list_item);
    const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${safeKey}">
      <option value="weekly"${itemPriority === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${itemPriority === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${itemPriority === 'rare' ? ' selected' : ''}>Rare</option>
    </select></td>`;

    const isItemPerkg = _perkgSet.has(item.list_item);
    const unitsDisplay = isItemPerkg
      ? `${units.toFixed(1)} kg`
      : (Number.isInteger(units) ? units : units.toFixed(1));
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
    tbody.insertAdjacentHTML('beforeend', `<tr${rowClass} data-item="${safeKey}"><td class="check-cell"><input type="checkbox" class="row-check" data-item="${safeKey}"${checked}></td>${getVisibleCols().map(col => tdMap[col] || '').join('')}<td class="actions-cell">${unarchiveBtn}${watchBtn}${refreshBtn}</td></tr>`);

    _prevPrices[item.list_item] = { ww: ww?.price, co: co?.price };
    if (priceChanged && _pendingRefreshItem === item.list_item) _pendingRefreshItem = null;
  });

  // Tfoot — use the same banner stats so the desktop footer and mobile banner
  // always show identical basket totals (qty-weighted, items with both prices).
  const footWWBase   = s.total_woolworths;
  const footCoBase   = s.total_coles;
  const _fWWAvail    = s.ww_data_available;
  const _fCoAvail    = s.items_compared > 0;
  const footerSaving = s.total_saving;
  // ww_total / coles_total columns include all visible items, qty-weighted
  let _fWWQty = 0, _fCoQty = 0;
  for (const item of sorted) {
    // Per-kg groups contribute $/kg × weight; normal items contribute pack price × qty.
    const wwUnit = item._isGroup ? (item._wwPerKg ?? 0) : (item.woolworths?.price ?? 0);
    const coUnit = item._isGroup ? (item._coPerKg ?? 0) : (item.coles?.price ?? 0);
    _fWWQty += wwUnit * getUnits(item.list_item);
    _fCoQty += coUnit * getUnits(item.list_item);
  }
  const footWWQty  = Math.round(_fWWQty * 100) / 100;
  const footCoQty  = Math.round(_fCoQty * 100) / 100;

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
  if (!s.token) throw new Error('GitHub settings not configured');

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
  if (!s.token) {
    alert('Please add your GitHub token first (⚙ Auto-update Setup button).');
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
      alert('Items added to your basket, but the scraper is offline — prices will update when the runner restarts.');
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

    alert(`✓ Added ${newItems.length} item(s) to your basket and triggered a price scrape!`);
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

function getCurrentVisibleItems() {
  if (!_lastData) return [];
  return sortItems(_lastData.items).map(i => i.list_item);
}

function buildShoppingListItems(useChecked) {
  if (!_lastData) return [];
  const allItems = _lastData.items;
  // Priority 1: mobile tap-selected items
  if (_selectedItems.size > 0)
    return allItems.filter(i => _selectedItems.has(i.list_item));
  // Priority 2: desktop checkbox-selected rows (bulk bar)
  if (useChecked && _checkedItems && _checkedItems.size > 0)
    return allItems.filter(i => _checkedItems.has(i.list_item));
  // Priority 3: active search — substring match on list_item name
  if (_searchQuery && _searchQuery.trim().length > 0) {
    const q = _searchQuery.trim().toLowerCase();
    return allItems.filter(i => i.list_item.toLowerCase().includes(q));
  }
  // Priority 4: current filter view (frequency tab + category + hot/priced-only)
  return sortItems(allItems);
}

function exportShoppingList(useChecked) {
  const items = buildShoppingListItems(useChecked);
  const names = items.map(i => i.list_item);
  // Build a human-readable description of what's being exported.
  // The basket page renders "Showing <N> <note>", so notes must NOT include a
  // count of their own (avoids "Showing 4 4 selected items").
  let note;
  if (_selectedItems.size > 0 || (useChecked && _checkedItems && _checkedItems.size > 0)) {
    note = 'selected items';
  } else if (_searchQuery && _searchQuery.trim().length > 0) {
    note = `items matching "${_searchQuery.trim()}"`;
  } else {
    const pLabel = _activePriority === 'all' ? 'all' : `all ${_activePriority}`;
    const catSuffix = _activeCategory !== 'All' ? ` · ${_activeCategory}` : '';
    note = `${pLabel} items${catSuffix}`;
  }
  const quantities = loadUnitOverrides();
  let finalNames = names;
  let finalNote = note;
  // If the basket is locked (Save basket on the basket page), append to the
  // existing basket instead of replacing it. Dedupe while preserving order.
  if (localStorage.getItem('pw_sl_locked') === '1') {
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem('pw_sl_handoff') || '{}').items || []; } catch {}
    const merged = [...existing];
    names.forEach(n => { if (!merged.includes(n)) merged.push(n); });
    finalNames = merged;
    finalNote = 'items (basket locked)';
  }
  const handoffPayload = { items: finalNames, note: finalNote, quantities };
  localStorage.setItem('pw_sl_handoff', JSON.stringify(handoffPayload));
  window.location.href = 'shopping-list.html';
}

// ── Options menu (theme + row density) ─────────────────────────────────────────

let _theme = localStorage.getItem('pw_theme') || 'light'; // 'light' | 'dark' | 'auto'

function applyTheme() {
  const dark = _theme === 'dark' ||
    (_theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelectorAll('#themeSeg .opt-seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.themeOpt === _theme));
}

function applyDensity() {
  const wrap = document.querySelector('.table-wrap');
  if (wrap) wrap.classList.toggle('density-compact', _density === 'compact');
  document.querySelectorAll('#densitySeg .opt-seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.densityOpt === _density));
}

function initOptionsMenu() {
  const btn = $('optionsBtn');
  const dd  = $('optionsDropdown');

  applyTheme();
  applyDensity();

  // Keep 'auto' in sync if the OS theme flips while the page is open.
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (_theme === 'auto') applyTheme();
  });

  $('themeSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('.opt-seg-btn'); if (!b) return;
    _theme = b.dataset.themeOpt;
    try { localStorage.setItem('pw_theme', _theme); } catch {}
    applyTheme();
  });

  $('densitySeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('.opt-seg-btn'); if (!b) return;
    _density = b.dataset.densityOpt;
    try { localStorage.setItem('pw_density', _density); } catch {}
    applyDensity();
  });

  if (btn && dd) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
    });
    dd.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => { dd.style.display = 'none'; });
  }
}

// ── Pull-to-refresh ───────────────────────────────────────────────────────────

function initPullToRefresh() {
  const indicator = document.getElementById('pullRefreshIndicator');
  if (!indicator) return;
  let startY = 0, currentY = 0;
  const THRESHOLD = 70;

  document.addEventListener('touchstart', (e) => {
    startY = currentY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    currentY = e.touches[0].clientY;
    if (window.scrollY > 5) { indicator.classList.remove('pulling'); return; }
    const dy = currentY - startY;
    if (dy <= 10) { indicator.classList.remove('pulling'); return; }
    indicator.classList.add('pulling');
    indicator.innerHTML = dy >= THRESHOLD
      ? '<div class="ptr-spinner"></div>&nbsp;Release to refresh'
      : '<div class="ptr-spinner"></div>&nbsp;Pull down to refresh';
  }, { passive: true });

  document.addEventListener('touchend', () => {
    const dy = currentY - startY;
    const wasTriggered = window.scrollY <= 5 && dy >= THRESHOLD;
    indicator.classList.remove('pulling');
    indicator.innerHTML = '';
    if (wasTriggered) {
      indicator.classList.add('triggered');
      indicator.innerHTML = '<div class="ptr-spinner"></div>&nbsp;Refreshing…';
      triggerRefresh();
      setTimeout(() => { indicator.classList.remove('triggered'); indicator.innerHTML = ''; }, 2000);
    }
    startY = currentY = 0;
  }, { passive: true });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  initSettingsModal();
  initEditModal();
  initPriceHistoryModal();
  initTooltip();
  initStickyHeader();
  initUploadModal();
  initSearch();
  initDiffItemModal();
  initImgPicker();
  initCategoryEditModal();
  initPriorityFilter();
  initPricesOnlyFilter();
  initSelectedPill();
  initBulkBar();
  initColumnChooser();
  initColFilterDropdown();
  updateImportBadge();
  initOptionsMenu();
  initPullToRefresh();

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerRefresh);

  $('shopListBtn')?.addEventListener('click', () => exportShoppingList(false));

  // Floating "+ Basket (n)" — sends the tap-selected items to the basket page
  $('basketFab')?.addEventListener('click', () => {
    if (_selectedItems.size > 0) exportShoppingList(true);
  });

  // Basket nav: with items selected → add them; nothing selected & unlocked →
  // add everything currently showing. Locked + nothing selected → just view.
  const _basketNavHandler = (e) => {
    const locked = localStorage.getItem('pw_sl_locked') === '1';
    if (_selectedItems.size > 0) {
      e.preventDefault();
      exportShoppingList(true);
    } else if (!locked) {
      e.preventDefault();
      exportShoppingList(false);
    }
  };
  $('basketNavLink')?.addEventListener('click', _basketNavHandler);
  document.getElementById('btbBasketLink')?.addEventListener('click', _basketNavHandler);

  // Scrape strip dismiss & retry
  // Scrape Archived button — persists archived list to GitHub then dispatches workflow
  $('scrapeArchivedBtn')?.addEventListener('click', async () => {
    const s = loadSettings();
    if (!s.token) {
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
      const warnEl = e.target.closest('.match-warn, .warn-dismiss');
      if (warnEl) {
        e.stopPropagation();
        const btn = warnEl.classList.contains('warn-dismiss') ? warnEl : warnEl.querySelector('.warn-dismiss');
        const itemName = btn?.dataset.item || warnEl.dataset.item;
        if (itemName) {
          try { const d = JSON.parse(localStorage.getItem('pw_dismissed_warns_v1')||'[]'); if (!d.includes(itemName)) d.push(itemName); localStorage.setItem('pw_dismissed_warns_v1', JSON.stringify(d)); } catch {}
        }
        warnEl.closest('.match-warn') ? warnEl.closest('.match-warn').remove() : warnEl.remove();
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

  // ── Sync URL overrides → GitHub ───────────────────────────────
  $('syncOverridesBtn')?.addEventListener('click', async () => {
    const s = loadSettings();
    if (!s.token) {
      alert('Please add your GitHub token first (⚙ Auto-update Setup button).');
      return;
    }
    const overrides = loadOverrides();
    const hasUrls = Object.values(overrides).some(v => v.wwUrl || v.colesUrl);
    if (!hasUrls) {
      alert('No URL overrides found in local storage — nothing to sync.');
      return;
    }
    const btn = $('syncOverridesBtn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      await persistUrlOverridesToRepo(s, overrides);
      btn.textContent = '✓ Synced';
      setTimeout(() => { btn.textContent = 'Sync URL overrides'; btn.disabled = false; }, 2000);
    } catch (e) {
      alert(`⚠ Sync failed — check your token.\n${e.message}`);
      btn.textContent = 'Sync URL overrides';
      btn.disabled = false;
    }
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
  function _activateTotalCol(show, hide) {
    // Swap positions in _colOrder so `show` takes the slot `hide` currently holds.
    // This guarantees the visible column always appears at the same table position
    // regardless of how the user has reordered or customised the column list.
    const showIdx = _colOrder.indexOf(show);
    const hideIdx = _colOrder.indexOf(hide);
    if (showIdx !== -1 && hideIdx !== -1 && showIdx !== hideIdx) {
      _colOrder[showIdx] = hide;
      _colOrder[hideIdx] = show;
      saveColOrder();
    }
    _colVisibility[show] = true;
    _colVisibility[hide] = false;
    saveColVisibility();
    if (_lastData) renderPage(_lastData);
  }
  $('wwCard')?.addEventListener('click',    () => _activateTotalCol('ww_total',    'coles_total'));
  $('colesCard')?.addEventListener('click', () => _activateTotalCol('coles_total', 'ww_total'));

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
  await Promise.all([loadItemAnalysis(), initWatchlist(), initUserSettings(), mergeArchivedFromRepo(), (async () => {
    try { const r = await fetch(`data/approved_warns.json?t=${Date.now()}`); if (r.ok) _approvedWarns = new Set(await r.json()); } catch {}
  })() ]);
  const data = await loadData();

  {
    renderPage(data);
    showNameChangesNotice();

    // TEMP dev button (web): isolate the per-kg items so their scraping can be tuned.
    const perkgBtn = $('perkgDevBtn');
    if (perkgBtn) {
      perkgBtn.addEventListener('click', () => {
        _showPerKgOnly = !_showPerKgOnly;
        perkgBtn.classList.toggle('on', _showPerKgOnly);
        perkgBtn.textContent = _showPerKgOnly ? '⚙ /kg ✓' : '⚙ /kg';
        if (_lastData) renderPage(_lastData);
      });
    }

    const tbody = $('tableBody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        // Variant group expand/collapse — click anywhere on the group row (or its
        // panel header), except on the interactive controls it hosts.
        const groupRow = e.target.closest('.vg-group-row, .vg-panel-row');
        if (groupRow && !e.target.closest('.priority-select, .units-ctrl, a, button, input, .img-hoverable')) {
          const key = groupRow.dataset.group;
          if (_expandedGroups.has(key)) _expandedGroups.delete(key);
          else _expandedGroups.add(key);
          if (_lastData) renderPage(_lastData);
          return;
        }

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
          const isPerkg = _perkgSet.has(itemName) || itemName.startsWith('__group_');
          const isInc = incBtn.classList.contains('units-inc');
          const ov = loadUnitOverrides();
          const cur = getUnits(itemName);
          if (isPerkg) {
            const next = Math.round((cur + (isInc ? 0.2 : -0.2)) * 10) / 10;
            ov[itemName] = Math.max(0.2, next);
          } else {
            ov[itemName] = Math.max(1, Math.round(cur) + (isInc ? 1 : -1));
          }
          saveUnitOverrides(ov);
          if (_lastData) renderPage(_lastData);
          return;
        }

        const refreshBtn = e.target.closest('.item-refresh-btn');
        if (refreshBtn) {
          const rItem = refreshBtn.dataset.item;
          if (rItem.startsWith('__group_')) { refreshCategory(rItem.replace('__group_', ''), refreshBtn); return; }
          const ov = loadOverrides()[rItem] || {};
          triggerItemRefresh(rItem, refreshBtn, { wwUrl: ov.wwUrl, colesUrl: ov.colesUrl });
          return;
        }

        // Pending-item fetch button inside expanded category panel
        const fetchBtn = e.target.closest('.vg-pv-fetch');
        if (fetchBtn) {
          const itemName = fetchBtn.dataset.item;
          const store = fetchBtn.dataset.store;
          const ov = loadOverrides()[itemName] || {};
          triggerItemRefresh(itemName, fetchBtn, { wwUrl: ov.wwUrl, colesUrl: ov.colesUrl });
          return;
        }
        const discrepEl = e.target.closest('.discrepancy-warn, .dismiss-diff-btn');
        if (discrepEl) {
          e.stopPropagation();
          const btn = discrepEl.classList.contains('dismiss-diff-btn') ? discrepEl : discrepEl.querySelector('.dismiss-diff-btn');
          if (btn) { dismissDiff(btn.dataset.item, parseFloat(btn.dataset.diff)); if (_lastData) renderPage(_lastData); }
          return;
        }

        const warnEl = e.target.closest('.match-warn, .warn-dismiss');
        if (warnEl) {
          e.stopPropagation();
          const btn = warnEl.classList.contains('warn-dismiss') ? warnEl : warnEl.querySelector('.warn-dismiss');
          const itemName = btn?.dataset.item || warnEl.dataset.item;
          if (itemName) {
            try {
              const d = JSON.parse(localStorage.getItem('pw_dismissed_warns_v1') || '[]');
              if (!d.includes(itemName)) d.push(itemName);
              localStorage.setItem('pw_dismissed_warns_v1', JSON.stringify(d));
            } catch {}
          }
          warnEl.closest('.match-warn') ? warnEl.closest('.match-warn').remove() : warnEl.remove();
          return;
        }

        const watchBtn = e.target.closest('.item-watch-btn');
        if (watchBtn) { toggleWatchlist(watchBtn.dataset.item); return; }

        const unarchiveBtn = e.target.closest('.item-unarchive-btn');
        if (unarchiveBtn) { unarchiveItem(unarchiveBtn.dataset.item); return; }

        const editBtn = e.target.closest('.item-edit-btn');
        if (editBtn && _lastData) {
          const itemName = editBtn.dataset.editItem;
          if (itemName.startsWith('__group_')) { openCategoryEditModal(itemName.replace('__group_', '')); return; }
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

  // Mobile variant group expand/collapse (delegated; persists across innerHTML rebuilds)
  const mobileCardsEl = $('mobileCards');
  if (mobileCardsEl) {
    mobileCardsEl.addEventListener('click', (e) => {
      // Don't toggle when interacting with an option's link, edit button, or image.
      if (e.target.closest('a, button, .img-hoverable')) return;
      const vgBtn = e.target.closest('.vg-expand-btn');
      if (vgBtn) {
        const key = vgBtn.dataset.group;
        if (_expandedGroups.has(key)) _expandedGroups.delete(key);
        else _expandedGroups.add(key);
        if (_lastData) renderPage(_lastData);
      }
    });
  }

  // One-time sync on load: push current archived items to archived_items.json
  // Fixes case where localStorage has archived items but the repo file was empty/stale.
  const _initPr = loadPriorities();
  if (Object.values(_initPr).includes('archive')) {
    syncArchivedToGitHub();
  }

  // One-time sync on load: push localStorage URL overrides to url_overrides.json.
  // Runs silently once per browser session so the scraper always has up-to-date pinned URLs
  // even if a previous GitHub API write failed or the user closed the dialog without saving.
  if (!sessionStorage.getItem('pw_overrides_synced')) {
    sessionStorage.setItem('pw_overrides_synced', '1');
    const _bootOvSettings = loadSettings();
    if (_bootOvSettings.user && _bootOvSettings.repo && _bootOvSettings.token) {
      const _bootOv = loadOverrides();
      const _hasUrls = Object.values(_bootOv).some(v => v.wwUrl || v.colesUrl);
      if (_hasUrls) {
        persistUrlOverridesToRepo(_bootOvSettings, _bootOv).catch(() => {
          // Silent — failure will be visible on next manual save attempt
        });
      }
    }
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

// ── Global keyboard shortcuts ─────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Close whichever modal is open — check in reverse stack order (topmost first)
  const modalIds = ['diffItemModal', 'imgPickerModal', 'priceHistoryModal', 'uploadModal', 'editModal', 'settingsModal'];
  for (const id of modalIds) {
    const m = document.getElementById(id);
    if (m && m.classList.contains('open')) {
      m.classList.remove('open');
      // Clear per-modal state that would otherwise linger
      if (id === 'priceHistoryModal') _historyItem = null;
      if (id === 'diffItemModal')     _diffItemContext = null;
      if (id === 'editModal')         _editingItem = null;
      break; // only close the top-most open modal
    }
  }
});

document.addEventListener('DOMContentLoaded', boot);
