// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '-';

// Clock icon for the mobile cards' History button (lives in the card's icon row,
// next to 🔥/👁, so it never crowds the trend bar's min/max labels).
const HIST_CLOCK_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';

// Header dropdowns (notif / options / columns) each stop click propagation so
// the page-level "click outside closes it" listener doesn't fire on their own
// button - but that also means clicking one button never closes a sibling
// dropdown left open. Each button calls this before toggling its own.
const _headerDropdownIds = ['optionsDropdown', 'colChooserDropdown'];
function closeHeaderDropdowns(exceptId) {
  _headerDropdownIds.forEach(id => {
    if (id === exceptId) return;
    const el = $(id);
    if (el) el.style.display = 'none';
  });
}

// Strip "Woolworths " prefix for display. The underlying list_item key stays
// unchanged so price history and localStorage keys keep working.
const stripWW  = (name) => name.replace(/^Woolworths\s+/i, '');
// Short telegram display name (from name_map.js); falls back to stripWW.
const shortName = (name) => (window.PW_NAME_MAP && window.PW_NAME_MAP[name]) || stripWW(name);
// Per-store display name for a per-kg category member. Woolworths and Coles names
// are independent: an explicit per-store override wins, else the store's scraped
// product name, else the stripped list_item key.
// Repo display names (url_overrides.json ww_name/coles_name) outrank scraped
// store names: scrapes rewrite latest.json names every run (usually WITHOUT the
// pack size), so per-kg weights only stick when kept outside latest.json.
const wwNameFor = (item, o, data) => (o?.wwName || _repoUrlOverrides[item]?.ww_name || data?.woolworths?.name || stripWW(item));
const coNameFor = (item, o, data) => (o?.colesName || _repoUrlOverrides[item]?.coles_name || data?.coles?.name || stripWW(item));
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
  // Suppress "1ea" display - it just means the whole pack and adds no info
  if (/^1\s*ea\b/i.test(unit.trim())) return '';
  const m = unit.match(/^\d*\.?\d*\s*(?:g|kg|ml|l|ea|pk|pack|each)\b/i);
  return m ? `${fmt(price)}/${m[0].trim()}` : fmt(price);
};

// clientPer100() is provided by utils.js (loaded before app.js in index.html).

function clientPerKg(result) {
  if (!result || result.price == null) return null;
  const p = clientPer100(result);
  return p.value != null ? +(p.value * 10).toFixed(2) : null;
}

// ── Per-kg single source of truth ────────────────────────────────────────────
// Every per-kg number in the UI (current price, history modal, trend bar) is
// derived through these three helpers so the values can never diverge.

// Pack-price → $/kg multiplier for one store's result. Ratio is the store's own
// current $/kg over its current pack price; applied to that store's historical
// pack prices. Returns null when the store has no usable size/price data - the
// caller must then DROP that store's history rather than treat raw pack prices
// as $/kg (that mislabelling was a recurring source of wrong trend numbers).
// ponytail: assumes pack size is stable over the item's history - if a product's
// pack size changed, older points convert with the current ratio. Acceptable for
// a personal grocery tracker; the upgrade path is storing size per history entry.
function perKgRatio(res) {
  const kg = clientPerKg(res);
  return (kg != null && res?.price) ? kg / res.price : null;
}

// A member's exclusions split into per-store price sets ("12.34" strings).
// Supports "ww:X"/"coles:X" and the legacy bare-number format (treated as WW).
function exclSetsFor(itemName) {
  const ww = new Set(), co = new Set();
  for (const k of (loadExclusions()[itemName] || [])) {
    if (typeof k === 'number') { ww.add(k.toFixed(2)); continue; }
    const s = String(k);
    if (s.startsWith('coles:'))  co.add(Number(s.slice(6)).toFixed(2));
    else if (s.startsWith('ww:')) ww.add(Number(s.slice(3)).toFixed(2));
    else ww.add(Number(s).toFixed(2));
  }
  return { ww, co };
}

// A member's full $/kg price series: every history source + the current live
// price, each converted with its own store's ratio, exclusions applied.
// price_history and ww_price_history hold WW pack prices; coles_price_history
// holds Coles pack prices.
function memberPerKgPrices(m, useWw = true, useCo = true) {
  if (!m) return [];
  const wwR = useWw ? perKgRatio(m.woolworths) : null;
  const coR = useCo ? perKgRatio(m.coles) : null;
  const { ww: wwEx, co: coEx } = exclSetsFor(m.list_item);
  // r == null → can't convert this store's pack prices to $/kg (or the member
  // is per-kg-excluded at that store); drop the source.
  const conv = (arr, r, ex) => (r == null ? [] : (arr || [])
    .filter(e => e.price > 0 && !ex.has(Number(e.price).toFixed(2)))
    .map(e => +(e.price * r).toFixed(2)));
  const out = [
    ...conv(m.price_history,       wwR, wwEx),
    ...conv(m.ww_price_history,    wwR, wwEx),
    ...conv(m.coles_price_history, coR, coEx),
  ];
  if (useWw) { const wk = clientPerKg(m.woolworths); if (wk != null) out.push(wk); }
  if (useCo) { const ck = clientPerKg(m.coles);      if (ck != null) out.push(ck); }
  return out;
}

// Per-store include flags for a group member: skips per-kg category exclusions
// so the trend bar and merged history never resurrect a "different item".
function memberStoreFlags(group, m) {
  const excl = loadPerKgExclusions();
  return [
    !excl.has(`${group._groupKey}::${m.list_item}::ww`),
    !excl.has(`${group._groupKey}::${m.list_item}::coles`),
  ];
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

// ── Thresholds ────────────────────────────────────────────────────────────────

const STALE_DATA_DAYS          = 5;      // days before "data is stale" banner appears
const STALE_PROGRESS_MS        = 5 * 60 * 1000; // ms with no progress update → ⚠ Stalled

// ── Overrides (edit name / URL) ──────────────────────────────────────────────

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_overrides_v1') || '{}'); } catch { return {}; }
}

function saveOverrides(obj) {
  localStorage.setItem('pw_overrides_v1', JSON.stringify(obj));
}

// Pinned URLs committed to the repo (docs/data/url_overrides.json), keyed by
// item with {ww_url, coles_url}. This is the DURABLE record the scraper reads;
// localStorage (pw_overrides_v1) only holds pins made in this browser. Loading it
// lets the UI show items pinned from anywhere as pending members before a scrape.
let _repoUrlOverrides = {};
async function loadRepoUrlOverrides() {
  try {
    const r = await fetch(`data/url_overrides.json?t=${Date.now()}`);
    if (r.ok) _repoUrlOverrides = await r.json();
  } catch {}
}
// A pinned URL for a store from either source. localStorage uses wwUrl/colesUrl;
// the repo file uses ww_url/coles_url.
function pinnedUrlFor(name, store) {
  const o = loadOverrides()[name] || {};
  const repo = _repoUrlOverrides[name] || {};
  return store === 'ww' ? (o.wwUrl || repo.ww_url) : (o.colesUrl || repo.coles_url);
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
  // Merge with repo copy so entries from other sessions are preserved.
  const existing = await githubGetJson(s, 'docs/data/rejected_urls.json');
  const merged = { ...existing };
  for (const [item, stores] of Object.entries(rejected)) {
    merged[item] = merged[item] || {};
    for (const store of ['ww', 'coles']) {
      const urls = new Set([...(merged[item][store] || []), ...((stores && stores[store]) || [])]);
      if (urls.size) merged[item][store] = [...urls];
    }
  }
  await githubPutJson(s, 'docs/data/rejected_urls.json', merged, 'chore: sync rejected product URLs');
}

// ── Image overrides ───────────────────────────────────────────────────────────
// Stores { [list_item]: 'ww' | 'coles' } - user-chosen image source per item
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
  await githubPutJson(s, 'docs/data/archived_items.json', archivedNames, message);
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
  try {
    await githubPutJson(s, 'docs/data/watchlist.json', names, 'chore: sync watchlist');
  } catch (e) {
    showSyncError('watchlist', e);
  }
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
// contains and how many of each - which makes the basket total, basket saving
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
// Strip tombstoned (deleted) item keys from a settings map before it's stored
// or published - see REMOVED_ITEMS in utils.js for why this must be everywhere.
function dropRemovedKeys(obj) {
  for (const k of Object.keys(obj)) if (REMOVED_ITEMS.has(k)) delete obj[k];
  return obj;
}
async function persistUserSettingsToRepo() {
  const s = loadSettings();
  if (!s.token) return;
  const payload = {
    priorities: dropRemovedKeys(loadPriorities()),
    units: dropRemovedKeys(loadUnitOverrides()),
    perkg: [..._perkgSet].filter(n => !REMOVED_ITEMS.has(n)),
    exclusions: dropRemovedKeys(loadExclusions()),
  };
  try {
    await githubPutJson(s, 'docs/data/user_settings.json', payload, 'chore: sync user settings (priorities + quantities)');
  } catch (e) {
    showSyncError('priorities & quantities', e);
  }
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
        //
        // VIEWERS invert that precedence. A visitor can't publish (no token), so
        // repo-wins would silently undo their own weekly/monthly/rare and category
        // choices every time the owner published - the one thing they were invited
        // to play with. Local-wins keeps their edits and still lets the repo fill
        // in keys they've never touched, so a first-time viewer (empty localStorage)
        // still inherits the owner's full curated setup as their starting point.
        const viewer = isViewerMode();
        const merge = (mine, theirs) => viewer ? { ...theirs, ...mine } : { ...mine, ...theirs };
        localStorage.setItem('pw_priorities_v1', JSON.stringify(dropRemovedKeys(merge(loadPriorities(), remote.priorities || {}))));
        localStorage.setItem('pw_units_v1',      JSON.stringify(dropRemovedKeys(merge(loadUnitOverrides(), remote.units || {}))));
        if (Array.isArray(remote.perkg)) {
          _perkgSet = new Set([..._perkgSet, ...remote.perkg].filter(n => !REMOVED_ITEMS.has(n)));
          savePerkgLocal(_perkgSet);
        }
        // Price-history exclusions (incl. per-kg group-history point removals):
        // union per item so a device never silently drops the other's exclusions.
        // ponytail: union means un-excluding a point on one device won't propagate
        // the removal to others - the safe direction (never loses a correction).
        if (remote.exclusions && typeof remote.exclusions === 'object') {
          const merged = loadExclusions();
          for (const [item, arr] of Object.entries(remote.exclusions)) {
            if (!Array.isArray(arr) || REMOVED_ITEMS.has(item)) continue;
            merged[item] = [...new Set([...(merged[item] || []), ...arr])];
          }
          saveExclusions(dropRemovedKeys(merged));
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
  // Race guard: the scraper snapshots latest.json at boot and rebuilds it at the
  // end of a run, so an edit saved mid-scrape gets silently resurrected from that
  // boot snapshot (progress pushes even pull with -X ours). scrape_progress is
  // present exactly while a run is live - warn before writing into that window.
  if (data?.scrape_progress &&
      !confirm('A scrape is running right now - the scraper may overwrite this change when it finishes.\n\nSave anyway?')) {
    throw new Error('Save cancelled - scrape in progress');
  }
  await githubPutJson(s, 'docs/data/latest.json', data, message);
}

async function persistUrlOverridesToRepo(s, overrides, exactItems = []) {
  if (!s?.user || !s?.repo || !s?.token) return;
  // Merge rather than overwrite: entries already in the repo but not in
  // localStorage (e.g. manually added by Claude) are preserved; localStorage
  // entries take priority on conflict.
  //
  // exactItems: names whose repo entry must mirror the local state EXACTLY -
  // including deleting url keys / the whole entry. Merge-only semantics made it
  // impossible to ever remove a pinned URL ("delete the URL and save" bug): the
  // repo kept the old key forever. Only the item being edited is treated
  // exactly, so unrelated repo-side pins are never clobbered by stale
  // localStorage entries.
  const existing = await githubGetJson(s, 'docs/data/url_overrides.json');
  const merged = { ...existing };
  for (const [item, ov] of Object.entries(overrides)) {
    if (ov.wwUrl || ov.colesUrl) {
      merged[item] = { ...(merged[item] || {}) };
      if (ov.wwUrl)    merged[item].ww_url    = ov.wwUrl;
      if (ov.colesUrl) merged[item].coles_url = ov.colesUrl;
    }
  }
  for (const item of exactItems) {
    const ov = overrides[item];
    const entry = { ...(merged[item] || {}) };
    delete entry.ww_url;
    delete entry.coles_url;
    if (ov?.wwUrl)    entry.ww_url    = ov.wwUrl;
    if (ov?.colesUrl) entry.coles_url = ov.colesUrl;
    if (Object.keys(entry).length) merged[item] = entry;
    else delete merged[item];
  }
  await githubPutJson(s, 'docs/data/url_overrides.json', merged, 'Update URL overrides');
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
    let names = await res.json();
    if (!Array.isArray(names) || !names.length) return;
    names = names.filter(n => !REMOVED_ITEMS.has(n)); // tombstoned = deleted for good
    _repoArchivedSet = new Set(names);
    const pr = loadPriorities();
    let changed = false;
    names.forEach(name => {
      if (pr[name] == null) { pr[name] = 'archive'; changed = true; }
    });
    // Scrub tombstoned names out of this device's local priorities too, so the
    // next sync can't push them back into the repo.
    for (const k of Object.keys(pr)) {
      if (REMOVED_ITEMS.has(k)) { delete pr[k]; changed = true; }
    }
    if (changed) savePriorities(pr);
  } catch { /* offline / missing file - non-fatal */ }
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

// The 9 live categories (grocery-store walk order); 'Other' is appended
// dynamically as the fallback. Old names remap via CATEGORY_REMAP in utils.js.
const KNOWN_CATEGORIES = [
  'Fruit & Veg', 'Meat & Seafood', 'Dairy & Eggs', 'Pantry', 'Sweets',
  'Frozen', 'Drinks & Alcohol', 'Household', 'Baby & Care',
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
  if (typeof itemName === 'string' && itemName.startsWith('__group_')) {
    const k = itemName.slice(8);
    return (UNIT_BASED_GROUPS.has(k) || STICKER_GROUPS.has(k)) ? 1 : 1.0;
  }
  if (_perkgSet.has(itemName)) return 1.0;
  const qty = getAnalysisData(itemName).avg_qty;
  return qty != null ? Math.round(qty) : 1;
}

// Kg-quantity rows: loose per-kg entries (meat/seafood cuts, _perkgSet items) -
// their Units value means KILOGRAMS, not a pack count. Unit-based groups
// (Nutella, potato bags, yoghurt tubs...) count discrete packs like normal items.
function isKgQty(itemName) {
  if (typeof itemName !== 'string') return false;
  const k = itemName.startsWith('__group_') ? itemName.slice(8) : null;
  const packGroup = k && (UNIT_BASED_GROUPS.has(k) || STICKER_GROUPS.has(k)); // bought as packs
  return !packGroup && (_perkgSet.has(itemName) || itemName.startsWith('__group_'));
}

// ── Category normalisation ────────────────────────────────────────────────────
// CATEGORY_REMAP + normalizeCategory() live in utils.js (shared with hot-deals
// and shopping-list, so the three pages can't drift on category names again).

// ITEM_CATEGORY_DEFAULTS lives in utils.js: shopping-list and hot-deals resolve
// categories too, and when only this file had the map, an item corrected here
// (garlic → Fruit & Veg) landed under its RAW category on the Basket page.

function getCategory(item) {
  // Precedence: user override → per-item default → scraped category. Normalising
  // LAST is the whole trick: an old override or default naming a merged/renamed
  // category still resolves to the live one.
  const raw = loadCategoryOverrides()[item.list_item]
    || ITEM_CATEGORY_DEFAULTS[item.list_item]
    || item.category;
  return normalizeCategory(raw);
}

// ── Filter state ─────────────────────────────────────────────────────────────

let _activePriority = 'weekly';

let _searchQuery = '';
let _perkgSet = new Set();   // items compared by $/kg (synced via user_settings.json)
let _perkgFilter = 'all';  // per-kg group visibility: 'all' | 'only' | 'hidden' (⚙ /kg button cycles)

// DEFAULT_VARIANT_GROUPS (the per-kg category seed) lives in utils.js so the
// basket page can exclude group members without loading all of app.js.

// Effective categories = seed defaults merged with the user's saved label/membership
// overrides (pw_perkg_cats_v1). Returns a fresh array each call.
// ── Per-kg override model (pure helpers; unit-tested in scripts/perkg_selfcheck.js) ──
// The override is a DIFF against the code defaults, not a frozen snapshot. This is the
// whole point: defaults stay authoritative, so a member removed in code disappears and
// a member added in code appears - while the user's own add/remove/rename still stick.
// The old snapshot form ({items, ww_items, coles_items}) is migrated on read.
//
//   v2 shape: { v:2, label?, add:[], remove:[], ww_order?, coles_order? }
//
// Known migration limit: a union snapshot can't tell a user-added item from a default
// that was later pruned in code - both look like "extra" names - so on upgrade they're
// kept as `add`. The user can remove such a straggler once and it now stays removed.
function migratePerKgOverride(o, defaultItems) {
  if (!o || typeof o !== 'object') return { v: 2, add: [], remove: [] };
  if (o.v === 2) return o;
  const out = { v: 2, label: o.label, add: [], remove: [] };
  if (Array.isArray(o.items)) out.add = o.items.filter(n => !defaultItems.includes(n));
  if (Array.isArray(o.ww_items)) out.ww_order = o.ww_items;
  if (Array.isArray(o.coles_items)) out.coles_order = o.coles_items;
  return out;
}

// Flat member list = (defaults minus user-removed) then user-added, de-duped vs defaults.
function computePerKgItems(defaultItems, override) {
  const o = migratePerKgOverride(override, defaultItems);
  const remove = new Set(o.remove || []);
  const add = (o.add || []).filter(n => !defaultItems.includes(n));
  return [...defaultItems.filter(n => !remove.has(n)), ...add];
}

function loadVariantGroups() {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  return DEFAULT_VARIANT_GROUPS.map(g => {
    const o = migratePerKgOverride(ov[g.key], g.items);
    return {
      key: g.key,
      label: o.label || g.label,
      category: g.category,
      sticker: !!g.sticker,
      items: computePerKgItems(g.items, o),
      // Per-store ordered member lists (display order hints; membership comes from
      // `items` + price qualification in resolveStoreLists). Null until the user saves.
      ww_items: Array.isArray(o.ww_order) ? o.ww_order : null,
      coles_items: Array.isArray(o.coles_order) ? o.coles_order : null,
    };
  });
}

// Resolve a category's per-store member lists (ordered). If the override has an
// explicit ww_items/coles_items list, use it verbatim (explicit membership - keep
// even pending items). Otherwise derive: an item belongs to a store's list if it
// has a pinned URL or a real (>0) price there.
function resolveStoreLists(group, byName) {
  const qualifies = (name, store) => {
    const data = byName.get(name);
    const price = store === 'ww' ? data?.woolworths?.price : data?.coles?.price;
    return price != null && price > 0;
  };
  const build = (orderArr, store) => {
    let names;
    if (Array.isArray(orderArr)) {
      names = orderArr.filter(n => group.items.includes(n) && qualifies(n, store));
      // Append any union item that now qualifies for this store but isn't listed yet.
      for (const it of group.items) if (!names.includes(it) && qualifies(it, store)) names.push(it);
    } else {
      names = group.items.filter(n => qualifies(n, store));
    }
    return names;
  };
  return {
    ww: build(group.ww_items, 'ww'),
    coles: build(group.coles_items, 'coles'),
  };
}
function saveVariantGroupOverride(key, patch) {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  const def = DEFAULT_VARIANT_GROUPS.find(d => d.key === key);
  const cur = migratePerKgOverride(ov[key], def ? def.items : []); // upgrade legacy in place
  ov[key] = { ...cur, ...patch, v: 2 };
  delete ov[key].items; delete ov[key].ww_items; delete ov[key].coles_items; // strip legacy snapshot keys
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
let _selectedItems = new Set(); // session-only mobile card selection
let _viewMode = localStorage.getItem('pw_view_mode') || 'table'; // 'table' | 'card'
let _mcView = localStorage.getItem('pw_mc_view_v1') || 'detailed'; // mobile card view: 'detailed' | 'compact'

// ── Bulk selection ────────────────────────────────────────────────────────────

let _checkedItems = new Set();

// ── The basket ────────────────────────────────────────────────────────────────
// A normal persistent cart (localStorage pw_sl_handoff, read by the basket
// page). Items get in ONLY when the user adds them (＋ button, card tap, or the
// bulk "Add to Basket") and stay until removed. _selectedItems is the live
// in-page mirror: ✓ marks on cards/panel rows mean "in the basket". Desktop
// row checkboxes are transient bulk-action selection and are NEVER pre-seeded.
function basketQtyMap() {
  try { return { ...(JSON.parse(localStorage.getItem('pw_sl_handoff') || '{}').quantities || {}) }; } catch { return {}; }
}
// Write the basket from the current _selectedItems + an explicit quantity map
// (integer packs, min 1, default 1 for anything missing; stale keys pruned).
function writeBasket(qtyMap) {
  const items = [..._selectedItems];
  const quantities = {};
  items.forEach(n => { const q = Number((qtyMap || {})[n]); quantities[n] = Number.isFinite(q) && q >= 1 ? Math.round(q) : 1; });
  localStorage.setItem('pw_sl_handoff', JSON.stringify({ items, quantities }));
}
// Simple add/remove (single unit, from card taps / panel ＋): keep existing
// quantities, default new to 1.
function persistBasketStore() { writeBasket(basketQtyMap()); }
(function mirrorBasketSelection() {
  try {
    (JSON.parse(localStorage.getItem('pw_sl_handoff') || '{}').items || [])
      .forEach(n => _selectedItems.add(n));
  } catch { /* corrupt store - start empty */ }
  localStorage.removeItem('pw_sl_locked'); // retired lock flag
  _updateSelectedPill();
})();

// ── Permanent delete ─────────────────────────────────────────────────────────
// Owner-only (needs the GitHub token, so a viewer/demo copy simply can't).
// Purges a product everywhere it can reach and writes the tombstone that stops
// the next scrape re-creating it from shopping_list.xlsx.
//
// The tombstone is written FIRST and deliberately: if any later PUT fails (rate
// limit, conflict, connection drop) the gate is already in place, so the item
// stays gone instead of coming back on the next run. Everything after it is
// cleanup that can be retried by simply deleting again.
async function deleteItemsForever(names) {
  const s = loadSettings();
  if (!s?.token) {
    alert('Permanent delete needs the owner GitHub token - it is disabled in the shared/demo copy.');
    return;
  }
  names = [...new Set(names.filter(Boolean))];
  if (!names.length) return;

  const shown = names.slice(0, 8).map(n => '• ' + stripWW(n)).join('\n');
  const more = names.length > 8 ? `\n…and ${names.length - 8} more` : '';
  if (!confirm(
    `Permanently delete ${names.length} product${names.length !== 1 ? 's' : ''}?\n\n${shown}${more}\n\n` +
    `This removes them from current prices, the price-change archive and the scrape log, ` +
    `and blocks future scrapes from bringing them back.\n\nThis cannot be undone.`)) return;

  const rm = new Set(names);
  const drop = list => (list || []).filter(n => !rm.has(typeof n === 'string' ? n : n?.item));
  showToast(`Deleting ${names.length} product${names.length !== 1 ? 's' : ''}…`, 60000);
  let failed = [];
  const step = async (label, fn) => { try { await fn(); } catch (e) { failed.push(`${label}: ${e.message}`); } };

  // 1. THE GATE - do this before anything else.
  await step('removed_items.json', async () => {
    const cur = await githubGetJson(s, 'docs/data/removed_items.json');
    const merged = [...new Set([...(Array.isArray(cur) ? cur : []), ...names])].sort();
    await githubPutJson(s, 'docs/data/removed_items.json', merged,
      `chore: permanently delete ${names.length} product(s)`);
    mergeRemovedItems(names);
  });

  // 2. Current prices (race-guarded - warns if a scrape is live).
  await step('latest.json', async () => {
    const d = await githubGetJson(s, 'docs/data/latest.json');
    if (!d?.items) return;
    d.items = d.items.filter(i => !rm.has(i.list_item));
    d.not_found_items = drop(d.not_found_items);
    await persistLatestJson(d, `chore: remove ${names.length} deleted product(s)`);
  });

  // 3. Pinned URLs - the single biggest resurrection vector (the scraper re-adds
  //    anything still keyed here), so it must be cleared even though the scraper
  //    now also gates on the tombstone.
  await step('url_overrides.json', async () => {
    const ov = await githubGetJson(s, 'docs/data/url_overrides.json');
    if (!ov || typeof ov !== 'object') return;
    let changed = false;
    names.forEach(n => { if (n in ov) { delete ov[n]; changed = true; } });
    if (changed) await githubPutJson(s, 'docs/data/url_overrides.json', ov, 'chore: drop pins for deleted products');
  });

  await step('archived_items.json', async () => {
    const a = await githubGetJson(s, 'docs/data/archived_items.json');
    if (!Array.isArray(a)) return;
    const next = drop(a);
    if (next.length !== a.length) await githubPutJson(s, 'docs/data/archived_items.json', next, 'chore: drop deleted products from archive');
  });

  // 4. History.
  await step('price_changes.json', async () => {
    const p = await githubGetJson(s, 'docs/data/price_changes.json');
    if (!Array.isArray(p)) return;
    let changed = false;
    p.forEach(run => ['ww', 'coles'].forEach(k => {
      const before = (run[k] || []).length;
      run[k] = drop(run[k]);
      if (run[k].length !== before) changed = true;
    }));
    if (changed) await githubPutJson(s, 'docs/data/price_changes.json', p, 'chore: drop deleted products from price history');
  });

  await step('scrape_log.json', async () => {
    const l = await githubGetJson(s, 'docs/data/scrape_log.json');
    if (!Array.isArray(l)) return;
    let changed = false;
    l.forEach(run => ['ww_missed', 'coles_missed'].forEach(k => {
      const before = (run[k] || []).length;
      run[k] = drop(run[k]);
      if (run[k].length !== before) changed = true;
    }));
    if (changed) await githubPutJson(s, 'docs/data/scrape_log.json', l, 'chore: drop deleted products from scrape log');
  });

  // 5. This device's own state. user_settings/watchlist need no repo write - the
  //    existing REMOVED_ITEMS filters on the sync paths strip them on next push,
  //    and mergeRemovedItems() above just taught those filters these names.
  try {
    const pr = loadPriorities(); names.forEach(n => delete pr[n]); savePriorities(pr);
    const ov = loadOverrides(); names.forEach(n => delete ov[n]); localStorage.setItem('pw_overrides_v1', JSON.stringify(ov));
    const u = JSON.parse(localStorage.getItem('pw_units_v1') || '{}'); names.forEach(n => delete u[n]);
    localStorage.setItem('pw_units_v1', JSON.stringify(u));
    const w = loadWatchlistLocal(); names.forEach(n => w.delete(n)); saveWatchlistLocal(w);
    const q = basketQtyMap(); names.forEach(n => { delete q[n]; _selectedItems.delete(n); }); writeBasket(q);
  } catch {}
  names.forEach(n => _checkedItems.delete(n));

  // Drop from the in-memory copy so the rows disappear now, not after a reload.
  if (_lastData?.items) _lastData.items = _lastData.items.filter(i => !rm.has(i.list_item));
  updateBulkBar();
  if (_lastData) renderPage(_lastData);
  showToast(failed.length
    ? `Deleted, but ${failed.length} file(s) failed: ${failed[0]}`
    : `🗑 ${names.length} product${names.length !== 1 ? 's' : ''} permanently deleted`, failed.length ? 9000 : 4000);
}

function updateBulkBar() {
  const bar = $('bulkToolbar');
  if (!bar) return;
  const count = _checkedItems.size;
  bar.style.display = count > 0 ? 'flex' : 'none';
  const pill = bar.querySelector('.bt-count-pill');
  if (pill) pill.textContent = count;
  // In the Archived view the archive button is a no-op (they're already
  // archived) - flip it to "Unarchive". Also hide the Priority chip there: it
  // only offers weekly/monthly/rare, which would silently unarchive anyway, so
  // Unarchive is the clear single action.
  const inArchive = _activePriority === 'archive';
  const archBtn = bar.querySelector('.bt-archive');
  if (archBtn) archBtn.innerHTML = inArchive ? '📤 Unarchive' : '🗄 Archive';
  const priChip = bar.querySelector('.bt-pri');
  if (priChip) priChip.style.display = inArchive ? 'none' : '';
  // Permanent delete is owner-only: it writes to the repo, so a viewer could
  // never complete it. Hide rather than disable - a dead button on the demo copy
  // invites clicks that can only fail.
  const delBtn = bar.querySelector('.bt-delete');
  if (delBtn) delBtn.style.display = (typeof isViewerMode === 'function' && isViewerMode()) ? 'none' : '';

  // Show the CURRENT category + priority of the checked rows on the chips (so you
  // see what they are before changing them). Uniform selection => the shared
  // value, highlighted; mixed => "Mixed (N)". Stored on the chip for the dropdown
  // to tick the matching option(s).
  const { cats, pris } = selectionMeta();
  const catChip = bar.querySelector('.bt-cat');
  if (catChip) {
    const label = cats.length === 1 ? cats[0] : cats.length ? `Mixed (${cats.length})` : 'Category';
    catChip.innerHTML = `📁 ${esc(label)} <span class="arrow">▾</span>`;
    catChip.classList.toggle('bt-chip-set', cats.length === 1);
    catChip._current = cats;
  }
  if (priChip) {
    const label = pris.length === 1 ? PRIORITY_LABELS[pris[0]] || pris[0]
                : pris.length ? `Mixed (${pris.length})` : '⭐ Priority';
    priChip.innerHTML = `${esc(label)} <span class="arrow">▾</span>`;
    priChip.classList.toggle('bt-chip-set', pris.length === 1);
    priChip._current = pris;
  }
  reflectBulkQty();
}

// Category label per priority value (icon + word), reused by the bulk chip + dropdown.
const PRIORITY_LABELS = { weekly: '⭐ Weekly', monthly: '📅 Monthly', rare: '🔵 Rare', archive: '🗄 Archived' };

// Distinct categories + priorities across the currently checked rows.
function selectionMeta() {
  const cats = new Set(), pris = new Set();
  const byName = new Map((_lastDisplayItems || []).map(i => [i.list_item, i]));
  for (const name of _checkedItems) {
    const it = byName.get(name);
    if (it) cats.add(getCategory(it));
    pris.add(getPriority(name));
  }
  return { cats: [...cats], pris: [...pris] };
}

// The bulk bar's units-to-add stepper. At 0 the ＋ Basket button flips to a
// ✕ Remove that drops the checked rows from the basket.
let _bulkQty = 1;
function reflectBulkQty() {
  const bar = $('bulkToolbar');
  if (!bar) return;
  const q = bar.querySelector('.bt-qty');
  if (q) q.textContent = _bulkQty;
  const dec = bar.querySelector('.bt-qty-dec');
  if (dec) dec.disabled = _bulkQty <= 0;
  const btn = bar.querySelector('.bt-sl');
  if (!btn) return;
  if (_bulkQty === 0) {
    btn.textContent = '✕ Remove';
    btn.classList.add('is-remove');
    // Nothing to remove unless a checked row is actually in the basket.
    btn.disabled = !checkedRealNames(true).some(n => _selectedItems.has(n));
  } else {
    // Label stays plain "＋ Basket" - the stepper beside it already shows the
    // unit count, so repeating it as "×N" on the button was redundant.
    btn.textContent = '＋ Basket';
    btn.classList.remove('is-remove');
    btn.disabled = false;
  }
}

// Checked rows resolved to basket entry names. A per-kg group row goes in AS
// THE CATEGORY (its __group_* key): the basket page prices it per store as
// that store's cheapest variant, re-resolved on every visit - following the
// group, not whichever product happened to win on the day it was added. On
// REMOVE a group drops its key AND all member names (baskets from before this
// model hold individual members).
function checkedRealNames(forRemove) {
  if (!_lastData) return [];
  const names = new Set();
  for (const n of _checkedItems) {
    names.add(n);
    if (forRemove && n.startsWith('__group_')) {
      const g = loadVariantGroups().find(gr => '__group_' + gr.key === n);
      (g?.items || []).forEach(m => names.add(m));
    }
  }
  return [...names];
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
  name:         210,
  trend:        125,
  priority:      90,
  ww:            85,
  coles:         85,
  cheaper:       72,
  pct:           68,
  saving:        78,
  units:         70,
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
  try { return JSON.parse(localStorage.getItem('pw_col_widths_v2')) || {}; } catch { return {}; }
})();

function saveColOrder()      { localStorage.setItem('pw_col_order', JSON.stringify(_colOrder)); }
function saveColWidths()     { localStorage.setItem('pw_col_widths_v2', JSON.stringify(_colWidths)); }
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
      const u = getUnits(item.list_item);
      const w = mbEffUnit(item.woolworths, u), c = mbEffUnit(item.coles, u);
      if (w == null || c == null) return null;
      return Math.abs(w - c) / Math.max(w, c) * 100;
    }
    case 'saving':    return mbSaving(item);
    case 'units':     return getUnits(item.list_item);
    case 'trips':     return item.trip_count || 0;
    case 'ww_total':    return rowStoreTotal(item, 'ww');
    case 'coles_total': return rowStoreTotal(item, 'coles');
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
    case 'priority':     { const p = getPriority(item.list_item); return p === 'archive' ? 'Archived' : p[0].toUpperCase() + p.slice(1); }
    case 'ww':           return item.woolworths?.price != null ? fmt(item.woolworths.price) : '(Missing)';
    case 'coles':        return item.coles?.price != null ? fmt(item.coles.price) : '(Missing)';
    case 'cheaper':      { const c = item.cheaper_store; return c === 'woolworths' ? 'Woolworths' : c === 'coles' ? 'Coles' : c === 'equal' ? 'Equal' : 'N/A'; }
    case 'pct': {
      const ww = item.woolworths?.price, co = item.coles?.price;
      if (ww == null || co == null) return '-';
      return Math.round(Math.abs(ww - co) / Math.max(ww, co) * 100) + '%';
    }
    case 'saving':       { const s = savingAmount(item); return s > 0 ? fmt(s * getUnits(item.list_item)) : '-'; }
    case 'trips':        return String(item.trip_count || 0);
    // Kg rows filter as "1.0kg" (their real meaning), pack rows as plain counts.
    case 'units':        { const u = getUnits(item.list_item); return isKgQty(item.list_item) ? u.toFixed(1) + 'kg' : String(u); }
    case 'category':     return getCategory(item);
    case 'last_scraped': return item.last_scraped
      ? new Date(item.last_scraped).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '-';
    case 'ww_total':
    case 'coles_total': {
      const v = rowStoreTotal(item, col === 'ww_total' ? 'ww' : 'coles');
      return v != null ? fmt(v) : '-';
    }
    default: return '';
  }
}

function resetColumns() {
  _colOrder      = [...DEFAULT_COL_ORDER];
  _colVisibility = { ...DEFAULT_COL_VISIBILITY };
  // Reset means "go back to defaults", including auto-picking the cheaper
  // store's Total column again.
  try { localStorage.removeItem('pw_col_total_manual'); } catch {}
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
    // 2026-07-20: all header text left-aligned (user request) - cells keep
    // their own center/right alignment, only the th labels line up left.
    case 'cheaper':      return th('cheaper', '', 'Best');
    case 'pct':          return th('pct', '', 'Diff');
    case 'saving':       return th('saving', '', 'Savings');
    case 'trips':        return th('trips', '', 'Buys');
    case 'priority':     return th('priority', '', 'Priority');
    case 'units':        return th('units', '', 'Qty');
    case 'category':     return th('category', '', 'Category');
    case 'last_scraped': return th('last_scraped', '', 'Last Scraped');
    case 'ww_total':     return th('ww_total', '', '<span class="store-chip ww sm">W</span> Total');
    case 'coles_total':  return th('coles_total', '', '<span class="store-chip coles sm">C</span> Total');
    default: return '';
  }
}

// ── Price history bar ────────────────────────────────────────────────────────

function savingAmount(item) {
  // Per-kg groups: their .woolworths/.coles are DIFFERENT pack sizes (each
  // store's best variant), so |w−c| compared apples to oranges - an equal-$/kg
  // group could sort as the biggest "saving". Compare the $/kg headlines.
  if (item._isGroup) {
    if (item._wwPerKg == null || item._coPerKg == null) return 0;
    return Math.abs(item._wwPerKg - item._coPerKg);
  }
  const w = item.woolworths?.price, c = item.coles?.price;
  if (w == null || c == null) return item.saving_per_item ?? 0;
  return Math.abs(w - c);
}

function buildPriceBar(itemName, priceHistory, currentPrice, factor = 1) {
  if (!priceHistory?.length || currentPrice == null) return '';

  // exclPriceSet (utils.js) handles both "ww:X.XX"/"coles:X.XX" and legacy bare keys.
  // For trend bars (mixed WW+Coles series) a price excluded at either store is dropped.
  const excluded = exclPriceSet(loadExclusions()[itemName]);
  // Use raw history prices - they are already in the same monetary units (pack/shelf price)
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
      // Current price is below all historical prices - green circle left
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-marker-off-left"></div><div class="price-bar price-bar-flat"></div></div>`;
    } else if (currentPrice > minP + 0.005) {
      // Current price is above all historical prices - red circle right
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-bar price-bar-flat"></div><div class="price-marker-off-right"></div></div>`;
    } else {
      flatTrack = `<div class="price-bar price-bar-flat"><div class="price-marker" style="left:50%"></div></div>`;
    }
    return `
    <div class="price-bar-outer">
      ${flatTrack}
      <div class="price-bar-labels price-bar-labels-flat"><span class="price-bar-always">${fmt(minP)}</span></div>
    </div>
    <button class="price-bar-manage" data-manage-item="${safeItemName}" aria-label="View price history"><svg class="pbm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg><span class="pbm-txt">History</span></button>`;
  }

  const rawPos = ((currentPrice - minP) / (maxP - minP)) * 100;
  const pos = Math.max(0, Math.min(100, rawPos));
  // (The old hover histogram tooltip was removed as redundant - the History
  // modal, one click away on the always-visible clock icon, shows the same
  // data properly.)
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

  const allTimeLowBadge = rawPos === 0 ? '<span class="trophy-icon" title="All-time low - the cheapest this item has ever been recorded at">🏆</span>' : '';
  return `
    <div class="price-bar-outer">
      ${trackHtml}
      <div class="price-bar-labels">
        <span>${fmt(minP)}${allTimeLowBadge}</span>
        <span>${fmt(maxP)}</span>
      </div>
    </div>
    <button class="price-bar-manage" data-manage-item="${safeItemName}" aria-label="View price history"><svg class="pbm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg><span class="pbm-txt">History</span></button>`;
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
      // Persist the pending scrape so navigating away / refreshing doesn't lose
      // the status - checkPendingItemRefresh() picks the marker up on any load.
      try {
        const m = JSON.parse(localStorage.getItem('pw_pending_refresh') || '{}');
        m[itemName] = Date.now();
        localStorage.setItem('pw_pending_refresh', JSON.stringify(m));
      } catch {}
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

// Continuity for single-item scrapes across refresh/navigation: the dispatch
// writes a localStorage marker; this checks it against the loaded data. Fresh
// data for the item → "updated" toast; still pending → one reminder per page
// load; older than 15 min → silently dropped (run died or was skipped).
let _pendingRefreshNotified = false;
function checkPendingItemRefresh(data) {
  let m;
  try { m = JSON.parse(localStorage.getItem('pw_pending_refresh') || '{}'); } catch { return; }
  const names = Object.keys(m);
  if (!names.length) return;
  let changed = false;
  const stillPending = [];
  for (const name of names) {
    const item = data.items?.find(i => i.list_item === name);
    const scrapedTs = item?.last_scraped ? new Date(item.last_scraped).getTime() : 0;
    if (scrapedTs > m[name]) {
      delete m[name]; changed = true;
      showToast(`✓ "${stripWW(name)}" re-scraped - price updated.`);
    } else if (Date.now() - m[name] > 15 * 60 * 1000) {
      delete m[name]; changed = true;
    } else if (!_pendingRefreshItems.has(name)) {
      stillPending.push(name);
    }
  }
  if (changed) { try { localStorage.setItem('pw_pending_refresh', JSON.stringify(m)); } catch {} }
  if (stillPending.length && !_pendingRefreshNotified) {
    _pendingRefreshNotified = true;
    showToast(`⏳ Re-scrape still running: ${stillPending.map(stripWW).join(', ')}`, 5000);
  }
}

// Continuity for FULL scrapes across refresh/navigation (the strip's "waiting"
// state). Marker set on dispatch; considered spent once the data is newer than
// the dispatch (run finished) or after 100 min (past the workflow timeout).
// header.js runs the same check on pages that don't load app.js.
function scrapeDispatchPending(data) {
  let disp;
  try { disp = localStorage.getItem('pw_scrape_dispatched_v1'); } catch { return false; }
  if (!disp) return false;
  const t = Date.parse(disp);
  if (isNaN(t) || Date.now() - t > 100 * 60 * 1000 ||
      (data?.last_updated && Date.parse(data.last_updated) >= t)) {
    try { localStorage.removeItem('pw_scrape_dispatched_v1'); } catch {}
    return false;
  }
  return true;
}

async function pollItemRefresh(s, btn, itemName) {
  _pendingRefreshItems.add(itemName);
  if (_lastData) renderPage(_lastData);

  const dispatchedAt = new Date().toISOString();
  const apiBase = `https://api.github.com/repos/${s.user}/${s.repo}`;
  const apiHeaders = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' };

  const finish = (fresh) => {
    _pendingRefreshItems.delete(itemName);
    try {
      const m = JSON.parse(localStorage.getItem('pw_pending_refresh') || '{}');
      delete m[itemName];
      localStorage.setItem('pw_pending_refresh', JSON.stringify(m));
    } catch {}
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
    if (fresh) { showToast(`✓ "${stripWW(itemName)}" updated`); renderPage(fresh); }
    else { showToast(`⚠ "${stripWW(itemName)}" scrape didn't complete - check GitHub Actions`, 5000); if (_lastData) renderPage(_lastData); }
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
    if (!res.ok) return { anyOnline: true, runners: [] }; // fail open - don't block on API error
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
    banner.innerHTML = `⚠️ Price data is more than ${STALE_DATA_DAYS} days old - scraper is currently <strong>offline</strong>. Prices cannot be updated until the Windows runner restarts.`;
  } else {
    banner.innerHTML = `⚠️ Price data is more than ${STALE_DATA_DAYS} days old - click <strong>Update Prices</strong> to refresh.`;
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

  // Optional chain: header.js doesn't render the ⚙ Auto-update Setup entry for
  // VIEWERS, and this unguarded listener threw on the null - killing init()
  // before renderPage, so a visitor (or any owner device without a token) got a
  // permanently "Loading price data…" page. The modal itself stays wired: the
  // ?setup=1 escape hatch re-renders the button and needs it working.
  $('settingsBtn')?.addEventListener('click', open);
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
    const prevWw = prevOv.wwUrl    || _editingItem.woolworths?.url || '';
    const prevCo = prevOv.colesUrl || _editingItem.coles?.url      || '';
    // Per-store intent: a cleared field REMOVES the item from that store (the
    // remaining URL becomes a single-store pin; the scraper stops checking the
    // cleared store). A changed non-empty field re-pins + rescrapes.
    const wwRemoved = !!prevWw && !newWwUrl;
    const coRemoved = !!prevCo && !newCoUrl;
    const wwChanged = !!newWwUrl && newWwUrl !== prevWw;
    const coChanged = !!newCoUrl && newCoUrl !== prevCo;

    if (wwRemoved && coRemoved) {
      alert('Both links removed - that would leave the item with no store at all.\nUse Archive to stop tracking it entirely, or keep at least one link.');
      return;
    }
    if ((wwRemoved || coRemoved) && !(newWwUrl || newCoUrl)) {
      alert(`Removing a store needs the other store's link to stay pinned, but none is set.`);
      return;
    }

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

    // Store removal applies immediately: null the store locally + in the repo
    // copy of latest.json (the scraper keeps it dropped from the next run on -
    // single-store pins are skipped and no longer carried forward).
    if ((wwRemoved || coRemoved) && _lastData) {
      const li = _lastData.items?.find(i => i.list_item === item.list_item);
      if (li) {
        if (wwRemoved) li.woolworths = null;
        if (coRemoved) li.coles = null;
        li.cheaper_store = null;
        li.saving_per_item = null;
      }
    }
    if (_lastData) renderPage(_lastData);

    const s = loadSettings();
    if (s.user && s.repo && s.token) {
      if (_overridesSaving) return; // another PUT is in-flight; skip to avoid SHA race
      _overridesSaving = true;
      $('editSave').disabled = true;
      $('editReset').disabled = true;
      try {
        // Exact semantics for THIS item (deletions included); merge for the rest.
        await persistUrlOverridesToRepo(s, overrides, [item.list_item]);
        if (wwRemoved || coRemoved) {
          await persistLatestJson(_lastData, `edit: ${item.list_item} - removed from ${wwRemoved ? 'Woolworths' : 'Coles'}`);
          showToast(`✓ "${item.list_item}" removed from ${wwRemoved ? 'Woolworths' : 'Coles'}.`);
        }
        // A URL was added/changed → immediate single-item rescrape with it
        if (wwChanged || coChanged) {
          triggerItemRefresh(item.list_item, null, { wwUrl: newWwUrl, colesUrl: newCoUrl });
          showToast(`✓ Scrape triggered for "${item.list_item}" with the new URL.`);
        }
      } catch (e) {
        showSyncError('URL override', e);
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
        // Exact semantics so the repo entry is actually deleted (reset = back to
        // automatic name-matching at both stores).
        await persistUrlOverridesToRepo(s, overrides, [_editingItem.list_item]);
      } catch (e) {
        showSyncError('URL override (reset)', e);
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

  // Include today's live scraped price so the current point shows on the chart (the
  // table already injects it). Without this, the current Coles point never appears -
  // coles_price_history is usually empty - and the WW line stops at its last recorded date.
  const liveDate = item.woolworths?.scraped_at?.slice(0, 10) || item.coles?.scraped_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  if (item.woolworths?.price > 0 && !wwRaw.some(e => e.date === liveDate)) wwRaw.push({ date: liveDate, price: item.woolworths.price });
  if (item.coles?.price > 0 && !coRaw.some(e => e.date === liveDate)) coRaw.push({ date: liveDate, price: item.coles.price });
  wwRaw.sort((a, b) => a.date.localeCompare(b.date));
  coRaw.sort((a, b) => a.date.localeCompare(b.date));

  // excludedPrices is now a Set of "ww:X.XX" / "coles:X.XX" keys (or legacy bare numbers → ww)
  const exclWW = new Set([...excludedPrices].filter(k => !k.includes(':') || k.startsWith('ww:')).map(k => k.includes(':') ? k.split(':')[1] : k));
  const exclCo = new Set([...excludedPrices].filter(k => k.startsWith('coles:')).map(k => k.split(':')[1]));
  const isExclWW = v => v != null && exclWW.has(Number(v).toFixed(2));
  const isExclCo = v => v != null && exclCo.has(Number(v).toFixed(2));
  // Exclusions filter on the raw stored price; plotted values are then converted to
  // $/kg for per-kg group members so the chart matches the table (kgR = 1 otherwise).
  const kgR = histKgRatios(item);
  const wwFullMap = new Map(wwRaw.filter(e => !isExclWW(e.price)).map(e => [e.date, e.price * kgR.ww]));
  const coMap     = new Map(coRaw.filter(e => !isExclCo(e.price)).map(e => [e.date, e.price * kgR.coles]));

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

// For per-kg group members the history is a $/kg comparison, so each store's stored
// price (a pack price like Coles $10/200g) is shown converted to $/kg ($50). Returns
// per-store multipliers (raw price → $/kg) using the current pack ratio, mirroring
// groupTrendCellHTML. {perKg:false, ww:1, coles:1} for normal items (no conversion).
function histKgRatios(item) {
  // buildGroupHistoryItem() already stores the group's metric (($/kg, or raw
  // price for a sticker group) - no further conversion; only the "(...)"
  // label differs.
  if (item._isGroupHistory) return { perKg: !item._sticker, ww: 1, coles: 1, groupLabel: null };
  const group = loadVariantGroups().find(g => (g.items || []).includes(item.list_item));
  if (!group) return { perKg: false, ww: 1, coles: 1, groupLabel: null };
  // Sticker groups compare raw pack prices - no $/kg conversion in the history.
  if (group.sticker) return { perKg: false, ww: 1, coles: 1, groupLabel: group.label };
  const wwR = perKgRatio(item.woolworths);
  const coR = perKgRatio(item.coles);
  // Mixed bases are worse than none: "$8.50/kg" beside a per-unit price reads
  // as comparable when it isn't (Truss Tomatoes: WW per kg, Coles per each).
  // Only show $/kg when EVERY priced store converts; otherwise raw prices.
  const wwOk = item.woolworths?.price == null || wwR != null;
  const coOk = item.coles?.price == null || coR != null;
  if (!wwOk || !coOk) return { perKg: false, ww: 1, coles: 1, groupLabel: group.label };
  return { perKg: true, ww: wwR ?? 1, coles: coR ?? 1, groupLabel: group.label };
}

// Shared by every "History"/"Manage" button click handler (desktop table, desktop
// card view, mobile cards) so a __group_ key always resolves to the group's merged
// history the same way regardless of which view it was clicked from.
function openHistoryFromManageBtn(itemName) {
  if (!_lastData || !itemName) return;
  if (itemName.startsWith('__group_')) {
    const byName = new Map(_lastData.items.map(i => [i.list_item, i]));
    const group = buildVariantGroups(byName).find(g => g._groupKey === itemName.replace('__group_', ''));
    if (group) openPriceHistoryModal(buildGroupHistoryItem(group));
    return;
  }
  const item = _lastData.items.find(i => i.list_item === itemName);
  if (item) openPriceHistoryModal(item);
}

function openPriceHistoryModal(item) {
  _historyItem = item;
  const kgR = histKgRatios(item);
  // Group members show a "GroupLabel - Product name" title so it's clear this is one
  // variant's history within the per-kg comparison, not the whole group's - a group can
  // mix WW-only and Coles-only products (e.g. "Lamb Mince"), so a single member's history
  // can legitimately show nothing for the store the group's headline price came from.
  const titleName = kgR.groupLabel ? `${kgR.groupLabel} - ${stripWW(item.list_item)}` : stripWW(item.list_item);
  $('priceHistoryTitle').textContent = `Price History - ${titleName}${kgR.perKg ? ' ($/kg)' : ''}`;

  // Simplified view: no per-row exclude/"different item" editing, no Save/Reset -
  // just the read-only chart + list. Always on for a group's merged history (points
  // come from whichever member was cheapest that day, so there's no single item's
  // exclusion list to edit); on mobile it's a deliberate simplification the narrow
  // screen doesn't have room for.
  const simplified = !!item._isGroupHistory || innerWidth <= 700;
  document.querySelectorAll('.price-history-edit-actions').forEach(el => el.style.display = simplified ? 'none' : '');
  const closeOnlyBtn = $('priceHistoryClose2');
  if (closeOnlyBtn) closeOnlyBtn.textContent = simplified ? 'Close' : 'Cancel';

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
    // one down) on the right - matches the requested "split into two directions" icon.
    const forkSvg = `<svg class="fork-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="10" y2="12"/><line x1="10" y1="12" x2="21" y2="4"/><line x1="10" y1="12" x2="21" y2="20"/><polyline points="19,8 21,4 17,5"/><polyline points="19,16 21,20 17,19"/></svg>`;

    // Display in $/kg for per-kg members (kgR.ww/coles); data-price stays the raw
    // stored price so exclusions and the "different item" fork keep matching the data.
    // Group history rows get their OWN exclude button: each point knows which
    // member product it came from (_wwMeta/_coMeta), so ✕ writes that member's
    // raw pack price into pw_exclusions_v1 immediately - this is how a wrong
    // "$9.02 beef mince" point gets removed from a category's history.
    const grpBtn = (store) => {
      const meta = (store === 'ww' ? item._wwMeta : item._coMeta)?.get(entry.date);
      if (!meta) return '';
      return `<button class="price-excl-x grp-excl" data-store="${store}" data-src="${escAttr(meta.src)}" data-raw="${meta.raw.toFixed(2)}" title="Exclude - this point came from ${escAttr(stripWW(meta.src))}">✕</button>`;
    };
    const wwEditBtns = item._isGroupHistory ? (innerWidth > 700 ? grpBtn('ww') : '') : simplified ? '' : `
           <button class="price-excl-x" data-store="ww" data-price="${Number(entry.ww).toFixed(2)}" title="${wwExcluded ? 'Re-include' : 'Exclude'}">✕</button>
           <button class="price-fork-btn" data-store="ww" data-price="${Number(entry.ww).toFixed(2)}" title="Different item">${forkSvg}</button>`;
    const coEditBtns = item._isGroupHistory ? (innerWidth > 700 ? grpBtn('coles') : '') : simplified ? '' : `
           <button class="price-excl-x" data-store="coles" data-price="${Number(entry.coles).toFixed(2)}" title="${coExcluded ? 'Re-include' : 'Exclude'}">✕</button>
           <button class="price-fork-btn" data-store="coles" data-price="${Number(entry.coles).toFixed(2)}" title="Different item">${forkSvg}</button>`;
    const wwHtml = entry.ww != null
      ? `<span class="price-history-store-cell price-history-store-ww">
           <span class="price-history-price">${fmt(entry.ww * kgR.ww)}</span>${wwEditBtns}
         </span>`
      : `<span style="color:var(--text-soft)">-</span>`;

    const coHtml = entry.coles != null
      ? `<span class="price-history-store-cell price-history-store-coles">
           <span class="price-history-price" style="color:var(--coles)">${fmt(entry.coles * kgR.coles)}</span>${coEditBtns}
         </span>`
      : `<span style="color:var(--text-soft)">-</span>`;

    row.innerHTML = `
      <span class="price-history-date${idx === 0 ? ' ph-latest-date' : ''}">${entry.date || 'Unknown date'}</span>
      ${wwHtml}
      ${coHtml}`;

    // Group-history exclusion: applied IMMEDIATELY to the source member (no
    // Save step - a merged min-of-members series has no single pending list),
    // then the group history is rebuilt so the point disappears on the spot.
    row.querySelectorAll('.grp-excl').forEach(btn => {
      btn.addEventListener('click', () => {
        const excl = loadExclusions();
        const key = `${btn.dataset.store}:${btn.dataset.raw}`;
        const arr = excl[btn.dataset.src] || [];
        if (!arr.includes(key)) arr.push(key);
        excl[btn.dataset.src] = arr;
        saveExclusions(excl);
        showToast(`Excluded $${btn.dataset.raw} (${stripWW(btn.dataset.src)})`);
        if (_lastData) renderPage(_lastData);
        openHistoryFromManageBtn(`__group_${item._groupKey}`);
      });
    });

    row.querySelectorAll('.price-excl-x:not(.grp-excl)').forEach(btn => {
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

function showSyncError(thing, err, onRetry) {
  console.error(`[PriceWatch] Failed to sync ${thing} to GitHub:`, err);
  const toast = $('toastNotif');
  if (!toast) return;
  clearTimeout(toast._timer);
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = `⚠ Couldn't sync ${thing} to the cloud - saved locally, NOT synced.`;
  toast.appendChild(span);
  if (onRetry) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo-btn';
    btn.textContent = 'Retry';
    const hide = () => { toast.style.opacity = '0'; setTimeout(() => { toast.style.display = 'none'; toast.innerHTML = ''; }, 300); };
    btn.addEventListener('click', () => { clearTimeout(toast._timer); hide(); try { onRetry(); } catch {} });
    toast.appendChild(btn);
  }
  toast.style.display = 'block';
  toast.style.opacity = '1';
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; toast.innerHTML = ''; }, 300);
  }, 12000);
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
  // Store context - mutation deferred until Confirm is clicked.
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

  // Now that user confirmed - remove the misidentified price from history
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
      showToast('⚠ Could not save changes - check your GitHub token');
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
    showToast(`✓ "${newName}" saved locally - configure GitHub settings to scrape prices`);
    return;
  }
  const { anyOnline } = await getRunnerStatus(s);
  if (!anyOnline) {
    showRunnerOfflineBanner();
    showToast(`✓ "${newName}" added - update prices when runner is back online`);
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
    showToast(`✓ "${newName}" added - scraping prices now…`);
    pollItemRefresh(s, null, newName);
  } else {
    showToast(`✓ "${newName}" added - trigger a scrape manually when ready`);
  }
}

// Search matching: token-AND. Every whitespace-separated term must appear somewhere
// in the name, so word order and multi-term queries work ("milk full cream" matches
// "Woolworths Full Cream Milk"). Previously a single contiguous-substring test.
function searchTerms(q) { return (q || '').toLowerCase().split(/\s+/).filter(Boolean); }
function nameMatchesSearch(name, terms) {
  const n = (name || '').toLowerCase();
  return terms.every(t => n.includes(t));
}

// Record searches that match NOTHING in the current list - the cheapest useful
// analytics: each one is a candidate to add to shopping_list.xlsx. Kept in
// localStorage (no backend); the Scrape Log page surfaces them. Debounced by the
// caller so mid-typing prefixes aren't logged.
function maybeLogNoResults(q) {
  q = (q || '').trim();
  if (q.length < 3 || !_lastData?.items) return;
  const terms = searchTerms(q);
  const ovr = loadOverrides();
  const anyMatch = _lastData.items.some(i =>
    !i.archived && nameMatchesSearch(ovr[i.list_item]?.displayName || i.list_item, terms));
  if (anyMatch) return;
  try {
    const key = 'pw_search_misses_v1';
    const log = JSON.parse(localStorage.getItem(key) || '{}');
    const nq = q.toLowerCase();
    const e = log[nq] || { count: 0 };
    e.count += 1;
    e.last = new Date().toISOString().slice(0, 10);
    e.sample = q;
    log[nq] = e;
    localStorage.setItem(key, JSON.stringify(log));
  } catch {}
}

let _searchLogTimer = null;
function initSearch() {
  const input = $('searchInput');
  const clear = $('searchClear');
  const wrap  = $('searchWrap');
  if (!input) return;
  input.addEventListener('input', () => {
    _searchQuery = input.value.trim();
    if (clear) clear.style.display = _searchQuery ? 'block' : 'none';
    if (_lastData) renderPage(_lastData);
    clearTimeout(_searchLogTimer);
    _searchLogTimer = setTimeout(() => maybeLogNoResults(_searchQuery), 1000);
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
    if (btn.id === 'watchlistPill') return; // has its own toggle handler below
    btn.addEventListener('click', () => {
      const p = btn.dataset.priority;
      if (p) {
        _activePriority = p;
        container.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Keep the mobile frequency dropdown in sync with the active frequency.
        const fs = $('freqSelect');
        if (fs && ['all', 'weekly', 'monthly', 'rare', 'archive'].includes(_activePriority)) fs.value = _activePriority;
        // Search is intentionally preserved across priority/category tab switches
      }
      if (_lastData) renderPage(_lastData);
    });
  });

  // Mobile frequency dropdown - drives the same logic by clicking the hidden pill.
  const freqSelect = $('freqSelect');
  if (freqSelect) {
    freqSelect.value = ['all', 'weekly', 'monthly', 'rare', 'archive'].includes(_activePriority) ? _activePriority : 'weekly';
    freqSelect.addEventListener('change', () => {
      container.querySelector(`.priority-pill[data-priority="${freqSelect.value}"]`)?.click();
    });
  }

  // Watchlist filter - a pill in the filter row (it IS a filter); the mobile
  // sort-toolbar eye chip clicks this same pill. Toggles on/off; turning it
  // off lands back on "All".
  function toggleWatchlistFilter() {
    const on = _activePriority !== 'watchlist';
    _activePriority = on ? 'watchlist' : 'all';
    container.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
    if (on) $('watchlistPill')?.classList.add('active');
    else container.querySelector('[data-priority="all"]')?.classList.add('active');
    if (_lastData) renderPage(_lastData);
  }

  $('watchlistPill')?.addEventListener('click', toggleWatchlistFilter);

  // Other pages link here as index.html#watchlist - activate the watchlist
  // filter on arrival, then drop the hash so a plain refresh doesn't
  // re-trigger it.
  if (location.hash === '#watchlist') {
    if (_activePriority !== 'watchlist') toggleWatchlistFilter();
    history.replaceState(null, '', location.pathname + location.search);
  }

}

// ── Basket cart badge ─────────────────────────────────────────────────────────

function _updateSelectedPill() {
  // Floating "🛒 (n)" cart badge - visible whenever the basket has items
  const fab = $('basketFab');
  if (fab) {
    const fc = $('basketFabCount');
    if (fc) fc.textContent = _selectedItems.size;
    fab.classList.toggle('show', _selectedItems.size > 0);
    document.getElementById('mobileCards')?.classList.toggle('fab-visible', _selectedItems.size > 0);
  }
}

// Toggle one real product (not the synthetic group key - those aren't in
// _lastData.items, so the basket export would silently drop them) in the basket
// selection. Every matching element gets patched directly (no full re-render - that
// would jump mobile's scroll position back to the top) so tapping again to remove
// has the same immediate visual feedback as tapping to add.
// No toast: the floating "+ Basket (n)" button already shows the updated count,
// and the toast - full-width on mobile - sat right on top of it at almost the same
// bottom offset, hiding the icon it was supposed to confirm.
function addPerKgToBasket(name) {
  if (!name) return;
  if (_selectedItems.has(name)) _selectedItems.delete(name);
  else _selectedItems.add(name);
  persistBasketStore(); // ＋/✓ writes the basket directly - no separate "save" step
  const selected = _selectedItems.has(name);
  // The same product can be the tap-target of the group card (data-cheapest) AND
  // its own "＋" row inside the expanded member list - keep both in sync.
  document.querySelectorAll(`[data-item="${CSS.escape(name)}"].vg-pv-basket`)
    .forEach(el => {
      el.classList.toggle('selected', selected);
      el.title = selected ? 'Remove from basket' : 'Add to basket';
      el.setAttribute('aria-label', el.title);
      el.textContent = selected ? '✓' : '＋';
    });
  document.querySelectorAll(`.vg-mobile-card[data-cheapest="${CSS.escape(name)}"]`)
    .forEach(c => {
      c.classList.toggle('mc-selected', selected);
      c.setAttribute('aria-pressed', String(selected));
    });
  // Group CATEGORY entries (__group_*) highlight their group card by key.
  if (name.startsWith('__group_')) {
    document.querySelectorAll(`.vg-mobile-card[data-group="${CSS.escape(name.slice(8))}"]`)
      .forEach(c => {
        c.classList.toggle('mc-selected', selected);
        c.setAttribute('aria-pressed', String(selected));
      });
  }
  _updateSelectedPill();
}


// ── Archive sync (module-level so initBulkBar callbacks can reach it) ─────────

let _archiveSyncTimer = null;
async function syncArchivedToGitHub() {
  const s = loadSettings();
  if (!s.token) return;
  if (_archivedSaving) return;
  const pr = loadPriorities();
  const archivedNames = Object.keys(pr).filter(k => pr[k] === 'archive' && !REMOVED_ITEMS.has(k));
  _archivedSaving = true;
  try {
    await persistArchivedToRepo(s, archivedNames);
  } catch (err) { showSyncError('archived items list', err); }
  finally { _archivedSaving = false; }
}
function scheduleArchiveSync() {
  clearTimeout(_archiveSyncTimer);
  _archiveSyncTimer = setTimeout(syncArchivedToGitHub, 2000);
}

// Keeps the LOADED item's `archived` boolean in sync with the priority choice.
// That flag is baked into latest.json by the scraper (from archived_items.json
// as of the last run) - separate from the browser-local priority - so changing
// only the priority left the row stuck showing exclusively in the Archive view
// until the next full scrape happened to overwrite it. Without this, "unarchive"
// looked completely broken: the item just vanished into limbo, visible nowhere
// you'd think to look.
function syncItemArchivedFlag(itemName, archived) {
  const item = _lastData?.items?.find(i => i.list_item === itemName);
  if (item) item.archived = archived;
}

function unarchiveItem(itemName) {
  const pr = loadPriorities();
  if (pr[itemName] === 'archive') {
    pr[itemName] = 'monthly'; // restore to monthly (safest default)
  } else {
    delete pr[itemName];
  }
  savePriorities(pr);
  syncItemArchivedFlag(itemName, false);
  scheduleArchiveSync(); // debounced write to archived_items.json
  if (_lastData) renderPage(_lastData);
}

// ── Bulk action bar ───────────────────────────────────────────────────────────

function initBulkBar() {
  const bar = $('bulkToolbar');
  if (!bar) return;

  // Helper: floating chip dropdown anchored above its button
  function openChipDropdown(btn, items, onSelect, current) {
    document.querySelectorAll('.bt-dropdown').forEach(d => d.remove());
    const cur = new Set(current || []); // value(s) the current selection already has
    const drop = document.createElement('div');
    drop.className = 'bt-dropdown';
    items.forEach(({ label, value }) => {
      const el = document.createElement('button');
      el.className = 'bt-dropdown-item' + (cur.has(value) ? ' is-current' : '');
      // ✓ marks the option(s) the selected rows already sit in (all of them, on
      // a mixed selection) so you can see current state before changing it.
      el.textContent = (cur.has(value) ? '✓ ' : '') + label;
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
    }, e.currentTarget._current);
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
    }, e.currentTarget._current);
  });

  // Units stepper: sets how many units of each checked item to add. Min 0;
  // at 0 the button becomes ✕ Remove.
  bar.querySelector('.bt-qty-dec')?.addEventListener('click', () => { if (_bulkQty > 0) { _bulkQty--; reflectBulkQty(); } });
  bar.querySelector('.bt-qty-inc')?.addEventListener('click', () => { _bulkQty++; reflectBulkQty(); });

  // ＋ Basket adds _bulkQty units of each checked row to the persistent basket
  // (accumulating onto any units already there); at _bulkQty 0 it removes them.
  bar.querySelector('.bt-sl')?.addEventListener('click', () => {
    if (_bulkQty === 0) {
      const rm = checkedRealNames(true);
      const before = _selectedItems.size;
      const q = basketQtyMap();
      rm.forEach(n => { _selectedItems.delete(n); delete q[n]; });
      writeBasket(q);
      _updateSelectedPill();
      const removed = before - _selectedItems.size;
      showToast(removed ? `✕ ${removed} removed - ${_selectedItems.size} in basket`
                        : 'None of the selected items were in the basket');
      if (_lastData) renderPage(_lastData);
      return;
    }
    const add = checkedRealNames(false);
    if (!add.length) return;
    const before = _selectedItems.size;
    const q = basketQtyMap();
    add.forEach(n => {
      _selectedItems.add(n);
      // Carry the row's OWN Qty into the basket. It used to add _bulkQty flat, so
      // a row showing Qty 4 (Truss Tomatoes) landed in the basket as 1 and the two
      // pages disagreed by that difference. The stepper is now a multiplier on top.
      // Per-kg rows are excluded: their Qty is in KILOGRAMS while basket qty counts
      // PACKS, so 1.5kg must not become "2 packs" - the basket's own pack-matching
      // (packsOf) already scales those to a comparable weight.
      const rowQty = isKgQty(n) ? 1 : Math.max(1, Math.round(getUnits(n)));
      q[n] = (Number(q[n]) || 0) + rowQty * _bulkQty;
    });
    writeBasket(q);
    _updateSelectedPill();
    const added = _selectedItems.size - before;
    showToast(`🛒 ${_bulkQty === 1 ? '' : _bulkQty + ' units of '}${added || add.length} item${(added || add.length) !== 1 ? 's' : ''} added - ${_selectedItems.size} in basket`);
    if (_lastData) renderPage(_lastData); // sync ✓ marks on panel rows / cards
  });

  // Permanent delete. checkedRealNames(true) expands a per-kg group to its member
  // products, so deleting a group row removes the real products behind it rather
  // than leaving orphans the scraper would keep fetching.
  bar.querySelector('.bt-delete')?.addEventListener('click', () => {
    deleteItemsForever(checkedRealNames(true).filter(n => !String(n).startsWith('__group_')));
  });

  bar.querySelector('.bt-archive')?.addEventListener('click', () => {
    const pr = loadPriorities();
    const unarchiving = _activePriority === 'archive';
    _checkedItems.forEach(name => {
      if (unarchiving) {
        // Mirror unarchiveItem(): explicit 'archive' → restore to monthly;
        // otherwise the item was only archived via the item.archived flag, so
        // clearing the flag (below) is enough. Also clear the baked-in flag so
        // the row leaves the Archived view immediately (no scrape needed).
        if (pr[name] === 'archive') pr[name] = 'monthly'; else delete pr[name];
        syncItemArchivedFlag(name, false);
      } else {
        pr[name] = 'archive';
        syncItemArchivedFlag(name, true);
      }
    });
    savePriorities(pr);
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
    scheduleArchiveSync();
  });
}

// ── Multi-buy + quantity aware money (main page) ─────────────────────────────
// The whole main page used sticker price × qty, so a "2 for $4" never changed
// which store wins, the Total, or the Savings - only a little badge hinted at
// it (avocado ×2 showed Best = WW, Total $4.40, when Coles' 2-for-$4 is $4.00).
// Every money figure - summary, Best, Savings, Total, sorting - now routes
// through these, using the SAME per-store line cost the basket page uses, so the
// numbers can't disagree with each other. units = the QTY column; a store's
// promo lives in res.multi_buy {qty,total}. multiBuyCost is in utils.js.
function mbLineCost(res, units) {
  if (res?.price == null) return null;
  return multiBuyCost(units, res.price, res.multi_buy);
}
// Which store is cheaper for this item at its CURRENT qty. Falls back to the
// scraper's sticker-based call when a store is missing (no contest to re-decide).
// For items without a promo this equals cheaper_store (units cancel), so only
// multi-buy rows at/over the deal quantity actually change.
function mbCheaperStore(item) {
  const u = getUnits(item.list_item);
  const w = mbLineCost(item.woolworths, u), c = mbLineCost(item.coles, u);
  if (w == null || c == null) return item.cheaper_store;
  if (w < c - 0.005) return 'woolworths';
  if (c < w - 0.005) return 'coles';
  return 'equal';
}
// Effective per-unit price at the current qty (line cost ÷ units) - the number
// the price column shows once a deal is live, and what the DIFF % must compare
// (else avocado ×2 stays "12%" off sticker while the real gap is 9% the other way).
function mbEffUnit(res, units) {
  const lc = mbLineCost(res, units);
  return (lc == null || !(units > 0)) ? null : lc / units;
}
// qty-weighted saving at the current qty; null when the two stores aren't comparable.
function mbSaving(item) {
  const u = getUnits(item.list_item);
  const w = mbLineCost(item.woolworths, u), c = mbLineCost(item.coles, u);
  return (w == null || c == null) ? null : Math.abs(w - c);
}
// The cheapest line cost across both stores at the current qty, plus which store
// it is. Used by the basket/split math - NOT by the Total columns, which are
// per-store (see rowStoreTotal).
function mbBestTotal(item) {
  const u = getUnits(item.list_item);
  const w = rowStoreTotal(item, 'ww'), c = rowStoreTotal(item, 'coles');
  if (w == null && c == null) return { total: null, store: null };
  if (w == null) return { total: c, store: 'coles' };
  if (c == null) return { total: w, store: 'woolworths' };
  return w <= c ? { total: w, store: 'woolworths' } : { total: c, store: 'coles' };
}

// What this row costs AT ONE STORE for the current qty - the number the "W Total"
// / "C Total" columns show. Multi-buy aware; per-kg groups bill $/kg x weight.
// These are two INDEPENDENT columns (each store's own basket cost), which is the
// whole point of having both - don't collapse them into a single best-of column.
function rowStoreTotal(item, store) {
  const u = getUnits(item.list_item);
  if (item._isGroup) {
    const v = store === 'ww' ? item._wwPerKg : item._coPerKg;
    return v == null ? null : v * u;
  }
  return mbLineCost(store === 'ww' ? item.woolworths : item.coles, u);
}

// ── Banner stats (priority-aware) ────────────────────────────────────────────

// The price this row SHOWS in a store's column: per-kg groups show $/kg, normal
// items show their effective per-unit price (multi-buy applied). NOT multiplied
// by qty - the column footers sum the numbers actually on screen, and the Qty
// column's effect already lives in the Total column.
function shownStorePrice(item, store) {
  if (item._isGroup) return store === 'ww' ? item._wwPerKg : item._coPerKg;
  const res = store === 'ww' ? item.woolworths : item.coles;
  return mbEffUnit(res, getUnits(item.list_item));
}

function computeBannerStats(items) {
  const exclusions = loadExclusions();
  // Per-kg member products render collapsed into a single group row, so the
  // members themselves must not be counted. They used to be dropped and NOTHING
  // put back, so every per-kg group was silently missing from the totals - a
  // search showing 4 rows summed only 2 of them, the WW/Coles cards disagreed
  // with the Total column, and a real Split saving vanished because the groups
  // (which the other store often wins) were invisible to the split math.
  // Collapse them into the same synthetic group rows the table renders instead.
  const perkgMembers = new Set(loadVariantGroups().flatMap(g => g.items));
  let pool = items;
  if (_activePriority !== 'archive') {   // archive view renders raw members, so match it
    const groups = buildVariantGroups(new Map(items.map(i => [i.list_item, i])));
    if (groups.length) pool = items.filter(i => !perkgMembers.has(i.list_item)).concat(groups);
  }
  const baseFiltered = pool.filter(item => {
    if (perkgMembers.has(item.list_item)) return false;
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
    // Only items priced at BOTH stores can be compared. Group rows carry their
    // price as _wwPerKg/_coPerKg, not woolworths.price, so ask shownStorePrice.
    if (shownStorePrice(item, 'ww') == null || shownStorePrice(item, 'coles') == null) return false;
    return true;
  });
  // Narrow by the SAME search + column filters the visible table applies, so the
  // cards/footer reflect only what's on screen (a search for "avo" summarises the
  // avocado alone, not the whole weekly basket).
  const filtered = applyValueFilters(baseFiltered);
  const ww_avail = filtered.some(i => shownStorePrice(i, 'ww') != null);
  // TWO different bases, deliberately, because two different things are being
  // asked on this page:
  //   • store TOTALS (top cards, and the W/C Total columns) = what the basket
  //     actually costs at that store - qty-weighted, multi-buy applied.
  //   • the WW/Coles PRICE column footers = the sum of that column's own numbers,
  //     which are per-unit prices. A column footer sums its column.
  const ww_total = filtered.reduce((s, i) => s + (rowStoreTotal(i, 'ww') ?? 0), 0);
  const co_total = filtered.reduce((s, i) => s + (rowStoreTotal(i, 'coles') ?? 0), 0);
  const col_ww = filtered.reduce((s, i) => s + (shownStorePrice(i, 'ww') ?? 0), 0);
  const col_coles = filtered.reduce((s, i) => s + (shownStorePrice(i, 'coles') ?? 0), 0);
  const total_saving = Math.abs(ww_total - co_total);
  // "Max saving": buy each item at whichever store is cheapest, vs doing the
  // whole shop at the more expensive single store. Same qty-weighted basis as the
  // store totals, so cherry_total IS the Total-column best-of-each figure.
  const cherry_total = filtered.reduce((s, i) =>
    s + Math.min(rowStoreTotal(i, 'ww'), rowStoreTotal(i, 'coles')), 0);
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
    split_total: Math.round(cherry_total * 100) / 100, // the split trip's own price
    // Price-column footers only: the sum of the per-unit numbers those columns
    // display. NOT a basket cost - see the two-bases note above.
    col_ww: Math.round(col_ww * 100) / 100,
    col_coles: Math.round(col_coles * 100) / 100,
    items_compared: filtered.length,
  };
}

// Renders the two saving figures shown between the store cards:
//   • Basket saving - the gap between the two whole-basket totals (matches the cards).
//   • Max saving - buy each item at its cheaper store vs the dearer single store.
//     Only shown when splitting the shop beats just visiting the cheaper store.
// A small circled "?" that reveals its explanation on hover OR tap/focus
// (tabindex makes :focus-visible tooltips work on touch). CSS: .info-ico.
function infoIcoHTML(tip) {
  return `<span class="info-ico" tabindex="0" role="note" aria-label="${escAttr(tip)}" data-tip="${escAttr(tip)}">?</span>`;
}

function renderSavingInfo(s) {
  // Basket saving carries the cheaper store's logo; max saving carries a split
  // W│C disc to signal "buy across both stores".
  const cheaperChip = s.cheaper_store === 'coles'
    ? '<span class="store-chip coles sm">C</span>'
    : '<span class="store-chip ww sm">W</span>';
  const splitIcon = `<svg class="split-icon" width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 A14 14 0 0 0 16 30 Z" fill="var(--ww)"/><path d="M16 2 A14 14 0 0 1 16 30 Z" fill="var(--coles)"/><line x1="16" y1="2" x2="16" y2="30" stroke="var(--card)" stroke-width="2.5"/></svg>`;
  // Two rows, one shared layout so they read as a set. Each row's figures sit
  // in a right-aligned `.saving-figs` block: an optional bold-green total, then
  // the saving as a green (−$X) bracket. The brackets line up in a column
  // across both rows; the split row adds its trip total to their left.
  //   • Basket saving = bracket only. Its total is the cheaper store card right
  //     beside this panel, so repeating it here would just duplicate that.
  //   • Split saving = trip total + bracket. This panel is the ONLY place the
  //     split trip price appears, so it leads with that bold number.
  const line = (icon, label, tip, figs) =>
    `<div class="saving-line"><span class="saving-icon">${icon}</span><div class="saving-text"><div class="saving-label">${label}${infoIcoHTML(tip)}</div><div class="saving-figs">${figs}</div></div></div>`;
  const disc = v => `<span class="sv-disc">(−${fmt(v)})</span>`;

  const basket = line(cheaperChip, 'Basket saving',
    'Buy everything at the cheaper store instead of the dearer one - this is what you save', disc(s.total_saving));
  let maxRow = '';
  if (s.max_saving > s.total_saving + 0.005) {
    maxRow = line(splitIcon, 'Split saving',
      'Buying each item at whichever store is cheapest for it costs this total - the bracket is the extra you save vs shopping at one store only',
      `<span class="sv-total">${fmt(s.split_total)}</span>${disc(s.max_saving)}`);
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
    // The wrap must NEVER scroll vertically (the page scrolls; the ghost pins
    // the header). Browsers still nudge it internally sometimes (focus jumps,
    // find-in-page, scrollIntoView) - the real thead is sticky INSIDE the wrap,
    // so any internal scroll opened a gap band above it with rows showing
    // through (the "row above the header" artifact). Clamp it back.
    if (e.target.scrollTop !== 0) e.target.scrollTop = 0;
    if (_stickyGhostTable) {
      _stickyGhostTable.style.marginLeft = `-${e.target.scrollLeft}px`;
      pinGhostFrozenCols();
    }
  }, { passive: true });
}

// The ghost header is shifted with marginLeft to mirror horizontal scroll, so native
// position:sticky can't pin its first columns. The cells' offsetLeft (relative to the
// fixed ghost container) already reflects that shift, so to freeze the checkbox + Product
// at a fixed cumulative offset (0, then checkbox width) we just translate each by
// (intended - offsetLeft). This stays aligned with the body's sticky columns regardless
// of scroll position or any internal width quirk in the cloned ghost table.
function pinGhostFrozenCols() {
  if (!_stickyGhostTable) return;
  let intended = 0;
  _stickyGhostTable.querySelectorAll('th.check-cell, th[data-col="name"]').forEach(c => {
    c.style.position = 'relative';
    c.style.zIndex = '2';
    c.style.background = 'var(--bg)';
    c.style.transform = `translateX(${intended - c.offsetLeft}px)`;
    intended += c.getBoundingClientRect().width;
  });
}

function syncStickyNow() {
  if (!_stickyGhost || !_stickyGhostTable) return;

  const realThead = document.querySelector('#tableHead');
  const tableWrap = document.querySelector('.table-wrap');
  if (!realThead || !tableWrap) return;

  // Clone thead, removing resize handles from ghost (they'd interfere)
  while (_stickyGhostTable.firstChild) _stickyGhostTable.removeChild(_stickyGhostTable.firstChild);
  const cloned = realThead.cloneNode(true);
  // Strip ids from the clone - cloneNode copies id="tableHead", and a duplicate id makes
  // later $('tableHead') / querySelector('#tableHead') ambiguous (can return the ghost).
  cloned.removeAttribute('id');
  cloned.querySelectorAll('[id]').forEach(e => e.removeAttribute('id'));
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
  pinGhostFrozenCols();

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
  thead.innerHTML = `<tr><th class="check-cell"><input type="checkbox" id="checkAll" title="Select all visible"></th>${visibleCols.map(colHeadHtml).join('')}<th class="actions-th">Actions</th></tr>`;

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

  // The header was just rebuilt. If the sticky ghost is showing (page scrolled down),
  // re-sync it now so it never displays a stale/blank header until the next scroll -
  // the "headline freezes / shows nothing until I expand a row" symptom.
  if (_stickyGhost && _stickyGhost.style.display !== 'none') syncStickyNow();

  // Expose the visible table width so an expanded per-kg panel can size itself to the
  // viewport (sticky-left) instead of the full overflowing table - keeps Coles on screen.
  const _tw = thead.closest('.table-wrap');
  if (_tw) _tw.style.setProperty('--pw-panelw', _tw.clientWidth + 'px');
}

// ── Refresh / GitHub Actions trigger ─────────────────────────────────────────

let refreshCooldown = false;

async function triggerRefresh() {
  // Defence in depth: the button is not rendered for viewers, but this is the one
  // action that spends real compute on the self-hosted runner, so refuse outright
  // rather than relying on the UI having hidden it.
  if (isViewerMode()) return;
  const s = loadSettings();
  if (!s.token) {
    alert('Please add your GitHub token first (⚙ Auto-update Setup button).');
    return;
  }
  if (refreshCooldown) return;
  _progressSeenThisSession = false;
  _sawAnyProgress = false;   // new dispatch: "waiting for first progress" is valid again

  const btn = $('refreshBtn');
  setRefreshState('working');

  // Pre-flight: confirm the self-hosted runner is online before dispatching
  const { anyOnline } = await getRunnerStatus(s);
  if (!anyOnline) {
    showRunnerOfflineBanner();
    setRefreshState('idle');
    return;
  }
  hideRunnerOfflineBanner();


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
      // Persist the dispatch so the strip survives refreshes / other pages -
      // renderPage (and header.js's poller on non-index pages) shows a
      // "waiting" strip until scrape_progress appears or the run completes.
      try { localStorage.setItem('pw_scrape_dispatched_v1', new Date().toISOString()); } catch {}
      // Show progress strip immediately - don't wait for scraper to push data
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

      const dispatchedAt = new Date().toISOString();
      pollForCompletion(s, dispatchedAt);
      refreshCooldown = true;
      setTimeout(() => { refreshCooldown = false; }, 10 * 60 * 1000);
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`GitHub API error ${res.status}: ${err.message || 'Unknown error'}`);
      setRefreshState('error');
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
    setRefreshState('error');
  }
}

// ── Update-Prices button state ──────────────────────────────────────────────
// The button is ALWAYS the same icon-only square: same slot, same size, no text
// ever. It used to rewrite itself to "↻ Update Prices" / "✓ Triggered - polling…"
// / "⚠ Run failed", which resized it and pushed the header around mid-scrape.
// State is carried by colour + a tick, nothing else.
const SVG_REFRESH_ICO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const SVG_CHECK_ICO   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
// state: 'idle' | 'working' (dispatching or scrape running) | 'done' | 'error'
function setRefreshState(state) {
  const btn = $('refreshBtn');
  if (!btn) return;
  btn.classList.remove('is-working', 'is-done', 'is-error');
  if (state === 'working') {
    btn.classList.add('is-working');
    btn.disabled = true;
    btn.title = 'Updating prices…';
    btn.innerHTML = SVG_REFRESH_ICO;
  } else if (state === 'done') {
    btn.classList.add('is-done');
    btn.disabled = true;
    btn.title = 'Prices updated';
    btn.innerHTML = SVG_CHECK_ICO;
  } else if (state === 'error') {
    btn.classList.add('is-error');
    btn.disabled = false;
    btn.title = 'Update failed - click to retry';
    btn.innerHTML = SVG_REFRESH_ICO;
  } else {
    btn.disabled = false;
    btn.title = 'Update prices';
    btn.innerHTML = SVG_REFRESH_ICO;
  }
}

async function pollForCompletion(s, dispatchedAt) {
  const btn = $('refreshBtn');
  const apiBase = `https://api.github.com/repos/${s.user}/${s.repo}`;
  const apiHeaders = { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' };
  let dataPollTimer;

  // finish(true)  - run succeeded: clear timer, reload data
  // finish(false) - run explicitly failed (bad conclusion from GitHub API)
  const finish = (success) => {
    clearInterval(dataPollTimer);
    if (success) {
      setRefreshState('done');
      setTimeout(() => {
        fetch(`data/latest.json?t=${Date.now()}`)
          .then(r => r.json())
          .then(d => { renderPage(d); setRefreshState('idle'); })
          .catch(() => location.reload());
      }, 2000);
    } else {
      setRefreshState('error');
    }
  };

  // lostConnection() - poll timed out or network error, NOT an explicit failure.
  // Keep the progress bar visible at its last known %, show a recoverable message
  // with a Refresh button that restarts polling from Phase 1.
  const lostConnection = () => {
    // Do NOT clear dataPollTimer - the data poll keeps running in case the
    // scrape-progress branch catches up later.
    //
    // This is about the GitHub Actions API poll, NOT the scrape. If the data
    // poll is still watching the count climb, the run is demonstrably alive and
    // "Lost connection" is simply false - saying it anyway made the strip
    // alternate between the message and the live count on every tick
    // (150 -> lost -> 155 -> lost -> 160). Stay quiet and keep retrying; the
    // stall detector already covers a run that genuinely stops moving.
    const movingRecently = _progressLastChangeTime
      && (Date.now() - _progressLastChangeTime) < STALE_PROGRESS_MS;
    if (movingRecently) {
      findAttempts = 0;
      setTimeout(findRun, 15000);
      return;
    }
    const strip = $('scrapeStrip');
    if (strip && strip.style.display !== 'none') {
      $('scrapeStripLabel').innerHTML =
        '⚠ Lost connection - <a href="https://github.com/' +
        `${s.user}/${s.repo}/actions" target="_blank" rel="noopener" style="color:inherit">check GitHub Actions</a>`;
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = 'inline-block';
    }
    // Restart Phase 1 polling after a short delay so the user can recover
    // by waiting rather than having to click Refresh themselves.
    findAttempts = 0;
    setTimeout(findRun, 15000);
  };

  // Live data poll: re-renders the progress bar every 5 s while the scrape runs.
  // Skip renderPage until scrape_progress first appears - calling renderPage before
  // that would hide the manually-set "Waiting to start" strip (no scrape_progress
  // field in latest.json yet). Once seen, always call renderPage so completion
  // state renders correctly even when scrape_progress later disappears.
  dataPollTimer = setInterval(async () => {
    const fresh = await loadProgressData();
    if (!fresh) return;
    // Only accept scrape_progress from this run - stale data on the branch
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
const _pendingRefreshItems = new Set();
let _preScrapeData = null;          // snapshot of data when scrape started
let _progressLastDone = null;       // last seen done count
let _progressLastChangeTime = null; // timestamp of last progress change
let _progressDismissed = false;     // user dismissed the header progress widget (this session)
// "Dismiss forever": a finished (done>=total) or killed run can leave scrape_progress
// stuck in latest.json, and the in-memory flag above reset on every refresh - so ✕
// never stuck and the strip kept returning. Persist the run's started_at (its unique
// id) so ✕ buries THAT run for good across reloads/pages. Shared key with header.js.
const SCRAPE_DISMISS_KEY = 'pw_scrape_dismissed_v1';
function scrapeRunId(p) { return p && (p.started_at || (p.total != null ? 'legacy_' + p.total : '')) || ''; }
function isScrapeRunDismissed(p) {
  const id = scrapeRunId(p);
  if (!id) return false;
  try { return (JSON.parse(localStorage.getItem(SCRAPE_DISMISS_KEY) || '[]') || []).includes(id); }
  catch { return false; }
}
function markScrapeRunDismissed(p) {
  const id = scrapeRunId(p);
  if (!id) return;
  try {
    const arr = JSON.parse(localStorage.getItem(SCRAPE_DISMISS_KEY) || '[]') || [];
    if (!arr.includes(id)) { arr.push(id); localStorage.setItem(SCRAPE_DISMISS_KEY, JSON.stringify(arr.slice(-20))); }
  } catch {}
}
let _progressSeenThisSession = false; // true once scrape_progress first appeared this trigger
// True once ANY progress count has been observed for the current dispatch. Guards the
// "waiting for first progress" strip: after a count has appeared, that message is
// factually wrong, so a transient no-progress fetch must never bring it back.
let _sawAnyProgress = false;
let _lastProgress = null;           // last scrape_progress we saw (keeps the strip up across transient no-progress fetches)
let _scrapeActive = false;          // true between first progress and confirmed completion (3-strike)

const PRIORITY_ORDER = { weekly: 0, monthly: 1, rare: 2, archive: 3 };

// One-shot latch: the cheaper store's Total column is defaulted on at first
// render only, so it can't flicker as filters/search change (see _renderPageInner).
let _totalColDefaulted = false;

// The row-filter pipeline, shared by sortItems (skipCol=null) and the column
// filter dropdown (skipCol=that column), which must offer only values present
// in the rows every OTHER filter lets through - Excel semantics, instead of
// listing options that select nothing.
function applyFilters(items, skipCol = null) {
  let filtered = items.filter(item => {
    // Per-kg group visibility (⚙ /kg button): isolate the groups, or hide them entirely
    if (_perkgFilter === 'only') return !!item._isGroup;
    if (_perkgFilter === 'hidden' && item._isGroup) return false;
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
    // Hide items priced at neither store by default - they're noise in the main
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

  return applyValueFilters(filtered, skipCol);
}

// The column (checkbox + numeric) and search filters, split out of applyFilters
// so the banner/footer totals can run the EXACT same narrowing the visible rows
// do. Without this the cards summed the whole priority+category basket while the
// table showed only the searched rows - a search for "avo" left the summary on
// the full weekly total. One helper = the two can never drift again.
function applyValueFilters(list, skipCol = null) {
  let filtered = list;
  // Per-column value (checkbox) filters
  for (const [col, vals] of Object.entries(_colFilters)) {
    if (!vals?.size || col === skipCol) continue;
    filtered = filtered.filter(i => vals.has(getColValue(col, i)));
  }
  // Per-column numeric filters (AND'd with checkbox filters)
  for (const [col, nf] of Object.entries(_colNumFilters)) {
    if (!nf || col === skipCol) continue;
    filtered = filtered.filter(i => applyNumFilter(getColNumericValue(col, i), nf));
  }
  // Search query filter
  if (_searchQuery) {
    const terms = searchTerms(_searchQuery);
    const ovr = loadOverrides();
    filtered = filtered.filter(i =>
      nameMatchesSearch(ovr[i.list_item]?.displayName || i.list_item, terms));
  }
  return filtered;
}

function sortItems(items) {
  const exclusions = loadExclusions();
  const _sortOvr = loadOverrides(); // hoisted: name sort uses displayed names (renames included)
  const filtered = applyFilters(items);

  // Display name as the eye reads it (group label / rename / short name). Used
  // both by the name sort AND the tiebreaker below, so a per-kg group ties on
  // "Chicken Thigh", not its internal "__group_chicken_thigh" key.
  const dispSortName = item => item._isGroup ? item._groupLabel.toLowerCase()
    : (_sortOvr[item.list_item]?.displayName || (window.PW_NAME_MAP && PW_NAME_MAP[item.list_item]) || stripWW(item.list_item)).toLowerCase();

  function getSortVal(col, item) {
    // Price columns must sort by the number the cell DISPLAYS: per-kg groups show
    // $/kg, normal items show pack price. Missing values return NaN so the NaN
    // guard below sinks them to the bottom in BOTH directions (?? Infinity floated
    // priceless rows to the top on descending sorts).
    const wwShown = item._isGroup ? item._wwPerKg : item.woolworths?.price;
    const coShown = item._isGroup ? item._coPerKg : item.coles?.price;
    switch (col) {
      // Sort by what the row DISPLAYS (group label / rename / short name) so
      // A-Z order matches what the eye reads, groups interleaved with items.
      case 'name':     return dispSortName(item);
      case 'ww':       return wwShown ?? NaN;
      case 'coles':    return coShown ?? NaN;
      case 'cheaper':  return mbCheaperStore(item) ?? 'zzz';
      case 'saving':   return item._isGroup ? (savingAmount(item) ?? NaN) : (mbSaving(item) ?? NaN);
      case 'trips':    return item.trip_count || 0;
      // Kg rows sort as a contiguous block after pack-count rows (offset), so
      // "1.0kg" items sit together instead of interleaving with "1 unit" items.
      case 'units':    { const u = getUnits(item.list_item); return isKgQty(item.list_item) ? 1e6 + u : u; }
      case 'priority': return PRIORITY_ORDER[getPriority(item.list_item)] ?? 99;
      case 'pct': {
        if (item._isGroup) return (wwShown != null && coShown != null)
          ? Math.abs(wwShown - coShown) / Math.max(wwShown, coShown) : NaN;
        const u = getUnits(item.list_item);
        const w = mbEffUnit(item.woolworths, u), c = mbEffUnit(item.coles, u);
        return (w != null && c != null) ? Math.abs(w - c) / Math.max(w, c) : NaN;
      }
      case 'trend': return trendPositionOf(item); // 0.0=best deal, 1.0=expensive, 999=no history (sorts last)
      case 'category':     return getCategory(item).toLowerCase();
      case 'last_scraped': return item.last_scraped || '';
      // Each total column sorts by ITS OWN store's line cost (matches its cell).
      case 'ww_total':     return rowStoreTotal(item, 'ww') ?? NaN;
      case 'coles_total':  return rowStoreTotal(item, 'coles') ?? NaN;
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
    // Name tiebreaker: identical sort values fall back to the DISPLAYED name, not
    // the raw list_item. Groups key on "__group_…", whose leading underscore sorts
    // before every letter - so on a trend sort (where dozens of items legitimately
    // tie at all-time-low, position 0), all per-kg groups used to float to the very
    // top ahead of alphabetically-earlier items like Broccolini. Tiebreaking on the
    // visible name interleaves them the way name→trend already did.
    return dispSortName(a).localeCompare(dispSortName(b));
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
// Do not redefine them here - both pages must share the exact same implementation.

// ── Card view ─────────────────────────────────────────────────────────────────

function renderCards(items) {
  const grid = $('cardGrid');
  if (!grid) return;
  const overrides = loadOverrides();
  const exclusions = loadExclusions();
  const parts = [];

  items.forEach(item => {
    if (item._isGroup) { parts.push(groupCardHTML(item, overrides)); return; }
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;
    const ov = overrides[item.list_item] || {};
    const displayName = ov.displayName || shortName(item.list_item);
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

    // 'archive' is a real, selectable option here (not just a bulk action) - an
    // archived item's own dropdown must actually show "Archived" selected, not
    // silently default to "Weekly" with no way back short of a separate button.
    const prioOptions = ['weekly','monthly','rare','archive'].map(v =>
      `<option value="${v}"${p===v?' selected':''}>${v==='archive'?'Archived':v[0].toUpperCase()+v.slice(1)}</option>`
    ).join('');

    // Prices
    const { ww: wwP100, coles: coP100 } = per100Pair(ww, co);
    const hotBadge = hotDeal ? ' <span class="hot-badge" title="Hot Deal - meaningfully cheaper than its usual price right now">🔥</span>' : '';

    let wwHtml;
    if (ww) {
      const pv = wwUrl ? `<a href="${wwUrl}" target="_blank" rel="noopener" class="price-link">${fmt(ww.price)}</a>` : fmt(ww.price);
      const fire = hotDeal && cheaper === 'woolworths' ? hotBadge : '';
      const unit = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : (wwP100.blanked ? '' : fmtUnit(ww.unit_price, ww.unit));
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}${multiBuyBadge(ww)}</div>`;
    } else {
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span> <a href="https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}" target="_blank" rel="noopener" class="search-link">Find →</a></div>`;
    }

    let coHtml;
    if (co) {
      const pv = coUrl ? `<a href="${coUrl}" target="_blank" rel="noopener" class="price-link">${fmt(co.price)}</a>` : fmt(co.price);
      const fire = hotDeal && cheaper === 'coles' ? hotBadge : '';
      const unit = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : (coP100.blanked ? '' : fmtUnit(co.unit_price, co.unit));
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}${multiBuyBadge(co)}</div>`;
    } else {
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span> <a href="https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}" target="_blank" rel="noopener" class="search-link">Find →</a></div>`;
    }

    const wwClass   = cheaper === 'woolworths' ? 'winner-ww' : '';
    const coClass   = cheaper === 'coles'      ? 'winner-coles' : '';
    const units     = getUnits(item.list_item);
    const savingAmt = savingAmount(item) != null && savingAmount(item) > 0
      ? fmt(savingAmount(item) * units) : null;
    const savingHtml = savingAmt
      ? `<div class="card-saving">${cheaper==='woolworths'?'<span class="store-chip ww sm">W</span>':'<span class="store-chip coles sm">C</span>'} Save ${savingAmt}</div>`
      : '';

    const _trendSeries = getTrendSeries(item);
    const bar = buildPriceBar(item.list_item, _trendSeries.prices.map(p => ({price: p})), _trendSeries.current);
    const isChecked = _checkedItems.has(item.list_item);
    const notFound = !ww && !co;

    parts.push(`<div class="item-card${notFound ? ' card-not-found' : ''}" data-item="${safeKey}">
      <div class="card-top">
        <div class="card-img-wrap">${imgHtml}</div>
        <div class="card-info">
          <div class="card-name">${esc(displayName)}</div>
          <div class="card-cat">${esc(cat)}</div>
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
// they render inline in the main table looking like normal product rows - image,
// WW-vs-Coles columns, links - but with $/kg as the headline (pack size varies
// across stores, so only $/kg is comparable). Expanding lists every member
// product as its own row with $/kg at each store.

// Build synthetic group items from the per-kg member products present in the list.
function buildVariantGroups(byName) {
  const out = [];
  const excl = loadPerKgExclusions();
  for (const g of loadVariantGroups()) {
    // Members that aren't in latest.json yet (never scraped / scrape failed)
    // are kept as pending placeholders so they remain visible in the panel.
    const members = g.items.map(n => {
      const item = byName.get(n);
      if (!item) return { list_item: n, _pending: true, woolworths: null, coles: null, price_history: [] };
      return item.pending ? { ...item, _pending: true } : item;
    });
    if (!members.length) continue;

    // Woolworths and Coles are independent lists - a product contributes to a store
    // only if it's a member of that store's list. The cheapest in each list wins.
    const stores = resolveStoreLists(g, byName);
    const memberByName = new Map(members.map(m => [m.list_item, m]));
    // Comparison metric: pack price for sticker groups (Bolognese sauce), $/kg
    // otherwise. `perkg` keeps its name through the pipeline but holds whichever.
    const ww = stores.ww
      .filter(n => !excl.has(`${g.key}::${n}::ww`))
      .map(n => ({ name: n, result: memberByName.get(n)?.woolworths, perkg: groupMetric(g, memberByName.get(n)?.woolworths) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);
    const co = stores.coles
      .filter(n => !excl.has(`${g.key}::${n}::coles`))
      .map(n => ({ name: n, result: memberByName.get(n)?.coles, perkg: groupMetric(g, memberByName.get(n)?.coles) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);

    // Per-store member counts, deduped the same way the expanded panel is, so the group
    // sub-label ("N Woolworths · M Coles") matches the rows actually shown (no inflated
    // counts from product aliases or wrong cross-store matches).
    const ovr = loadOverrides();
    const wwCount = dedupePerKgVariants(ww.map(x => ({ name: x.name, res: x.result, pk: x.perkg })), 'ww', ovr, memberByName).length;
    const coCount = dedupePerKgVariants(co.map(x => ({ name: x.name, res: x.result, pk: x.perkg })), 'coles', ovr, memberByName).length;

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
      _sticker: !!g.sticker,
      _unitSuffix: g.sticker ? '' : '/kg',
      _members: members,
      _wwList: stores.ww,
      _coList: stores.coles,
      _wwCount: wwCount,
      _coCount: coCount,
      _wwBest: wwBest,
      _coBest: coBest,
      _wwPerKg: wwBest ? wwBest.perkg : null,
      _coPerKg: coBest ? coBest.perkg : null,
      // Shape like a normal item so sort/helpers work; price = best variant's pack price.
      woolworths: wwBest ? wwBest.result : null,
      coles: coBest ? coBest.result : null,
      cheaper_store: cheaper,
      category: g.category || 'Meat & Seafood',
      trip_count: null,
      price_history: [],
    });
  }
  return out;
}

// Multi-buy special badge ("2 for $6.00") - captured from the store's own
// promo data (scraper.py: Coles pricing.multiBuyPromotion, minQuantity x reward),
// shown as a small secondary pill under the price. Deliberately display-only:
// the price shown everywhere in the app stays the real per-unit shelf price -
// this just surfaces that buying more hits a cheaper total, without silently
// changing any number the rest of the UI (savings, basket, trend) relies on.
function multiBuyBadge(res) {
  const mb = res?.multi_buy;
  if (!mb?.qty || mb.total == null) return '';
  return `<span class="multibuy-badge" title="Buy ${mb.qty} for $${mb.total.toFixed(2)} total - shown price is the per-unit shelf price"><svg class="mb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3.24 9.59A2 2 0 0 0 3.83 11l9.58 9.59a2 2 0 0 0 2.82 0l4.36-4.36a2 2 0 0 0 0-2.82Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>${mb.qty} for $${mb.total.toFixed(2)}</span>`;
}

const MB_TAG_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3.24 9.59A2 2 0 0 0 3.83 11l9.58 9.59a2 2 0 0 0 2.82 0l4.36-4.36a2 2 0 0 0 0-2.82Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`;
// Qty-aware multi-buy tag icon for the main table's price cell - rides on the
// PRICE line, not the unit line. GREEN once the deal is live at the current QTY
// (the price itself switches to the effective per-unit); a muted hint below the
// deal quantity. Icon only - the discounted number is shown by the price itself,
// so a "$X ea" label here would just be noise. Full terms on hover.
function multiBuyTag(res, units) {
  const mb = res?.multi_buy;
  if (!mb?.qty || mb.total == null || res.price == null) return '';
  if (units >= mb.qty) {
    const eff = multiBuyCost(units, res.price, mb) / units;
    return `<span class="mb-tag on" title="Multi-buy applied: ${mb.qty} for $${mb.total.toFixed(2)} - $${eff.toFixed(2)} each at ${units} (shelf $${res.price.toFixed(2)})">${MB_TAG_SVG}</span>`;
  }
  return `<span class="mb-tag off" title="Multi-buy: ${mb.qty} for $${mb.total.toFixed(2)} (you're buying ${units}) - buy ${mb.qty - (units % mb.qty)} more to unlock">${MB_TAG_SVG}</span>`;
}

// A $/kg price cell: just the $/kg headline (linked). No pack-price subline -
// that lives in the expanded panel, where pack size actually matters.
function perKgCellHTML(perkg, url, suffix = '/kg') {
  if (perkg == null) return '<span class="no-data">-</span>';
  const suf = suffix ? `<span class="perkg-suffix">${suffix}</span>` : '';
  const head = `$${perkg.toFixed(2)}${suf}`;
  const linked = url ? `<a href="${url}" target="_blank" rel="noopener" class="price-link">${head}</a>` : head;
  return `<div class="price-main">${linked}</div>`;
}

// Trend cell for a group. The bar is built from EVERY member's $/kg series
// (memberPerKgPrices - the same conversion the price column and history modal
// use), and the marker is the group's current best $/kg (best.perkg, the exact
// number shown in the price column). History, current price and trend therefore
// all share one source of truth and cannot diverge.
function groupTrendCellHTML(group) {
  const cands = [group._wwBest, group._coBest].filter(Boolean);
  if (!cands.length) return '';
  const best = cands.reduce((a, b) => (a.perkg <= b.perkg ? a : b));

  // Sticker groups: the bar is raw pack prices (the metric), so it matches the
  // sticker marker; $/kg groups convert via memberPerKgPrices.
  const prices = group._sticker
    ? group._members.flatMap(m => [...(m.price_history || []), ...(m.ww_price_history || []), ...(m.coles_price_history || [])]
        .map(e => e.price).filter(p => p > 0))
    : group._members.flatMap(m => memberPerKgPrices(m, ...memberStoreFlags(group, m)));
  if (prices.length < 2) return '';
  const hist = prices.map(p => ({ price: p }));
  // History button opens the group's own merged history (see buildGroupHistoryItem),
  // not one member's - a group can mix a WW-only and a Coles-only product, so
  // picking a single member's history hides whichever store that member doesn't sell at.
  return buildPriceBar(`__group_${group._groupKey}`, hist, best.perkg);
}

// Synthesizes a "price history" item for a per-kg group: for each store, at every
// date ANY member's price changed, take the CHEAPEST $/kg across ALL members -
// each member FORWARD-FILLED to its most recent known price as of that date, not
// just members with an explicit entry that day. Members are scraped on independent
// schedules (a fresh full run doesn't necessarily touch every member, and a
// member's own history only gets a new row when its price changes or 7+ days have
// passed - see scraper.py's ww_add/co_add), so a plain per-date union of raw
// entries let a pricier member "win" a date simply because it was the only one
// re-scraped that day, while the true cheapest member's last-known (unchanged)
// price was silently ignored. Forward-filling means every date's minimum reflects
// what the cheapest member ACTUALLY cost then, matching the live headline number
// (group._wwPerKg/_coPerKg) once the dates catch up to today.
function buildGroupHistoryItem(group) {
  // Members the user excluded from this category's $/kg at a store must not
  // feed its history either (a "different item" was polluting the series).
  const perkgExcl = loadPerKgExclusions();
  const buildStoreSeries = (isWw) => {
    // One sorted, deduped (date -> price) series per member. Each point keeps
    // its SOURCE (member name + raw pack price) so the modal can offer
    // per-point exclusion that writes back to the right member.
    const memberSeries = group._members.map(m => {
      if (perkgExcl.has(`${group._groupKey}::${m.list_item}::${isWw ? 'ww' : 'coles'}`)) return [];
      // Sticker groups compare raw pack prices: ratio 1 (no $/kg conversion).
      const ratio = group._sticker ? 1 : perKgRatio(isWw ? m.woolworths : m.coles);
      if (ratio == null) return [];
      const ex = exclSetsFor(m.list_item)[isWw ? 'ww' : 'co'];
      const raw = isWw ? [...(m.price_history || []), ...(m.ww_price_history || [])]
                        : (m.coles_price_history || []);
      const byDate = new Map();
      for (const e of raw) {
        if (!(e.price > 0) || ex.has(Number(e.price).toFixed(2))) continue;
        byDate.set(e.date, { price: +(e.price * ratio).toFixed(2), src: m.list_item, raw: Number(e.price) }); // later entries for the same date win
      }
      return [...byDate.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));
    });

    const allDates = [...new Set(memberSeries.flat().map(p => p.date))].sort();
    const cursor = memberSeries.map(() => 0);
    const lastKnown = memberSeries.map(() => null);
    const out = [];
    for (const date of allDates) {
      memberSeries.forEach((series, i) => {
        while (cursor[i] < series.length && series[cursor[i]].date <= date) {
          lastKnown[i] = series[cursor[i]];
          cursor[i]++;
        }
      });
      const known = lastKnown.filter(p => p != null);
      if (known.length) {
        const best = known.reduce((a, b) => (a.price <= b.price ? a : b));
        out.push({ date, price: best.price, src: best.src, raw: best.raw });
      }
    }
    return out;
  };
  const wwSeries = buildStoreSeries(true);
  const coSeries = buildStoreSeries(false);
  return {
    list_item: group._groupLabel,
    _isGroupHistory: true,
    _groupKey: group._groupKey,
    _sticker: !!group._sticker,
    // date → winning source, for the modal's per-point exclusion buttons
    _wwMeta: new Map(wwSeries.map(e => [e.date, e])),
    _coMeta: new Map(coSeries.map(e => [e.date, e])),
    price_history: [],
    ww_price_history: wwSeries,
    coles_price_history: coSeries,
    woolworths: group._wwBest ? { price: group._wwPerKg, scraped_at: group._wwBest.result?.scraped_at } : null,
    coles: group._coBest ? { price: group._coPerKg, scraped_at: group._coBest.result?.scraped_at } : null,
  };
}

// Trend SORT position for a per-kg group. Mirrors the bar in groupTrendCellHTML - built
// from the members' $/kg series with the best $/kg as "current" - so sorting by trend
// orders groups by the same metric the bar shows. calcTrendPosition can't be used on a
// group: its price_history is empty and woolworths.price is a pack price, not $/kg, so it
// returned a meaningless value (the "per-kg items sort weird" bug).
function groupTrendPosition(group) {
  const cands = [group._wwBest, group._coBest].filter(Boolean);
  if (!cands.length) return 999;
  const best = cands.reduce((a, b) => (a.perkg <= b.perkg ? a : b));
  // Sticker groups: best.perkg already holds a raw pack price (see groupMetric),
  // so the range must come from raw prices too - mixing it with $/kg-converted
  // prices produced a meaningless position (the "sorts to a weird spot" bug).
  const prices = group._sticker
    ? group._members.flatMap(m => [...(m.price_history || []), ...(m.ww_price_history || []), ...(m.coles_price_history || [])]
        .map(e => e.price).filter(p => p > 0))
    : group._members.flatMap(m => memberPerKgPrices(m, ...memberStoreFlags(group, m)));
  if (prices.length < 2) return 999;
  const lo = Math.min(...prices), hi = Math.max(...prices);
  if (lo === hi) return 0.5;
  return Math.max(0, Math.min(1, (best.perkg - lo) / (hi - lo)));
}

// Trend position for any row: groups use their $/kg series, normal items use the shared
// calcTrendPosition. One dispatcher so desktop and mobile trend sorts stay consistent.
function trendPositionOf(item) {
  return item._isGroup ? groupTrendPosition(item) : calcTrendPosition(item);
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
// Stable product identity from a WW/Coles product URL (stockcode / trailing id), so
// different list_item aliases for the same product collapse to one row in the panel.
function perKgProductIdentity(url) {
  if (!url) return '';
  let m = url.match(/\/productdetails\/(\d+)/);   // Woolworths stockcode
  if (m) return 'ww:' + m[1];
  m = url.match(/-(\d+)(?:[/?#]|$)/);              // Coles trailing numeric id
  if (m) return 'co:' + m[1];
  return url.split('?')[0];
}

// Collapse per-kg variant rows that are duplicates to the shopper. Two stages:
//  (1) same pinned/scraped product URL - handles the many name-key aliases one product
//      accrued over time (with/without size, "(15% fat)", "Woolworths " prefix), INCLUDING
//      ones the user renamed and ones a Coles-only item wrongly matched on WW;
//  (2) same display name + same $/kg - handles genuinely distinct SKUs that read identically.
// The entry whose per-store name the user set always wins, so the named version survives.
// `variants` is [{ name, res, pk }]. Returns a new array sorted by $/kg ascending.
function dedupePerKgVariants(variants, storeKey, overrides, memberByName) {
  const nameFor = storeKey === 'ww' ? wwNameFor : coNameFor;
  const customName = (n) => storeKey === 'ww' ? (overrides[n] || {}).wwName : (overrides[n] || {}).colesName;
  const dispName = (v) => nameFor(v.name, overrides[v.name] || {}, memberByName.get(v.name)) || '';
  const pick = (map, key, v) => {
    const cur = map.get(key);
    if (!cur || (customName(v.name) && !customName(cur.name))) map.set(key, v);
  };
  const byId = new Map();
  for (const v of variants) {
    const url = pinnedUrlFor(v.name, storeKey) || v.res?.url || '';
    pick(byId, perKgProductIdentity(url) || `${(v.res?.name || '').toLowerCase()}|${v.res?.price}`, v);
  }
  const byLook = new Map();
  for (const v of byId.values()) pick(byLook, `${dispName(v).toLowerCase().trim()}|${v.pk.toFixed(2)}`, v);
  return [...byLook.values()].sort((a, b) => a.pk - b.pk);
}

function groupStoreVariantsHTML(group, store, overrides) {
  const storeKey = store === 'woolworths' ? 'ww' : 'coles';
  // This store's ordered member list (independent of the other store).
  const order = (storeKey === 'ww' ? group._wwList : group._coList) || [];
  const memberByName = new Map(group._members.map(m => [m.list_item, m]));
  const nameFor = storeKey === 'ww' ? wwNameFor : coNameFor;

  const raw = order
    .map(n => memberByName.get(n))
    .filter(m => m && !m._pending)
    .map(m => {
      const res = store === 'woolworths' ? m.woolworths : m.coles;
      return { name: m.list_item, res, pk: group._sticker ? res?.price ?? null : clientPerKg(res) };
    })
    .filter(v => v.pk != null);
  const variants = dedupePerKgVariants(raw, storeKey, overrides, memberByName);
  const cheapestPk = variants.length ? variants[0].pk : null;

  if (!variants.length) return '<div class="vg-pv empty">No matches at this store</div>';

  // Distinct SKUs sometimes share a scraped name (e.g. WW sells two "Woolworths Lean
  // Beef Mince" at different $/kg). Where display names collide, append the size token
  // from the list_item key so the rows read as different products, not duplicates.
  const displayName = (v) => nameFor(v.name, overrides[v.name] || {}, memberByName.get(v.name));
  const nameCount = {};
  variants.forEach(v => { const n = displayName(v); nameCount[n] = (nameCount[n] || 0) + 1; });

  const variantRows = variants.map((v) => {
    const ov = overrides[v.name] || {};
    let name = displayName(v);
    if (nameCount[name] > 1) {
      const sz = v.name.match(/(\d+(?:\.\d+)?\s*(?:kg|g|ml|l|pk|pack)\b)/i);
      if (sz && !new RegExp(sz[1].replace(/\s+/g, '\\s*'), 'i').test(name)) name += ` (${sz[1].trim()})`;
    }
    // Grey shelf price: the portion price for weight-priced items (pack_price, e.g.
    // $7.60 for a 200g salmon portion), else the pack price. The green $/kg beside it
    // stays the comparison metric; pack size already lives in the name.
    // Sticker groups compare by this same number, so showing it twice is redundant -
    // leave this span blank and let the bold span below carry it once, unsuffixed.
    const pack = group._sticker ? '' : ((v.res.pack_price ?? v.res.price) != null ? fmt(v.res.pack_price ?? v.res.price) : '');
    const safeKey = v.name.replace(/"/g, '&quot;');
    const url = pinnedUrlFor(v.name, storeKey) || v.res.url || null;
    const wwImg = resolveImgUrl(group._members.find(m => m.list_item === v.name)?.woolworths?.image_url) || '';
    const coImg = resolveImgUrl(group._members.find(m => m.list_item === v.name)?.coles?.image_url) || '';
    const ownImg = resolveImgUrl(v.res.image_url) || coImg || wwImg;
    const imgHtml = ownImg
      ? `<img class="vg-pv-img img-hoverable" src="${ownImg}" alt="" loading="lazy" data-item="${safeKey}" data-ww-img="${wwImg}" data-co-img="${coImg}" />`
      : '<span class="vg-pv-img vg-pv-noimg"></span>';
    const nameHtml = url
      ? `<a class="vg-pv-name" href="${escAttr(url)}" target="_blank" rel="noopener">${esc(name)}</a>`
      : `<span class="vg-pv-name">${esc(name)}</span>`;
    const isWin = v.pk === cheapestPk;
    const inBasket = _selectedItems.has(v.name);
    return `<div class="vg-pv${isWin ? ' win' : ''}">
        ${imgHtml}
        ${nameHtml}
        <span class="vg-pv-pack">${pack}</span>
        <span class="vg-pv-kg">$${v.pk.toFixed(2)}${group._sticker ? '' : '/kg'}</span>
        <button class="vg-pv-basket${inBasket ? ' selected' : ''}" data-item="${safeKey}" title="${inBasket ? 'Remove from basket' : 'Add to basket'}" aria-label="${inBasket ? 'Remove from basket' : 'Add to basket'}">${inBasket ? '✓' : '＋'}</button>
      </div>`;
  }).join('');

  return variantRows;
}

// Group sub-label: per-store product counts (e.g. "2 Woolworths · 1 Coles").
// "N products" was ambiguous - it counted the deduped union of list-items, which
// rarely matched the two store columns the user actually sees.
function groupSubLabel(group) {
  const parts = [];
  if (group._wwCount) parts.push(`${group._wwCount} Woolworths`);
  if (group._coCount) parts.push(`${group._coCount} Coles`);
  return parts.join(' · ') || 'No products';
}

// Desktop "card view" (#cardGrid) rendering for a variant group. This view had
// no group branch at all - unlike the table (appendGroupRowDesktop) and mobile
// cards (appendGroupCardMobile) - so groups fell through the per-item path
// above and showed the raw synthetic key ("__group_lamb_mince") as the name.
// Mirrors the per-item card structure (name/cat header, checkbox+priority,
// WW-vs-Coles prices, trend bar, edit/refresh footer) with the group's $/kg
// headline standing in for a single product's pack price.
function groupCardHTML(group, overrides) {
  const wwBest = group._wwBest, coBest = group._coBest;
  const cheaper = group.cheaper_store;

  const wwImg = resolveImgUrl(wwBest?.result?.image_url) || '';
  const coImg = resolveImgUrl(coBest?.result?.image_url) || '';
  const imgPref = loadImgOverrides()[group.list_item];
  const imgSrc = (imgPref === 'ww' ? wwImg : imgPref === 'coles' ? coImg : null)
    || (cheaper === 'coles' ? (coImg || wwImg) : (wwImg || coImg));
  const imgHtml = imgSrc
    ? `<img class="card-img" src="${imgSrc}" alt="" loading="lazy">`
    : '<div class="card-img-placeholder">No Photo</div>';

  const safeKey = group.list_item.replace(/"/g, '&quot;');
  const p = getPriority(group.list_item);
  const prioOptions = ['weekly', 'monthly', 'rare'].map(v =>
    `<option value="${v}"${p === v ? ' selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`
  ).join('');
  const isChecked = _checkedItems.has(group.list_item);

  const wwUrl = wwBest ? (overrides[wwBest.name]?.wwUrl || wwBest.result?.url || null) : null;
  const coUrl = coBest ? (overrides[coBest.name]?.colesUrl || coBest.result?.url || null) : null;
  const suf = group._unitSuffix ? `<span class="perkg-suffix">${group._unitSuffix}</span>` : '';
  const priceHtml = (perkg, url) => perkg == null
    ? '<span class="no-data">-</span>'
    : (url
      ? `<a href="${url}" target="_blank" rel="noopener" class="price-link">$${perkg.toFixed(2)}${suf}</a>`
      : `$${perkg.toFixed(2)}${suf}`);

  const wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span><span class="card-store-price">${priceHtml(group._wwPerKg, wwUrl)}</span></div>`;
  const coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span><span class="card-store-price">${priceHtml(group._coPerKg, coUrl)}</span></div>`;

  const wwClass = cheaper === 'woolworths' ? 'winner-ww' : '';
  const coClass = cheaper === 'coles'      ? 'winner-coles' : '';

  const units = getUnits(group.list_item);
  const savingHtml = (group._wwPerKg != null && group._coPerKg != null && group._wwPerKg !== group._coPerKg)
    ? `<div class="card-saving">${cheaper === 'woolworths' ? '<span class="store-chip ww sm">W</span>' : '<span class="store-chip coles sm">C</span>'} Save ${fmt(Math.abs(group._wwPerKg - group._coPerKg) * units)}</div>`
    : '';

  const bar = groupTrendCellHTML(group);

  return `<div class="item-card" data-item="${safeKey}" data-group="${group._groupKey}">
    <div class="card-top">
      <div class="card-img-wrap">${imgHtml}</div>
      <div class="card-info">
        <div class="card-name">${esc(group._groupLabel)}</div>
        <div class="card-cat">${esc(getCategory(group))} · ${esc(groupSubLabel(group))}</div>
      </div>
      <div class="card-right">
        <input type="checkbox" class="row-check card-check" data-item="${safeKey}"${isChecked ? ' checked' : ''}>
        <select class="priority-select card-priority-sel" data-item="${safeKey}">${prioOptions}</select>
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
      <button class="item-edit-btn card-btn" data-edit-item="${safeKey}" title="Edit category">✎ Edit</button>
      <button class="item-refresh-btn card-btn" data-item="${safeKey}" title="Refresh prices for this category">↺ Refresh</button>
    </div>
  </div>`;
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

  // No caret glyphs or expand/collapse buttons: the whole row toggles, and the
  // open panel renders as an indented speech bubble whose tail points back at
  // this row - the shape itself says "click the row above to close".
  const nameCell = `<td class="item-name vg-group-name-cell">
    <div class="item-row">
      ${imgHtml}
      <div class="item-info">
        <span class="vg-group-title">
          <span class="vg-group-label">${esc(group._groupLabel)}</span>
          <button class="item-edit-btn" data-edit-item="${group.list_item}" title="Edit category">✎</button>
        </span>
        <span class="vg-group-sub">${groupSubLabel(group)}</span>
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
      <span class="units-val">${isKgQty(group.list_item) ? units.toFixed(1) + ' kg' : units}</span>
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
  // Two independent per-store totals (matches normal rows); cheaper side tinted.
  const gCell = (v, isWin, cls) =>
    `<td class="total-cell ${isWin ? cls : ''}" style="font-size:13px;font-weight:600;white-space:nowrap">${
      v != null ? fmt(v) : '<span class="no-data">-</span>'}</td>`;
  const gWwWin = wwTotal != null && coTotal != null && wwTotal < coTotal - 0.005;
  const gCoWin = wwTotal != null && coTotal != null && coTotal < wwTotal - 0.005;
  let savingContent = '<span class="no-data">-</span>';
  if (group._wwPerKg != null && group._coPerKg != null) {
    const sav = Math.abs(group._wwPerKg - group._coPerKg) * units;
    savingContent = sav > 0 ? `<span class="saving-cell">${fmt(sav)}</span>` : '<span class="no-data">$0.00</span>';
  }

  const tds = {
    name:         nameCell,
    trend:        `<td class="trend-cell">${groupTrendCellHTML(group)}</td>`,
    priority:     priorityCell,
    units:        unitsCell,
    ww:           `<td class="price-cell ${wwClass}">${perKgCellHTML(group._wwPerKg, wwUrl, group._unitSuffix)}</td>`,
    coles:        `<td class="price-cell ${coClass}">${perKgCellHTML(group._coPerKg, coUrl, group._unitSuffix)}</td>`,
    cheaper:      `<td class="cheaper-cell">${badgeHtml}</td>`,
    pct:          `<td class="pct-cell">${pctHtml}</td>`,
    saving:       `<td><div class="saving-row">${savingContent}</div></td>`,
    trips:        `<td class="trips-cell"></td>`,
    category:     `<td style="font-size:12px;color:var(--text-mid)">${getCategory(group)}</td>`,
    last_scraped: `<td></td>`,
    ww_total:     gCell(wwTotal, gWwWin, 'cell-ww'),
    coles_total:  gCell(coTotal, gCoWin, 'cell-coles'),
  };

  // Selection checkbox (selects the whole category - basket uses its cheapest option).
  const checked = _checkedItems.has(group.list_item) ? ' checked' : '';
  const checkCell = `<td class="check-cell"><input type="checkbox" class="row-check" data-item="${group.list_item}"${checked}></td>`;

  // Actions: watchlist + refresh - identical classes/markup to normal product rows
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
        <span class="vg-panel-title">${esc(group._groupLabel)}</span>
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
      <div class="vg-panel-note">${group._sticker ? 'Highlighted = cheapest price at each store.' : 'Highlighted = lowest $/kg at each store. The cheapest sticker price isn\'t always cheapest per kilo.'}</div>
    </div>
  </td></tr>`;
  tbody.insertAdjacentHTML('beforeend', panel);
}

// Render one variant group as a mobile card: collapsed comparison + expanded
// per-store variant lists (cheapest highlighted).
function appendGroupCardMobile(container, group, overrides) {
  const isExpanded = _expandedGroups.has(group._groupKey);
  const cheaper = group.cheaper_store;
  const wwWin = cheaper === 'woolworths', coWin = cheaper === 'coles';
  const borderCls = wwWin ? ' cheaper-ww' : coWin ? ' cheaper-coles' : '';

  // Same layout as a normal mobile card in BOTH views: compact = the same
  // single-line row, detailed = image + name/icons/priority + trend + prices.
  // Only two things mark it as per-kg - the /kg price suffix and the expand
  // chevron sitting at the end of the prices row. The 🔥 uses the same
  // isHotDeal() as every other item; the 👁 watches the whole CATEGORY (the
  // group key), not individual member products.
  const wwKg = group._wwPerKg != null ? `$${group._wwPerKg.toFixed(2)}` : '-';
  const coKg = group._coPerKg != null ? `$${group._coPerKg.toFixed(2)}` : '-';
  // Cheapest variant across both stores (a REAL product) for the quick add-to-basket.
  const cheapestVar = [group._wwBest, group._coBest].filter(Boolean).sort((a, b) => a.perkg - b.perkg)[0];
  const hotDeal = isHotDeal(group, loadExclusions());
  const hotHtml = hotDeal ? '<span class="mc-hot" title="Hot Deal - meaningfully cheaper than its usual price right now">🔥</span>' : '';

  // Tap-to-add works like a normal card: tapping the card toggles the group
  // CATEGORY in the basket (priced per store as its cheapest variant there);
  // expand / collapse is the explicit chevron button. Legacy member entries
  // still light the card up.
  const inBasket = _selectedItems.has(group.list_item) ||
    (cheapestVar ? _selectedItems.has(cheapestVar.name) : false);
  const card = document.createElement('div');
  card.dataset.group = group._groupKey;
  if (cheapestVar) card.dataset.cheapest = cheapestVar.name;
  // Same keyboard/screen-reader contract as normal cards (see renderMobileCards).
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-pressed', String(inBasket));
  card.setAttribute('aria-label', group._groupLabel);

  // Compact view: identical single-line row to normal items (no eye/chevron -
  // same no-horizontal-room trade-off as normal compact rows).
  if (_mcView === 'compact') {
    card.className = `mobile-card mobile-card-compact vg-mobile-card${borderCls}${inBasket ? ' mc-selected' : ''}`;
    card.innerHTML = `
      ${hotHtml}
      <span class="mcc-name">${esc(group._groupLabel)}</span>
      <span class="mcc-price"><span class="store-chip sm ww">W</span><span class="${wwWin ? 'mcc-bold' : ''}">${wwKg}</span></span>
      <span class="mcc-price"><span class="store-chip sm coles">C</span><span class="${coWin ? 'mcc-bold' : ''}">${coKg}</span></span>`;
    container.appendChild(card);
    return;
  }

  const wwImg = resolveImgUrl(group._wwBest?.result?.image_url) || '';
  const coImg = resolveImgUrl(group._coBest?.result?.image_url) || '';
  const imgPref = loadImgOverrides()[group.list_item];
  const imgSrc = (imgPref === 'ww' ? wwImg : imgPref === 'coles' ? coImg : null)
    || (cheaper === 'coles' ? (coImg || wwImg) : (wwImg || coImg));
  const imgHtml = imgSrc
    ? `<img class="mc-img" src="${imgSrc}" alt="" loading="lazy">`
    : '<div class="mc-img-placeholder"></div>';
  const bar = groupTrendCellHTML(group);
  const isWatched = _watchlist.has(group.list_item);
  const watchBtn = `<button class="mc-watch-btn${isWatched ? ' active' : ''}" data-item="${escAttr(group.list_item)}" title="${isWatched ? 'Remove category from watchlist' : 'Watch this category'}">👁</button>`;
  const prioLabels = { weekly: 'Weekly', monthly: 'Monthly', rare: 'Rare' };
  const priority = getPriority(group.list_item);
  const prioHtml = prioLabels[priority]
    ? `<span class="mc-priority ${priority}">${prioLabels[priority]}</span>` : '';

  card.className = `mobile-card vg-mobile-card${borderCls}${inBasket ? ' mc-selected' : ''}${isExpanded ? ' vg-mobile-open' : ''}`;
  let html = `
    <div class="mc-top">
      ${imgHtml}
      <div class="mc-name-wrap">
        <div class="mc-name-row">
          <div class="mc-name">${esc(group._groupLabel)}</div>
          <span class="mc-icons">
            ${hotHtml}
            ${watchBtn}
            ${bar ? `<button class="mc-hist-btn" data-manage-item="__group_${group._groupKey}" title="Price history" aria-label="View price history">${HIST_CLOCK_SVG}</button>` : ''}
          </span>
        </div>
        <div class="mc-badges">
          <div class="mc-badges-left">${prioHtml}</div>
        </div>
      </div>
    </div>
    ${bar ? `<div class="mc-bar">${bar}</div>` : ''}
    <div class="mc-prices">
      <div class="mc-store-col">
        <div class="mc-store-label ww-col"><span class="store-chip sm ww">W</span> Woolworths</div>
        <div class="mc-price${wwWin ? ' cheaper' : ''}">${wwKg}<span class="vgm-kg-suffix">/kg</span></div>
      </div>
      <div class="mc-store-col">
        <div class="mc-store-label coles-col"><span class="store-chip sm coles">C</span> Coles</div>
        <div class="mc-price${coWin ? ' cheaper-c' : ''}">${coKg}<span class="vgm-kg-suffix">/kg</span></div>
      </div>
      <button class="vgm-chevron-btn" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Hide store options' : 'Show store options'}" title="${isExpanded ? 'Hide store options' : 'Show store options'}">${isExpanded ? '▾' : '▸'}</button>
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
let _catEditOrig = null; // per-store membership at modal-open, for removal detection
let _catDragSrc = null;  // drag source row, shared by the once-bound drag handlers

// A blank product row for the "+ Add product" action. Matches makeRow(isNew).
// Best-effort human product name from a Coles/WW product URL slug. Used to auto-fill the
// name field when a URL is pasted into a new category row, so you don't retype it.
// Pure (no DOM) - unit-tested in scripts/perkg_selfcheck.js.
function deriveNameFromUrl(url) {
  if (!url) return '';
  let slug = '';
  try {
    const u = new URL(url);
    if (u.hostname.includes('woolworths')) {
      const m = u.pathname.match(/\/productdetails\/\d+\/([^/?]+)/);
      slug = m ? m[1] : '';
    } else if (u.hostname.includes('coles')) {
      const m = u.pathname.match(/\/product\/(.+?)-\d+\/?$/); // strip trailing -<id>
      slug = m ? m[1] : '';
    }
  } catch { return ''; }
  if (!slug) return '';
  const words = decodeURIComponent(slug).replace(/-/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  // Title-case each word, but leave size tokens like "1.4kg" untouched.
  const name = words.map(w => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return name.replace(/\bRspca\b/g, 'RSPCA').replace(/\bBbq\b/g, 'BBQ').replace(/\bIandj\b/gi, 'I&J');
}

function catEditNewRow(store) {
  const label = store === 'ww' ? 'Woolworths' : 'Coles';
  return `<div class="cat-prod" data-store="${store}" draggable="true">
        <span class="cat-item-handle">⠿</span>
        <input type="checkbox" class="cat-incl" checked title="Include in cheapest $/kg" />
        <div class="cat-prod-main">
          <input type="text" class="cat-name" value="" placeholder="${label} product name" />
          <input type="text" class="cat-url" value="" placeholder="${label} product URL" />
        </div>
        <button class="cat-prod-remove" title="Remove from this store">✕</button>
      </div>`;
}

function openCategoryEditModal(groupKey) {
  const cat = loadVariantGroups().find(g => g.key === groupKey);
  if (!cat || !_lastData) return;
  _catEditKey = groupKey;
  const byName = new Map(_lastData.items.map(i => [i.list_item, i]));
  const ov = loadOverrides();
  const excl = loadPerKgExclusions();
  const stores = resolveStoreLists(cat, byName);
  // Snapshot the per-store membership so save can detect deletions (a member the
  // user pulled out of a store's column) and actually make them stick - see
  // saveCategoryEdit's removal handling.
  _catEditOrig = { ww: [...stores.ww], coles: [...stores.coles] };

  $('catEditName').value = cat.label;

  // One product row, scoped to a single store. Woolworths and Coles each have
  // their own independent column - separate products, names, URLs, and order.
  const makeRow = (store, itemName, isNew) => {
    if (isNew) return catEditNewRow(store);
    const o = ov[itemName] || {};
    const data = byName.get(itemName);
    const nameFor = store === 'ww' ? wwNameFor : coNameFor;
    const label = store === 'ww' ? 'Woolworths' : 'Coles';
    const name = nameFor(itemName, o, data).replace(/"/g, '&quot;');
    const url = ((store === 'ww' ? o.wwUrl : o.colesUrl) ||
      (store === 'ww' ? data?.woolworths?.url : data?.coles?.url) || '').replace(/"/g, '&quot;');
    const incl = !excl.has(`${groupKey}::${itemName}::${store}`);
    const attrs = ` data-item="${itemName.replace(/"/g, '&quot;')}"`;
    return `<div class="cat-prod" data-store="${store}"${attrs} draggable="true">
        <span class="cat-item-handle">⠿</span>
        <input type="checkbox" class="cat-incl"${incl ? ' checked' : ''} title="Include in cheapest $/kg" />
        <div class="cat-prod-main">
          <input type="text" class="cat-name" value="${escAttr(name)}" placeholder="${escAttr(label)} product name" />
          <input type="text" class="cat-url" value="${url}" placeholder="${label} product URL" />
        </div>
        <button class="cat-prod-remove" title="Remove from this store">✕</button>
      </div>`;
  };

  const priceFor = (name, store) => {
    const d = byName.get(name);
    const res = store === 'ww' ? d?.woolworths : d?.coles;
    return (cat.sticker ? res?.price : clientPerKg(res)) ?? Infinity;
  };

  const colHTML = (store, names) => {
    const chip = store === 'ww' ? 'ww' : 'coles';
    const letter = store === 'ww' ? 'W' : 'C';
    const label = store === 'ww' ? 'Woolworths' : 'Coles';
    const sorted = [...names].sort((a, b) => priceFor(a, store) - priceFor(b, store));
    const rows = sorted.map(n => makeRow(store, n, false)).join('')
      || '<div class="cat-prod-empty">No products yet</div>';
    return `<div class="cat-col">
        <div class="cat-col-h"><span class="store-chip ${chip} sm">${letter}</span> ${label}</div>
        <div class="cat-col-list" data-store="${store}">${rows}</div>
        <button class="cat-add-product${store === 'coles' ? ' cat-add-coles' : ''}" data-store="${store}">+ Add ${label} product</button>
      </div>`;
  };

  $('catEditBody').innerHTML = `
    <div class="cat-cols">
      ${colHTML('ww', stores.ww)}
      ${colHTML('coles', stores.coles)}
    </div>`;

  bindCategoryEditBody();
  document.body.style.overflow = 'hidden';
  $('categoryEditModal').classList.add('open');
}

// Bind the add/remove + drag-reorder handlers to the (persistent) modal body ONCE.
// Previously these lived inside openCategoryEditModal, so each reopen stacked another
// copy - making "+ Add product" insert multiple rows and drops fire repeatedly.
function bindCategoryEditBody() {
  const body = $('catEditBody');
  if (!body || body._catBound) return;
  body._catBound = true;

  // Remove + add buttons (delegated across both columns).
  body.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.cat-prod-remove');
    if (removeBtn) { removeBtn.closest('.cat-prod').remove(); return; }
    const addBtn = e.target.closest('.cat-add-product');
    if (addBtn) {
      const store = addBtn.dataset.store;
      const listEl = addBtn.closest('.cat-col').querySelector('.cat-col-list');
      listEl.querySelector('.cat-prod-empty')?.remove();
      const wrap = document.createElement('div');
      wrap.innerHTML = catEditNewRow(store).trim();
      const row = wrap.firstElementChild;
      listEl.appendChild(row);
      row.querySelector('.cat-url').focus();
    }
  });

  // Paste a product URL into a NEW row → auto-fill the name from the URL slug (only
  // while the name is still blank, so manual edits are never clobbered).
  body.addEventListener('input', (e) => {
    const urlInput = e.target.closest('.cat-url');
    if (!urlInput) return;
    const row = urlInput.closest('.cat-prod');
    if (!row || row.dataset.item) return;            // existing rows keep their name
    const nameInput = row.querySelector('.cat-name');
    if (nameInput && !nameInput.value.trim()) {
      const derived = deriveNameFromUrl(urlInput.value.trim());
      if (derived) nameInput.value = derived;
    }
  });

  // HTML5 drag-and-drop - reordering is scoped to within a single column.
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.cat-prod[draggable]');
    if (!row) return;
    _catDragSrc = row;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  body.addEventListener('dragend', () => {
    body.querySelectorAll('.cat-prod').forEach(el => el.classList.remove('dragging', 'drag-over'));
    _catDragSrc = null;
  });
  body.addEventListener('dragover', (e) => {
    const over = e.target.closest('.cat-prod[draggable]');
    if (!over || over === _catDragSrc) return;
    if (!_catDragSrc || over.parentElement !== _catDragSrc.parentElement) return; // same column only
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.querySelectorAll('.cat-prod').forEach(el => el.classList.remove('drag-over'));
    over.classList.add('drag-over');
  });
  body.addEventListener('drop', (e) => {
    const over = e.target.closest('.cat-prod[draggable]');
    if (!over || !_catDragSrc || over === _catDragSrc) return;
    if (over.parentElement !== _catDragSrc.parentElement) return;
    e.preventDefault();
    over.classList.remove('drag-over');
    const rect = over.getBoundingClientRect();
    const listEl = over.parentElement;
    if (e.clientY < rect.top + rect.height / 2) listEl.insertBefore(_catDragSrc, over);
    else listEl.insertBefore(_catDragSrc, over.nextSibling);
  });
}

function saveCategoryEdit() {
  if (!_catEditKey) return;
  const key = _catEditKey;
  const label = $('catEditName').value.trim();

  const ov = loadOverrides();
  const excl = loadPerKgExclusions();
  const newFetches = [];

  // Each column is processed independently → its own ordered member list.
  const collectColumn = (store) => {
    const order = [];
    const urlKey = store === 'ww' ? 'wwUrl' : 'colesUrl';
    const nameKey = store === 'ww' ? 'wwName' : 'colesName';
    document.querySelectorAll(`#catEditBody .cat-col-list[data-store="${store}"] .cat-prod`).forEach(row => {
      const nm = row.querySelector('.cat-name').value.trim();
      const url = row.querySelector('.cat-url').value.trim();
      const incl = row.querySelector('.cat-incl').checked;
      const isNew = !row.dataset.item;
      // A row needs a name; a brand-new row also needs a URL to be fetchable.
      if (!nm || (isNew && !url)) return;
      const item = isNew ? nm : row.dataset.item;
      order.push(item);
      ov[item] = ov[item] || {};
      ov[item][nameKey] = nm;
      if (url) ov[item][urlKey] = url; else delete ov[item][urlKey];
      const ek = `${key}::${item}::${store}`;
      if (incl) excl.delete(ek); else excl.add(ek);
      if (isNew) newFetches.push({ name: nm, [urlKey]: url });
    });
    return order;
  };

  const wwItems = collectColumn('ww');
  const coItems = collectColumn('coles');
  // Union (WW order first, then Coles-only items) = the membership the user just defined.
  const items = [...wwItems, ...coItems.filter(n => !wwItems.includes(n))];

  // Store REMOVALS: a member that was in a store's column when the modal opened but
  // isn't now. This must genuinely stick - the old code just dropped it from the
  // order list, but resolveStoreLists re-appended any member that still had a live
  // price at that store, so a wrong cross-store match (e.g. Chicken Roast Portions
  // matched to a Coles "Chicken Parma" product) kept coming back every render, and
  // the scraper kept re-matching it. To make removal permanent we (1) pin the KEPT
  // store single-store so the scraper stops name-searching the removed store, and
  // (2) null the removed store's data in latest.json so it disappears immediately
  // and can't be re-appended.
  const orig = _catEditOrig || { ww: [], coles: [] };
  const removals = []; // { item, store }  store = the one being removed
  for (const n of orig.ww)    if (!wwItems.includes(n)) removals.push({ item: n, store: 'ww' });
  for (const n of orig.coles) if (!coItems.includes(n)) removals.push({ item: n, store: 'coles' });

  const touchedItems = new Set();  // names whose url_overrides entry changed
  let latestChanged = false;
  for (const { item, store } of removals) {
    const keptStore = store === 'ww' ? 'coles' : 'ww';
    const stillInKept = (keptStore === 'ww' ? wwItems : coItems).includes(item);
    // Only single-store-pin when the member survives at the other store; a member
    // removed from BOTH stores is just leaving the category (handled by the diff).
    if (stillInKept) {
      const data = _lastData?.items?.find(i => i.list_item === item);
      const keptUrl = keptStore === 'ww'
        ? (ov[item]?.wwUrl || data?.woolworths?.url)
        : (ov[item]?.colesUrl || data?.coles?.url);
      if (keptUrl) {
        ov[item] = ov[item] || {};
        ov[item][keptStore === 'ww' ? 'wwUrl' : 'colesUrl'] = keptUrl;
        delete ov[item][store === 'ww' ? 'wwUrl' : 'colesUrl'];
        touchedItems.add(item);
      }
      // Null the removed store now so it drops from the UI and resolveStoreLists
      // can't re-append it (qualifies() keys off price > 0).
      if (data) {
        data[store === 'ww' ? 'woolworths' : 'coles'] = null;
        data.cheaper_store = null; data.saving_per_item = null;
        latestChanged = true;
      }
    }
    // Belt-and-suspenders: block it from that store's $/kg list regardless.
    excl.add(`${key}::${item}::${store}`);
  }

  // Persist as a diff vs the current code defaults so removals stick and future default
  // changes flow through. `remove` = defaults the user dropped; `add` = everything else.
  const defItems = (DEFAULT_VARIANT_GROUPS.find(d => d.key === key) || {}).items || [];
  const add = items.filter(n => !defItems.includes(n));
  const remove = defItems.filter(n => !items.includes(n));
  saveVariantGroupOverride(key, { label: label || undefined, add, remove, ww_order: wwItems, coles_order: coItems });
  savePerKgExclusions(excl);
  saveOverrides(ov);
  closeCategoryEditModal();
  if (_lastData) renderPage(_lastData);

  const s = loadSettings();
  const needRepo = newFetches.length || touchedItems.size || latestChanged;
  if (needRepo && !s.token) {
    alert('Saved locally. Add your GitHub token (Auto-update Setup) so the change reaches the scraper and other devices.');
  } else if (needRepo) {
    // Exact-write the touched items so a removed URL is actually deleted from the
    // repo (merge-only writes could never drop a key). New products merge in.
    persistUrlOverridesToRepo(s, ov, [...touchedItems])
      .catch(err => showSyncError('URL overrides', err, () => persistUrlOverridesToRepo(s, ov, [...touchedItems]).catch(() => {})));
    if (latestChanged) {
      persistLatestJson(_lastData, `edit: ${key} - removed ${removals.map(r => `${r.item} @ ${r.store}`).join(', ')}`)
        .catch(err => showSyncError('latest.json', err));
    }
    // New products' URLs live in url_overrides now - fetch their prices immediately.
    newFetches.forEach(f => triggerItemRefresh(f.name, null, { wwUrl: f.wwUrl, colesUrl: f.colesUrl }));
    if (newFetches.length) {
      alert(`Saved. Fetching ${newFetches.length} new product(s) - they'll appear once the next price check finishes.`);
    } else if (removals.length) {
      showToast(`✓ Removed ${removals.length} store listing${removals.length > 1 ? 's' : ''} - the scraper will stop checking ${removals.map(r => r.store === 'ww' ? 'WW' : 'Coles').join('/')}.`);
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
    // trendPositionOf(): groups use their $/kg series, normal items use calcTrendPosition.
    displayItems.sort((a, b) => (trendPositionOf(a) - trendPositionOf(b)) * sortDir);
  } else if (_mobileSortMode === 'az') {
    displayItems.sort((a, b) => shortName(a.list_item).localeCompare(shortName(b.list_item)) * sortDir);
  } else if (_mobileSortMode === 'savings') {
    const sv = it => (savingAmount(it) || 0) * getUnits(it.list_item);
    displayItems.sort((a, b) => (sv(b) - sv(a)) * sortDir);
  } else if (_mobileSortMode === 'store') {
    // ↑ Coles-cheaper first, ↓ WW-cheaper first; equal-priced in the middle
    // either way (same idea as the web column filter). Sort is stable, so the
    // previous order is kept within each band.
    const rank = it => it.cheaper_store === 'coles' ? 0 : it.cheaper_store === 'woolworths' ? 2 : 1;
    displayItems.sort((a, b) => (rank(a) - rank(b)) * sortDir);
  }

  // Toolbar: sort chips (left) + view toggle (right)
  const toolbar = document.createElement('div');
  toolbar.className = 'mc-toolbar';

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'mc-sort-chips';

  // (The C/W store-sort chip was removed as redundant with Savings; the
  // 'store' sort itself remains reachable by tapping a store total card.)
  const CHIPS = [
    { mode: 'trend',   label: 'Trend'},
    { mode: 'az',      label: 'A–Z'      },
    { mode: 'savings', label: 'Savings'  },
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
  // Watchlist chip - lives with the sort chips (the pill row is hidden on
  // phones); delegates to the filter row's pill so there's ONE toggle.
  const watchChip = document.createElement('button');
  watchChip.className = 'mc-sort-chip mc-watch-chip' + (_activePriority === 'watchlist' ? ' active' : '');
  watchChip.textContent = '👁';
  watchChip.title = 'Watchlist';
  watchChip.setAttribute('aria-label', 'Watchlist filter');
  watchChip.onclick = () => $('watchlistPill')?.click();
  chipsWrap.appendChild(watchChip);
  toolbar.appendChild(chipsWrap);

  // View toggle - single icon-only button; glyph shows the layout you'll switch TO
  const ICON_LIST = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
  const ICON_CARDS = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/></svg>';
  // The detailed/compact toggle sits in the toolbar, to the right of the sort
  // chips (there's spare room there). The mobile HEADER slot is used for the
  // Basket shortcut instead. Icon shows the layout you'll switch TO; onclick
  // (not addEventListener) so the per-render refresh never stacks handlers.
  const viewBtn = document.createElement('button');
  viewBtn.id = 'mcViewToggle';
  viewBtn.type = 'button';
  viewBtn.innerHTML = _mcView === 'detailed' ? ICON_LIST : ICON_CARDS;
  viewBtn.title = _mcView === 'detailed' ? 'Compact view' : 'Detailed view';
  viewBtn.setAttribute('aria-label', viewBtn.title);
  viewBtn.onclick = () => {
    _mcView = _mcView === 'detailed' ? 'compact' : 'detailed';
    localStorage.setItem('pw_mc_view_v1', _mcView);
    if (_lastData) renderPage(_lastData); // renderPage preserves scroll itself
  };
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
    const displayName = ov.displayName || shortName(item.list_item);
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

    const { ww: wwP100, coles: coP100 } = per100Pair(ww, co);
    const wwUnit = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : '';
    const coUnit = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : '';

    const prioLabels = { weekly: 'Weekly', monthly: 'Monthly', rare: 'Rare' };
    const prioHtml = prioLabels[priority]
      ? `<span class="mc-priority ${priority}">${prioLabels[priority]}</span>` : '';

    const wwCheaper = cheaper === 'woolworths';
    const coCheaper = cheaper === 'coles';
    const saving    = savingAmount(item);
    const borderCls = wwCheaper ? ' cheaper-ww' : coCheaper ? ' cheaper-coles' : '';

    const isSelected = _selectedItems.has(item.list_item);
    const card = document.createElement('div');
    const compact = _mcView === 'compact';
    card.className = `mobile-card${borderCls}${isSelected ? ' mc-selected' : ''}${compact ? ' mobile-card-compact' : ''}`;
    card.dataset.item = item.list_item;
    // Keyboard/screen-reader access: the card is a tap-to-select toggle, so it
    // must be reachable by Tab and announce its pressed state. Enter/Space is
    // handled by one delegated keydown on #mobileCards.
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-pressed', String(isSelected));
    card.setAttribute('aria-label', displayName);

    const watchBtn = isWatchedMC
      ? `<button class="mc-watch-btn active" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Remove from watchlist">👁</button>`
      : `<button class="mc-watch-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Add to watchlist">👁</button>`;

    const savingTag = saving && saving > 0 ? `<span class="mc-saving">Save ${fmt(saving)}</span>` : '';

    if (compact) {
      // Single-line row: fire, SHORT name, W chip + price, C chip + price (cheaper bold).
      // No eye - there's no horizontal room in this layout.
      const unarch = _activePriority === 'archive'
        ? `<button class="mc-unarchive-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Unarchive">↩</button>` : '';
      card.innerHTML = `
        ${hotDeal ? '<span class="mc-hot" title="Hot Deal - meaningfully cheaper than its usual price right now">🔥</span>' : ''}
        <span class="mcc-name">${esc(ov.displayName || shortName(item.list_item))}</span>
        <span class="mcc-price"><span class="store-chip sm ww">W</span><span class="${wwCheaper ? 'mcc-bold' : ''}">${ww ? fmt(ww.price) : '-'}</span></span>
        <span class="mcc-price"><span class="store-chip sm coles">C</span><span class="${coCheaper ? 'mcc-bold' : ''}">${co ? fmt(co.price) : '-'}</span></span>
        ${unarch ? `<span class="mc-icons">${unarch}</span>` : ''}`;
    } else {
      card.innerHTML = `
      <div class="mc-top">
        ${imgHtml}
        <div class="mc-name-wrap">
          <div class="mc-name-row">
            <div class="mc-name">${esc(displayName)}</div>
            <span class="mc-icons">
              ${hotDeal ? '<span class="mc-hot" title="Hot Deal - meaningfully cheaper than its usual price right now">🔥</span>' : ''}
              ${watchBtn}
              ${barHtml ? `<button class="mc-hist-btn" data-manage-item="${item.list_item.replace(/"/g,'&quot;')}" title="Price history" aria-label="View price history">${HIST_CLOCK_SVG}</button>` : ''}
              ${_activePriority === 'archive' ? `<button class="mc-unarchive-btn" data-item="${item.list_item.replace(/"/g,'&quot;')}" title="Unarchive">↩</button>` : ''}
            </span>
          </div>
          ${altHintHTML(item)}
        </div>
      </div>
      ${barHtml ? `<div class="mc-bar">${barHtml}</div>` : ''}
      <div class="mc-prices">
        <div class="mc-store-col">
          <div class="mc-store-label ww-col"><span class="store-chip sm ww">W</span> Woolworths</div>
          <div class="mc-price${wwCheaper ? ' cheaper' : ''}">${ww ? fmt(ww.price) : '-'}</div>
          ${wwUnit ? `<div class="mc-unit">${wwUnit}</div>` : ''}
          ${wwCheaper && saving > 0 ? `<div class="mc-save-line">Save ${fmt(saving)}</div>` : ''}
          ${multiBuyBadge(ww)}
        </div>
        <div class="mc-store-col">
          <div class="mc-store-label coles-col"><span class="store-chip sm coles">C</span> Coles</div>
          <div class="mc-price${coCheaper ? ' cheaper-c' : ''}">${co ? fmt(co.price) : '-'}</div>
          ${coUnit ? `<div class="mc-unit">${coUnit}</div>` : ''}
          ${coCheaper && saving > 0 ? `<div class="mc-save-line">Save ${fmt(saving)}</div>` : ''}
          ${multiBuyBadge(co)}
        </div>
      </div>`;
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
      // Any other button/link (History clock, product links) is handled by the
      // container's delegated listener - a tap on it must NOT also toggle selection.
      if (e.target.closest('button, a')) return;
      // Mobile-only (≤700px): tap card to toggle selection
      if (window.innerWidth <= 700) {
        const name = item.list_item;
        if (_selectedItems.has(name)) _selectedItems.delete(name);
        else _selectedItems.add(name);
        persistBasketStore(); // tap = add/remove from the persistent basket
        card.classList.toggle('mc-selected', _selectedItems.has(name));
        card.setAttribute('aria-pressed', String(_selectedItems.has(name)));
        _updateSelectedPill();
        return;
      }
      const fullItem = (_lastData?.items || []).find(i => i.list_item === item.list_item) || item;
      openPriceHistoryModal(fullItem);
    });

    container.appendChild(card);
  });
}

// ── Cheaper-alternative hint (find_alternatives data) ────────────────────────
// The scraper stores same-form cheaper products in item.alternatives; until now
// nothing rendered them. Show the cheapest one as a one-line hint under the
// product name. Re-checked against the CURRENT best price (scraper data can lag a
// price drop), so the hint only appears when the swap is genuinely cheaper today.
// 2026-07-09: hidden per user - the suggestions weren't relevant enough. Flip the
// flag to bring the hint back; the scraper still collects item.alternatives.
const SHOW_ALT_HINTS = false;
function altHintHTML(item) {
  if (!SHOW_ALT_HINTS) return '';
  const alts = Array.isArray(item.alternatives)
    ? item.alternatives.filter(a => a && a.price != null && a.price > 0) : [];
  if (!alts.length) return '';
  const best = [...alts].sort((a, b) => a.price - b.price)[0];
  const cur = Math.min(item.woolworths?.price ?? Infinity, item.coles?.price ?? Infinity);
  if (!isFinite(cur) || best.price >= cur) return '';
  const store = best.retailer === 'coles' ? 'coles' : 'ww';
  const chip = `<span class="alt-store ${store}">${store === 'coles' ? 'C' : 'W'}</span>`;
  const label = `${esc(best.name)}`;
  const body = best.url
    ? `<a href="${escAttr(best.url)}" target="_blank" rel="noopener" title="${escAttr(best.name)}">${label}</a>`
    : `<span title="${escAttr(best.name)}">${label}</span>`;
  return `<div class="alt-hint" title="Cheaper alternative found during the last scrape">💡 <b>${fmt(best.price)}</b> ${chip} ${body}</div>`;
}

// ── Index page rendering ─────────────────────────────────────────────────────

// Full re-render rebuilds the table/cards DOM, which resets the scroll position -
// on mobile that meant any tap that re-renders (priority change, group expand,
// exclusion save, filter toggle) jumped the view back to the top. Wrap the real
// renderer so EVERY exit path restores scroll: the initial load is at scrollY 0
// anyway, and the browser clamps to the new content height.
function renderPage(data) {
  const y = window.scrollY;
  _renderPageInner(data);
  window.scrollTo(0, y);
}

function _renderPageInner(data) {
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
  $('watchlistPill')?.classList.toggle('active', _activePriority === 'watchlist');

  // Always compute banner stats client-side so savings are units-weighted
  const s = computeBannerStats(data.items);

  // Default the CHEAPER store's Total column on, once per page load. Deliberately
  // not re-evaluated on every render: recomputing it per filter/keystroke made a
  // column appear and vanish while typing in the search box, which is far more
  // disorienting than useful. Skipped entirely once the user has ticked either
  // Total column themselves (pw_col_total_manual) - their choice wins forever.
  if (!_totalColDefaulted) {
    _totalColDefaulted = true;
    let manual = false;
    try { manual = localStorage.getItem('pw_col_total_manual') === '1'; } catch {}
    if (!manual && (s.cheaper_store === 'woolworths' || s.cheaper_store === 'coles')) {
      _colVisibility.ww_total    = s.cheaper_store === 'woolworths';
      _colVisibility.coles_total = s.cheaper_store === 'coles';
      saveColVisibility();
    }
  }
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

  // A single fetch can momentarily lack scrape_progress (CDN hiccup or the window
  // between two of the scraper's progress pushes). Don't let that flicker the bar off:
  // keep showing the last-known progress until the auto-poll CONFIRMS completion
  // (3-strike, below) and clears _scrapeActive. This is what stopped the bar
  // "disappearing midway with no feedback".
  const rawProg = data.scrape_progress;
  // A NEW run (different started_at) must not inherit the previous run's baseline:
  // when two runs overlapped, done could jump backwards (260/284 then 155/284) and
  // the stall timer read that as "no progress" and flashed ⚠ Stalled. Reset the
  // baseline on a run change so each run is judged on its own movement.
  if (rawProg && _lastProgress && scrapeRunId(rawProg) !== scrapeRunId(_lastProgress)) {
    _progressLastDone = null;
    _progressLastChangeTime = null;
    _progressDismissed = false;
  }
  if (rawProg) { _lastProgress = rawProg; _scrapeActive = true; _sawAnyProgress = true; }
  const prog = rawProg || (_scrapeActive ? _lastProgress : null);

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
    // done>=total means the run finished (the field just wasn't cleared) - fall
    // through to hide so a stuck 53-of-53 doesn't linger. isScrapeRunDismissed
    // keeps a ✕'d run buried across refreshes.
    if (prog && prog.total > 0 && prog.done < prog.total && !_progressDismissed && !isScrapeRunDismissed(prog)) {
      // Keep the button in its working state for the whole run, including after a
      // reload mid-scrape (the strip survives; the button should agree with it).
      setRefreshState('working');
      const pct = Math.round((prog.done / prog.total) * 100);
      const isStale = _progressLastChangeTime && (Date.now() - _progressLastChangeTime > STALE_PROGRESS_MS);
      strip.style.display = 'flex';
      strip.classList.toggle('stale', isStale);
      $('scrapeStripLabel').textContent = isStale
        ? `⚠ Stalled at ${prog.done} of ${prog.total} - try refreshing`
        : pct === 0
          ? `Starting price refresh…`
          : `Refreshing prices… ${prog.done} of ${prog.total}`;
      $('scrapeStripFill').style.width = `${pct}%`;
      $('scrapeStripPct').textContent = `${pct}%`;
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = isStale ? 'inline-block' : 'none';
    } else if (_pendingRefreshItems.size > 0) {
      strip.style.display = 'flex';
      strip.classList.remove('stale');
      const names = [..._pendingRefreshItems].map(stripWW).join(', ');
      $('scrapeStripLabel').textContent = `⏳ Scraping: ${names}…`;
      $('scrapeStripFill').style.width = '0%';
      $('scrapeStripPct').textContent = '';
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = 'none';
    } else if (scrapeDispatchPending(data) && !_progressDismissed && !_sawAnyProgress) {
      // A full scrape was triggered (possibly in another tab / before a
      // refresh) but the scraper hasn't pushed its first progress yet.
      strip.style.display = 'flex';
      strip.classList.remove('stale');
      $('scrapeStripLabel').textContent = '⏳ Scrape triggered - waiting for first progress…';
      $('scrapeStripFill').style.width = '0%';
      $('scrapeStripPct').textContent = '';
      const retryBtn = $('scrapeStripRetry');
      if (retryBtn) retryBtn.style.display = 'none';
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
  const hotTune = loadDealTune(); // same sliders the Hot Deals page uses
  const hotCount = getHotDealItems(data.items, {
    exclusions: _renderExclusions,
    archivedSet: _repoArchivedSet,
    priorities: _uiPriorities,
    minDropPct: hotTune.drop,
    minStoreDiffPct: hotTune.diff,
    includeATL: hotTune.atl,
    mode: hotTune.mode,
  }).length;
  $('lastUpdated').innerHTML = `<span>Updated ${formatDate(data.last_updated)}</span><span>${coverageText}</span>${hotCount > 0 ? `<a href="hot-deals.html" class="hot-deals-link">🔥 ${hotCount} deal${hotCount !== 1 ? 's' : ''}</a>` : ''}`;
  $('banner').style.display = 'block';
  const _sw = $('searchWrap');
  if (_sw) _sw.style.display = '';
  checkPendingItemRefresh(data);

  _lastData = data;

  // Auto-poll while a dispatched scrape hasn't produced progress yet (page was
  // refreshed / opened mid-wait): slow poll until progress appears or the
  // marker is spent - each renderPage re-evaluates and stops the timer.
  if (!rawProg && scrapeDispatchPending(data) && !window._dispatchWaitTimer) {
    window._dispatchWaitTimer = setInterval(async () => {
      const fresh = await loadData();
      if (!fresh) return;
      if (fresh.scrape_progress || !scrapeDispatchPending(fresh)) {
        clearInterval(window._dispatchWaitTimer);
        window._dispatchWaitTimer = null;
        renderPage(fresh); // hands off to the normal progress branch below
      }
    }, 15000);
  }

  // Auto-poll progress while scraping
  if (rawProg) {
    window._progressNoDataStreak = 0; // reset streak whenever we see progress
    if (!window._progressPollTimer) {
      window._progressPollTimer = setInterval(async () => {
        // WHERE progress lives matters. While a run is in flight the scraper
        // publishes it ONLY to the scrape-progress branch (push_progress ->
        // GitHub contents API); main - what Pages serves, and what loadData()
        // reads - gets scrape_progress only in the run's final commit.
        // So polling loadData() here saw "no scrape_progress" on EVERY tick
        // mid-run: the 3-strike "run finished" rule fired every ~21s, cleared
        // _scrapeActive and hid the strip, and the branch poll re-showed it a
        // few seconds later. That cycle is why the bar kept disappearing (and,
        // before the message was gated, why it flipped to "waiting for first
        // progress"). Ask the branch when we have a token; a FAILED branch read
        // is inconclusive, not an answer, so it must never count as a strike.
        const s = loadSettings();
        const viaBranch = s.token ? await loadProgressData() : null;
        const authoritative = s.token ? !!viaBranch : true;
        const fresh = viaBranch || await loadData();
        if (!fresh) return;
        const fp = fresh.scrape_progress;
        // A finished run leaves its last push (done == total) on the branch -
        // that never "goes missing", so completion has to be recognised here too.
        if (fp && fp.total > 0 && fp.done >= fp.total) {
          clearInterval(window._progressPollTimer);
          window._progressPollTimer = null;
          window._progressNoDataStreak = 0;
          _scrapeActive = false;
          _lastProgress = null;
          _sawAnyProgress = false;
          renderPage(fresh);
          return;
        }
        if (!fp) {
          if (!authoritative) return;  // couldn't reach the branch - don't guess
          // Require 3 consecutive no-progress responses before declaring done.
          // A single missing response could be a CDN hiccup or a between-push window -
          // the strip stays up (via _scrapeActive/_lastProgress) until we're sure.
          window._progressNoDataStreak = (window._progressNoDataStreak || 0) + 1;
          if (window._progressNoDataStreak >= 3) {
            clearInterval(window._progressPollTimer);
            window._progressPollTimer = null;
            window._progressNoDataStreak = 0;
            _scrapeActive = false;   // confirmed done → allow the strip to hide
            _lastProgress = null;
            _sawAnyProgress = false; // run over; a NEW dispatch may legitimately wait again
            renderPage(fresh);       // final render hides the bar
          }
          return; // don't hide bar yet
        }
        window._progressNoDataStreak = 0;
        if (fp.done !== _lastData?.scrape_progress?.done) {
          renderPage(fresh);
        }
      }, 7000);
    }
  } else if (!_scrapeActive) {
    // Only tear the poll timer down when no scrape is active. A transient no-progress
    // render mid-scrape must NOT stop polling (that would freeze the strip).
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


  // ── View mode branch ───────────────────────────────────────────
  _lastDisplayItems = allDisplayItems; // column filter dropdown's option pool
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
    const units = getUnits(item.list_item);
    // Multi-buy + qty aware winner (a "2 for $4" flips this once you buy 2), used
    // for Best, cell highlight, hot-deal fire, %-cheaper colour and the trend ref.
    const cheaper = mbCheaperStore(item);
    const ov = overrides[item.list_item] || {};

    const wwUrl  = ov.wwUrl    || ww?.url  || null;
    const coUrl  = ov.colesUrl || co?.url  || null;
    const displayName = ov.displayName || shortName(item.list_item);

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

    // % Cheaper - compares the EFFECTIVE per-unit prices at the current qty, so a
    // multi-buy changes the gap (and which store it favours) instead of freezing
    // on the sticker difference.
    const wwEff = mbEffUnit(ww, units);
    const coEff = mbEffUnit(co, units);
    let pctHtml = '';
    if (wwEff != null && coEff != null && Math.abs(wwEff - coEff) > 0.005) {
      const pct = Math.round(Math.abs(wwEff - coEff) / Math.max(wwEff, coEff) * 100);
      pctHtml = `<span class="${cheaper === 'woolworths' ? 'pct-ww' : 'pct-coles'}">${pct}%</span>`;
    }

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${esc(displayName)}${editBtn}</div>
          ${altHintHTML(item)}
        </div>
      </div>`;

    // Hot deal: fire goes on the cheaper store's price cell
    const hotDeal = isHotDeal(item, _renderExclusions);
    const hotBadge = `<span class="hot-badge" title="Hot Deal - meaningfully cheaper than its usual price right now">🔥</span>`;

    // Per-100g/ml - computed from product name (reliable for packs); falls back to scraped cup price
    const { ww: wwP100, coles: coP100 } = per100Pair(ww, co);

    // WW price cell
    let wwCellContent;
    if (ww) {
      // Once a multi-buy is live at the current qty, the PRICE itself becomes the
      // effective per-unit (green) - so a "cheaper" mark is self-explanatory
      // instead of $3.30 vs $3.30 with a mystery winner.
      const wwActive = !!(ww.multi_buy?.qty && ww.multi_buy.total != null && units >= ww.multi_buy.qty);
      const wwShown = wwActive ? multiBuyCost(units, ww.price, ww.multi_buy) / units : ww.price;
      const wwInner = wwUrl
        ? `<a href="${wwUrl}" target="_blank" rel="noopener" class="price-link">${fmt(wwShown)}</a>`
        : fmt(wwShown);
      const wwPriceVal = wwActive ? `<span class="mb-price">${wwInner}</span>` : wwInner;
      const wwFire = hotDeal && (cheaper === 'woolworths' || (cheaper == null && ww && !co)) ? hotBadge : '';
      const wwNameTip = ww.name ? ` title="${ww.name.replace(/"/g, '&quot;')}"` : '';
      // /100g follows the effective price too, so a $2.50 headline never sits above a sticker /100g.
      const wwUnitVal = (wwActive && wwP100.value != null) ? wwP100.value * (wwShown / ww.price) : wwP100.value;
      const wwUnitStr = wwUnitVal != null ? `$${wwUnitVal.toFixed(2)}/${wwP100.label}` : (wwP100.blanked ? '' : fmtUnit(ww.unit_price, ww.unit));
      // Tag rides on the PRICE line (green icon when live), not the unit line.
      wwCellContent = `<div class="price-main"${wwNameTip}>${wwPriceVal}${multiBuyTag(ww, units)}${wwFire}</div><div class="price-unit">${wwUnitStr}</div>`;
    } else {
      const searchUrl = `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}`;
      wwCellContent = `<a href="${searchUrl}" target="_blank" rel="noopener" class="search-link">Find on WW →</a>`;
    }

    // Coles price cell
    let coCellContent;
    if (co) {
      const coActive = !!(co.multi_buy?.qty && co.multi_buy.total != null && units >= co.multi_buy.qty);
      const coShown = coActive ? multiBuyCost(units, co.price, co.multi_buy) / units : co.price;
      const coInner = coUrl
        ? `<a href="${coUrl}" target="_blank" rel="noopener" class="price-link">${fmt(coShown)}</a>`
        : fmt(coShown);
      const coPriceVal = coActive ? `<span class="mb-price">${coInner}</span>` : coInner;
      const coFire = hotDeal && (cheaper === 'coles' || (cheaper == null && co && !ww)) ? hotBadge : '';
      const coNameTip = co.name ? ` title="${co.name.replace(/"/g, '&quot;')}"` : '';
      const coUnitVal = (coActive && coP100.value != null) ? coP100.value * (coShown / co.price) : coP100.value;
      const coUnitStr = coUnitVal != null ? `$${coUnitVal.toFixed(2)}/${coP100.label}` : (coP100.blanked ? '' : fmtUnit(co.unit_price, co.unit));
      coCellContent = `<div class="price-main"${coNameTip}>${coPriceVal}${multiBuyTag(co, units)}${coFire}</div><div class="price-unit">${coUnitStr}</div>`;
    } else {
      const searchUrl = `https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}`;
      coCellContent = `<a href="${searchUrl}" target="_blank" rel="noopener" class="search-link">Find on Coles →</a>`;
    }

    // Best Price - N/A when one store is missing
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

    const hasBothPrices = ww?.price != null && co?.price != null;
    let savingContent;
    if (!hasBothPrices) {
      savingContent = `<span class="no-data">-</span>`;
    } else {
      const unitsSaving = mbSaving(item) ?? 0;   // multi-buy + qty aware
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

    // Priority cell (uses analysis data as fallback). 'archive' is a real option
    // here - an archived item's dropdown must show "Archived" selected (it used
    // to silently default to "Weekly" with no visible indication, and the only
    // way back was a separate, easy-to-miss "↩ Unarchive" button in the actions
    // column - this makes archive/unarchive symmetric with the same control).
    const itemPriority = getPriority(item.list_item);
    const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${safeKey}">
      <option value="weekly"${itemPriority === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${itemPriority === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${itemPriority === 'rare' ? ' selected' : ''}>Rare</option>
      <option value="archive"${itemPriority === 'archive' ? ' selected' : ''}>Archived</option>
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

    // Two independent per-store totals: what this row costs at WW, and at Coles
    // (qty x price, multi-buy applied). The cheaper side is tinted, so you can
    // still read the winner at a glance without losing either number.
    const wwTotalVal = rowStoreTotal(item, 'ww');
    const coTotalVal = rowStoreTotal(item, 'coles');
    const totalCellFor = (v, isWin, cls) =>
      `<td class="total-cell ${isWin ? cls : ''}" style="font-size:13px;font-weight:600;white-space:nowrap">${
        v != null ? fmt(v) : '<span class="no-data">-</span>'}</td>`;
    const wwTotWin = wwTotalVal != null && coTotalVal != null && wwTotalVal < coTotalVal - 0.005;
    const coTotWin = wwTotalVal != null && coTotalVal != null && coTotalVal < wwTotalVal - 0.005;
    const scrapedDate = item.last_scraped
      ? new Date(item.last_scraped).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '-';

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
      ww_total:     totalCellFor(wwTotalVal, wwTotWin, 'cell-ww'),
      coles_total:  totalCellFor(coTotalVal, coTotWin, 'cell-coles'),
    };

    const checked = _checkedItems.has(item.list_item) ? ' checked' : '';
    const isPending = _pendingRefreshItems.has(item.list_item);
    const prevWw = _prevPrices[item.list_item]?.ww;
    const prevCo = _prevPrices[item.list_item]?.co;
    const priceChanged = (prevWw != null && prevWw !== ww?.price) || (prevCo != null && prevCo !== co?.price);
    const rowClass = isPending ? ' class="row-pending"' : (priceChanged ? ' class="row-flash"' : '');
    tbody.insertAdjacentHTML('beforeend', `<tr${rowClass} data-item="${safeKey}"><td class="check-cell"><input type="checkbox" class="row-check" data-item="${safeKey}"${checked}></td>${getVisibleCols().map(col => tdMap[col] || '').join('')}<td class="actions-cell">${unarchiveBtn}${watchBtn}${refreshBtn}</td></tr>`);

    _prevPrices[item.list_item] = { ww: ww?.price, co: co?.price };
    if (priceChanged && _pendingRefreshItems.has(item.list_item)) _pendingRefreshItems.delete(item.list_item);
  });

  // Tfoot - use the same banner stats so the desktop footer and mobile banner
  // always show identical basket totals (qty-weighted, items with both prices).
  // The WW/Coles PRICE columns show per-unit prices, so their footers sum those
  // (col_ww/col_coles). The basket cost per store lives in the W/C Total columns
  // and the top cards - a different, qty-weighted number by design.
  const footWWBase   = s.col_ww;
  const footCoBase   = s.col_coles;
  const _fWWAvail    = s.ww_data_available;
  const _fCoAvail    = s.items_compared > 0;
  // Each Total column sums ITS OWN store across every visible row (multi-buy +
  // qty aware), so "W Total" is the whole basket at Woolworths and "C Total" the
  // whole basket at Coles - two numbers you can actually compare.
  let _fWWTot = 0, _fCoTot = 0;
  for (const item of sorted) {
    _fWWTot += rowStoreTotal(item, 'ww') ?? 0;
    _fCoTot += rowStoreTotal(item, 'coles') ?? 0;
  }
  const footWWTot = Math.round(_fWWTot * 100) / 100;
  const footCoTot = Math.round(_fCoTot * 100) / 100;

  const tfootRow = document.querySelector('tfoot tr');
  if (tfootRow) {
    const footMap = {
      name:         `<td><div style="font-weight:700;white-space:nowrap">${sorted.length} product${sorted.length !== 1 ? 's' : ''}</div></td>`,
      trend:        `<td></td>`,
      priority:     `<td></td>`,
      units:        `<td></td>`,
      ww:           `<td id="footWW">${_fWWAvail ? fmt(footWWBase) : '-'}</td>`,
      coles:        `<td id="footColes">${_fCoAvail ? fmt(footCoBase) : '-'}</td>`,
      cheaper:      `<td></td>`,
      pct:          `<td></td>`,
      // No total: each row's saving belongs to whichever store wins THAT row, so
      // adding them up mixes money saved at Woolworths with money saved at Coles
      // and produces a number that describes no real shopping trip.
      saving:       `<td id="footSaving"></td>`,
      trips:        `<td></td>`,
      category:     `<td></td>`,
      last_scraped: `<td></td>`,
      ww_total:     `<td style="font-weight:700">${fmt(footWWTot)}</td>`,
      coles_total:  `<td style="font-weight:700">${fmt(footCoTot)}</td>`,
    };
    tfootRow.innerHTML = '<td></td>' + getVisibleCols().map(col => footMap[col] || '<td></td>').join('') + '<td></td>';
  }

  $('tableContainer').style.display = 'block';

  // Not-found items are now shown in the main table - hide the old separate section
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

  updateValidateNavBadge(pendingValidationCount(data?.pending_validation));
}

// ── Validate nav badge ────────────────────────────────────────────────────────

function updateValidateNavBadge(count) {
  const link = document.getElementById('validateNavLink');
  if (!link) return;
  link.style.display = count > 0 ? '' : 'none';
  // textContent would wipe the icon header.js already put there - update the
  // tooltip and a small corner count badge instead, same pattern as importBtn.
  link.title = count > 0 ? `Validate (${count} pending)` : 'Validate';
  let badge = link.querySelector('.validate-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'validate-badge';
    link.appendChild(badge);
  }
  badge.textContent = count;
}

// (The name-changes notification bell was retired - the validate pill is the
// single "data needs attention" surface. name_changes_detected.json is still
// written by the scraper; nothing reads it in the UI.)

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
  if (!window.XLSX) { alert('SheetJS not loaded - please reload the page.'); return; }

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

  // PUT - retry once on 409 with freshly fetched SHA
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
    // Stale SHA - re-fetch and retry once
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
      alert('Items added to your basket, but the scraper is offline - prices will update when the runner restarts.');
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
     <button class="col-chooser-reset-btn col-chooser-save-btn" id="saveColsBtnInner">
       <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
       Save Columns
     </button>
     <button class="col-chooser-reset-btn" id="resetColsBtnInner">
       <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3"/></svg>
       Reset Columns
     </button>`;
    // Wire up the footer buttons each time dropdown is rendered. Save is a
    // confidence affordance: choices already persist on every toggle, so this
    // just confirms + closes (and is where cross-device sync would hook in).
    dropdown.querySelector('#saveColsBtnInner')?.addEventListener('click', (e) => {
      e.stopPropagation();
      saveColVisibility();
      dropdown.style.display = 'none';
      showToast('Column layout saved');
    });
    dropdown.querySelector('#resetColsBtnInner')?.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = 'none';
      resetColumns();
    });
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = dropdown.style.display === 'none';
    closeHeaderDropdowns('colChooserDropdown');
    if (opening) {
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
      // Touching either Total column is an explicit choice - stop auto-managing
      // which one shows from here on, and never override it again.
      if (col === 'ww_total' || col === 'coles_total') {
        try { localStorage.setItem('pw_col_total_manual', '1'); } catch {}
      }
      saveColVisibility();
      if (_lastData) renderPage(_lastData);
    }
  });
}

// ── Column filter dropdown ────────────────────────────────────────────────────

let _cfdCol = null;
let _cfdAllValues = [];
let _cfdTempValues = null;
let _lastDisplayItems = []; // renderPage's item set incl. per-kg group rows

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

  // Excel semantics: offer only values present in the rows every OTHER filter
  // (view, category tab, other columns, search) lets through - not the whole
  // dataset, which listed options that couldn't select anything.
  const pool = _lastDisplayItems.length ? _lastDisplayItems : (_lastData.items || []);
  _cfdAllValues = [...new Set(applyFilters(pool, col).map(i => getColValue(col, i)))].sort((a, b) => {
    // Numeric sort for price/numeric-looking values; kg quantities ("1.0kg")
    // group after plain pack counts, mirroring the column's sort order.
    const ak = a.endsWith('kg'), bk = b.endsWith('kg');
    if (ak !== bk) return ak ? 1 : -1;
    const na = parseFloat(a.replace(/[$,]/g, '')), nb = parseFloat(b.replace(/[$,]/g, ''));
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  _cfdTempValues = existing ? new Set(existing) : new Set(_cfdAllValues);

  // Update sort labels - context-aware per column type
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

  // Columns with no meaningful discrete values - hide search/values section
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

// ── Options menu (row density only - the dropdown itself, its toggle and the
//    theme switcher are owned by header.js so they work identically on every
//    page; density is index-only because it styles the main table) ───────────

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
      // Reload the published data only - do NOT trigger a scrape. Scrapes are a
      // desktop action (need a token; run for many minutes); pull-down's job on a
      // phone is just "show me the latest numbers the scraper already produced".
      loadData().then((fresh) => { if (fresh) renderPage(fresh); });
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
  initStickyHeader();
  initUploadModal();
  initSearch();
  initDiffItemModal();
  initImgPicker();
  initCategoryEditModal();
  initPriorityFilter();
  initBulkBar();
  initColumnChooser();
  initColFilterDropdown();
  updateImportBadge();
  initPullToRefresh();

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerRefresh);

  // Floating "🛒 Basket (n)" - a cart badge: shows the basket count and opens
  // the basket page. The nav 🛒 links are plain navigation too - nothing dumps
  // items into the basket implicitly anymore; only explicit adds do.
  $('basketFab')?.addEventListener('click', () => { window.location.href = 'shopping-list.html'; });

  // Scrape strip dismiss & retry

  // ── View toggle ──────────────────────────────────────────────
  const viewToggleBtn = $('viewToggleBtn');
  // Bordered rows-in-a-frame icon - must stay visually distinct from the Columns button (bare lines + dots).
  const TABLE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="21" y2="15"/></svg>`;
  const CARD_ICON  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;
  function syncViewToggleBtn() {
    // Card view: the sticky site header adds nothing while browsing cards -
    // let it scroll away (body class drives `header { position: static }`).
    document.body.classList.toggle('pw-cardview', _viewMode === 'card');
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
      const manageBtn = e.target.closest('.price-bar-manage');
      if (manageBtn) { openHistoryFromManageBtn(manageBtn.dataset.manageItem); return; }
      const rowCheck = e.target.closest('.row-check');
      if (rowCheck) {
        const name = rowCheck.dataset.item;
        if (rowCheck.checked) _checkedItems.add(name); else _checkedItems.delete(name);
        updateBulkBar();
        return;
      }
      const editBtn = e.target.closest('.item-edit-btn');
      if (editBtn && _lastData) {
        const key = editBtn.dataset.editItem;
        if (key.startsWith('__group_')) { openCategoryEditModal(key.replace('__group_', '')); return; }
        const item = _lastData.items.find(i => i.list_item === key);
        if (item) openEditModal(item);
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
    });
    cardGrid.addEventListener('change', (e) => {
      const sel = e.target.closest('.priority-select');
      if (sel) {
        const pr = loadPriorities();
        if (sel.value) pr[sel.dataset.item] = sel.value;
        else delete pr[sel.dataset.item];
        savePriorities(pr);
        syncItemArchivedFlag(sel.dataset.item, sel.value === 'archive');
        if (_lastData) renderPage(_lastData);
        scheduleArchiveSync();
      }
    });
  }

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
      alert('No URL overrides found in local storage - nothing to sync.');
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
      alert(`⚠ Sync failed - check your token.\n${e.message}`);
      btn.textContent = 'Sync URL overrides';
      btn.disabled = false;
    }
  });

  $('scrapeStripDismiss')?.addEventListener('click', () => {
    _progressDismissed = true;
    // Persist the dismissal keyed on the run's id so ✕ survives a hard refresh
    // (the reported "keeps coming back" bug), plus spend the dispatch marker so
    // the strip doesn't pop back via another page's poller.
    markScrapeRunDismissed(_lastProgress || _lastData?.scrape_progress);
    try { localStorage.removeItem('pw_scrape_dispatched_v1'); } catch {}
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
  // Tapping a store total: desktop reveals that store's per-item total COLUMN;
  // mobile has no table, so instead re-sort the cards to surface where that store
  // wins (the C/W sort, pointed at that store) and scroll to the list. Previously
  // the mobile tap silently toggled a hidden column and looked broken.
  const _storeCardTap = (store) => {
    if (window.innerWidth <= 700) {
      _mobileSortMode = 'store';
      _mobileSortDir  = store === 'ww' ? 'desc' : 'asc'; // desc → WW-cheaper first
      if (_lastData) renderPage(_lastData);
      document.getElementById('mobileCards')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (store === 'ww') {
      _activateTotalCol('ww_total', 'coles_total');
    } else {
      _activateTotalCol('coles_total', 'ww_total');
    }
  };
  $('wwCard')?.addEventListener('click',    () => _storeCardTap('ww'));
  $('colesCard')?.addEventListener('click', () => _storeCardTap('coles'));

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
  // loadRemovedItems() runs alongside the rest so the deleted-name tombstones are
  // in REMOVED_ITEMS before the first sync/render - the sync filters read that set.
  await Promise.all([loadItemAnalysis(), initWatchlist(), initUserSettings(), mergeArchivedFromRepo(), loadRepoUrlOverrides(), loadRemovedItems()]);
  const data = await loadData();

  {
    renderPage(data);

    // $/kg pill (web): cycles all → only per-kg groups → hide per-kg groups.
    // Only the label span is swapped so the scales icon survives the cycle.
    const perkgBtn = $('perkgDevBtn');
    if (perkgBtn) {
      const PERKG_CYCLE = { all: 'only', only: 'hidden', hidden: 'all' };
      const PERKG_LABEL = { all: '$/kg', only: '$/kg only', hidden: '$/kg hidden' };
      perkgBtn.addEventListener('click', () => {
        _perkgFilter = PERKG_CYCLE[_perkgFilter];
        perkgBtn.classList.toggle('on', _perkgFilter === 'only');
        perkgBtn.classList.toggle('off', _perkgFilter === 'hidden');
        const lbl = perkgBtn.querySelector('.perkg-lbl');
        if (lbl) lbl.textContent = PERKG_LABEL[_perkgFilter];
        perkgBtn.title = { all: 'Showing everything - click to isolate per-kg groups',
                           only: 'Only per-kg groups - click to hide them',
                           hidden: 'Per-kg groups hidden - click to show everything' }[_perkgFilter];
        if (_lastData) renderPage(_lastData);
      });
    }

    const tbody = $('tableBody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        // Per-kg variant "＋" → add that exact product to the basket (the group toggle
        // below already ignores button clicks, so this won't collapse the panel).
        const pvBasket = e.target.closest('.vg-pv-basket');
        if (pvBasket) { addPerKgToBasket(pvBasket.dataset.item); return; }
        // Variant group expand/collapse - click ONLY the group header row toggles.
        // The expanded panel beneath (.vg-panel-row) is deliberately inert so a tap
        // on a variant / whitespace there doesn't collapse the panel out from under
        // you; collapse by clicking the same header row you opened.
        const groupRow = e.target.closest('.vg-group-row');
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
          const isKgBased = isKgQty(itemName); // kg steps for loose cuts, packs otherwise
          const isInc = incBtn.classList.contains('units-inc');
          const ov = loadUnitOverrides();
          const cur = getUnits(itemName);
          if (isKgBased) {
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
          triggerItemRefresh(rItem, refreshBtn, { wwUrl: pinnedUrlFor(rItem, 'ww'), colesUrl: pinnedUrlFor(rItem, 'coles') });
          return;
        }

        // Pending-item fetch button inside expanded category panel
        const fetchBtn = e.target.closest('.vg-pv-fetch');
        if (fetchBtn) {
          const itemName = fetchBtn.dataset.item;
          triggerItemRefresh(itemName, fetchBtn, { wwUrl: pinnedUrlFor(itemName, 'ww'), colesUrl: pinnedUrlFor(itemName, 'coles') });
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
        if (manageBtn) { openHistoryFromManageBtn(manageBtn.dataset.manageItem); return; }
      });

      // Priority dropdown changes
      tbody.addEventListener('change', (e) => {
        const sel = e.target.closest('.priority-select');
        if (sel) {
          const p = loadPriorities();
          p[sel.dataset.item] = sel.value;
          savePriorities(p);
          syncItemArchivedFlag(sel.dataset.item, sel.value === 'archive');
          if (_lastData) renderPage(_lastData);
          scheduleArchiveSync();
        }
      });
    }
  }

  // Mobile per-kg group cards (delegated; persists across innerHTML rebuilds).
  // Gesture model matches normal cards: tap the card = toggle the group's cheapest
  // variant in the basket; the chevron button = expand/collapse; History clock =
  // history modal; a variant row's "＋" = add that exact product.
  const mobileCardsEl = $('mobileCards');
  if (mobileCardsEl) {
    mobileCardsEl.addEventListener('click', (e) => {
      const bb = e.target.closest('.vg-pv-basket');
      if (bb) { addPerKgToBasket(bb.dataset.item); return; }
      // Group-card eye only: normal cards handle their own .mc-watch-btn in a
      // direct listener, so handling them here too would toggle twice (a no-op).
      const wb = e.target.closest('.vg-mobile-card .mc-watch-btn');
      if (wb) { toggleWatchlist(wb.dataset.item); return; }
      const manageBtn = e.target.closest('.price-bar-manage, .mc-hist-btn');
      if (manageBtn) { openHistoryFromManageBtn(manageBtn.dataset.manageItem); return; }
      const chev = e.target.closest('.vgm-chevron-btn');
      if (chev) {
        const key = chev.closest('.vg-mobile-card')?.dataset.group;
        if (!key) return;
        if (_expandedGroups.has(key)) _expandedGroups.delete(key);
        else _expandedGroups.add(key);
        if (_lastData) renderPage(_lastData); // renderPage preserves scroll itself
        return;
      }
      // Other links/buttons/images (product links, edit, image hover) handle themselves.
      if (e.target.closest('a, button, .img-hoverable')) return;
      // Whitespace inside the expanded variant list is inert - only the collapsed
      // card face is the tap-to-add surface.
      if (e.target.closest('.vgm-body')) return;
      const vgCard = e.target.closest('.vg-mobile-card');
      // Toggle the CATEGORY (group key) - the basket follows the group, not
      // whichever variant was cheapest on the day. dataset.cheapest still
      // gates the tap: a group with no priced variant has nothing to buy.
      if (vgCard && vgCard.dataset.cheapest) addPerKgToBasket('__group_' + vgCard.dataset.group);
    });
    // Keyboard: cards are focusable role=button divs - Enter/Space triggers the
    // same gesture as a tap. Only fires when the card ITSELF has focus; inner
    // real <button>/<a> elements handle their own keys natively.
    mobileCardsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.mobile-card');
      if (!card || e.target !== card) return;
      e.preventDefault(); // Space must not scroll the page
      card.click();
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
        persistUrlOverridesToRepo(_bootOvSettings, _bootOv).catch(err => {
          console.error('[PriceWatch] Boot-time URL overrides sync failed (will retry on next manual save):', err);
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
  // Close whichever modal is open - check in reverse stack order (topmost first)
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
