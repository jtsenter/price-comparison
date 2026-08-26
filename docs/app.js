// ── Utilities ────────────────────────────────────────────────────────────────

// Runs before anything else reads pw_perkg_cats_v1 (rendering via utils.js'
// loadVariantGroups, or syncing via loadVariantGroupOverrides below) - a device
// still holding the corrupted override was re-publishing it over any server-side
// fix every few minutes from an already-open tab. See repairKnownCategoryCorruption
// in utils.js for the full incident writeup; this is its only call site.
try {
  const raw = localStorage.getItem('pw_perkg_cats_v1');
  if (raw) localStorage.setItem('pw_perkg_cats_v1', JSON.stringify(repairKnownCategoryCorruption(JSON.parse(raw))));
} catch {}

const $ = (id) => document.getElementById(id);
// fmt() lives in utils.js - one formatter, grouped thousands, whole site.

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
// Short telegram display name (from name_map.js); falls back to stripWW.
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

// clientPer100(), clientPerKg() and perKgRatio() are provided by utils.js
// (loaded before app.js in index.html). The last two moved there because
// history-modal.js calls perKgRatio and is loaded by hot-deals.html, which does
// NOT load app.js - opening a per-kg member's history from that page threw
// "perKgRatio is not defined" for as long as both lived here.

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
// histOnly: leave TODAY's prices out, so the caller gets the same "past" series
// calcTrendPosition measures against. Mixing the current price into the range is
// what pinned every group at position 0 - see groupTrendPosition.
function memberPerKgPrices(m, useWw = true, useCo = true, histOnly = false) {
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
  if (!histOnly) {
    if (useWw) { const wk = clientPerKg(m.woolworths); if (wk != null) out.push(wk); }
    if (useCo) { const ck = clientPerKg(m.coles);      if (ck != null) out.push(ck); }
  }
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
// Watching a category member watches the CATEGORY - one entry, not one per
// variant. Both read and write go through settingsKeyFor() so the eye can never
// show "off" on a member of a watched category, or leave a stale per-member
// entry behind when membership changes.
// Named ...Item, not isWatched: two group renderers already keep a local
// `const isWatched`, and shadowing this would be a silent trap.
function isWatchedItem(itemName) {
  return _watchlist.has(settingsKeyFor(itemName));   // utils.js
}
function toggleWatchlist(itemName) {
  const key = settingsKeyFor(itemName);
  if (_watchlist.has(key)) _watchlist.delete(key);
  else _watchlist.add(key);
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
    // Category MEMBERSHIP + renames (pw_perkg_cats_v1, written by Edit category).
    // This was the one settings map that never left the device: adding a product
    // to a category on the phone left the computer showing the old membership,
    // which is a large part of why "adding a product" looked like it never
    // worked. Keyed by category, not by item, so it needs no REMOVED_ITEMS pass.
    perkgCats: loadVariantGroupOverrides(),
    // Custom lists. Keyed by list, not by item, so no REMOVED_ITEMS pass is
    // needed on the map itself - but a tombstoned product could still sit in a
    // membership array, so those are filtered.
    lists: (() => {
      const out = {};
      for (const [k, l] of Object.entries(loadLists())) {
        out[k] = { ...l, items: (l.items || []).filter(n => !REMOVED_ITEMS.has(n)) };
      }
      return out;
    })(),
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
        // Category membership/renames. Merged per CATEGORY (same precedence as
        // priorities) rather than per member: the stored shape is a whole
        // {add, remove, label} patch per category, so a half-merged one would
        // resurrect a member the other device deliberately pulled out.
        if (remote.perkgCats && typeof remote.perkgCats === 'object') {
          localStorage.setItem('pw_perkg_cats_v1',
            JSON.stringify(merge(loadVariantGroupOverrides(), remote.perkgCats)));
        }
        // Lists merge per LIST, same precedence as priorities. Per-list and not
        // per-member for the same reason perkgCats is: the stored unit is a whole
        // list, so half-merging one would resurrect a product the other device
        // deliberately unticked.
        if (remote.lists && typeof remote.lists === 'object') {
          localStorage.setItem(LISTS_KEY, JSON.stringify(merge(loadLists(), remote.lists)));
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

// loadUnitOverrides() lives in utils.js - the basket reads the same quantities.
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
  // A member belongs to its category in every sense, frequency included, so the
  // CATEGORY's answer wins outright - not "only when the member has none". Its
  // own entry (and the trip-count guess below) is deliberately skipped.
  const gKey = settingsKeyFor(itemName);          // utils.js
  if (gKey !== itemName) return loadPriorities()[gKey] || 'weekly';
  const p = loadPriorities()[itemName];
  if (p) return p;  // explicit user override always wins
  const d = getAnalysisData(itemName);
  const trips = d.trip_count || 0;
  if (trips >= 7) return 'weekly';
  if (trips >= 3) return 'monthly';
  return d.priority || 'rare';
}

function getUnits(itemName) {
  // Category rows defer to groupUnits() (utils.js) so the basket, which has no
  // access to _perkgSet or the analysis data, plans them at the same quantity.
  if (typeof itemName === 'string' && itemName.startsWith('__group_')) return groupUnits(itemName);
  const ov = loadUnitOverrides()[itemName];
  if (ov != null) return ov;
  if (_perkgSet.has(itemName)) return 1.0;
  const qty = getAnalysisData(itemName).avg_qty;
  return qty != null ? Math.round(qty) : 1;
}

// Kg-quantity rows: loose per-kg entries (meat/seafood cuts, _perkgSet items) -
// their Units value means KILOGRAMS, not a pack count. Unit-based groups
// (Nutella, potato bags, yoghurt tubs...) count discrete packs like normal items.
// "Measured, not counted" - the question every caller here is really asking, so
// a 100g-quoted category counts too. It steps in fractions and sorts as a
// continuous value exactly like a kilo row; only the label differs.
function isKgQty(itemName) {
  const k = qtyKind(itemName);
  return k === 'kg' || k === 'g';
}

// How a row counts quantity: 'kg' (weighed), 'pieces' (a per-piece category,
// counted in the pieces it QUOTES - 100 wipes, not 1), or 'packs'.
//
// perPack is tested FIRST and beats sticker. Every per-piece category is also a
// sticker one, so the sticker test below was claiming them as pack-counted rows
// and they measured in kilos: dishwashing tablets and garbage bags showed
// "1.0 kg" in the Units box. A row whose price reads "/100" counts pieces.
function qtyKind(itemName) {
  if (typeof itemName !== 'string') return 'packs';
  const k = itemName.startsWith('__group_') ? itemName.slice(8) : null;
  if (k && perPackQuotes().has(k)) return 'pieces';
  const packGroup = k && (UNIT_BASED_GROUPS.has(k) || stickerGroups().has(k)); // bought as packs
  if (!packGroup && (_perkgSet.has(itemName) || itemName.startsWith('__group_'))) {
    // A weighed category quoted per 100g counts 100g units, not kilos - same
    // rule as per-piece: the quantity is denominated in whatever the price is.
    return (k && gramQuotes().get(k)) === 100 ? 'g' : 'kg';
  }
  return 'packs';
}

// key -> grams quoted, for every weighed category that is NOT on the $/kg
// default. Derived live for the same reason stickerGroups() and perPackQuotes()
// are: the setting is editable, so a snapshot lets the Units column count one
// thing while the price column quotes another.
function gramQuotes() {
  return new Map(loadVariantGroups()
    .filter(g => !g.perPack && !g.sticker)
    .map(g => [g.key, weightQuoteOf(g)]));
}

// Pieces one unit of quantity buys, for the Units label and the basket.
function qtyPiecesForName(itemName) {
  const k = typeof itemName === 'string' && itemName.startsWith('__group_') ? itemName.slice(8) : null;
  return (k && perPackQuotes().get(k)) || 1;
}

// The Units control's text for any row, in one place so the table, the card and
// the basket cannot label the same quantity differently.
function unitsLabel(itemName, units) {
  return qtyLabel(units, qtyKind(itemName), qtyPiecesForName(itemName));
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
  // A member takes its category's category - same reason as getPriority(). The
  // Biscoff 720g jar was resolving to Pantry while the Lotus Biscoff category it
  // sits in is Sweets.
  const g = variantGroupOf(item.list_item);       // utils.js
  if (g) return normalizeCategory(g.category || GROUP_DEFAULT_CATEGORY);
  const raw = loadCategoryOverrides()[item.list_item]
    || ITEM_CATEGORY_DEFAULTS[item.list_item]
    || item.category;
  return normalizeCategory(raw);
}

// ── Third stores (Chemist Warehouse / Priceline) ─────────────────────────────
// Strictly an add-on. An item with no entry in third_store.json renders exactly
// as it always did - no chip, no panel, no change to any column. Nothing here
// touches the winner badge, the Save figure or a basket total: Woolworths vs
// Coles stays THE comparison and this only reports what a third shop charges.
let _thirdStores = {};             // list_item -> [entry, ...]
const _thirdOpen = new Set();      // list_items the user explicitly EXPANDED
const _thirdClosed = new Set();    // list_items the user explicitly COLLAPSED

// Thin wrappers binding this module's two Sets to the pure resolvers in
// utils.js (thirdOpenState / thirdToggleState), where the tri-state rule and
// its self-check live.
function isThirdOpen(key, beats) { return thirdOpenState(key, beats, _thirdOpen, _thirdClosed); }
function toggleThird(key, beats) { thirdToggleState(key, beats, _thirdOpen, _thirdClosed); }

async function initThirdStores() {
  try {
    const res = await fetch(`data/third_store.json?t=${Date.now()}`);
    if (!res.ok) return;                       // absent file = feature simply off
    const raw = await res.json();
    if (raw && typeof raw === 'object') {
      delete raw._readme;
      _thirdStores = raw;
    }
  } catch { /* unreadable = feature off, never a broken page */ }
}

function thirdEntriesFor(itemName) {
  const e = _thirdStores[itemName];
  return Array.isArray(e) ? e.filter(x => x && x.price != null) : [];
}

// The chip that sits after the ✎. Quiet when a third store merely exists; loud,
// naming the shop and its price, when one undercuts BOTH supermarkets - so the
// column can be scanned for "worth opening" without opening anything.
//
// Takes `entries` directly rather than deriving them from `key` internally, so
// a group row can pass its MERGED entries (every member's third-store data
// combined) while a plain row passes just its own - one renderer, two sources.
//
// `compareUnit`: for a per-kg/per-pack CATEGORY, ww/co arrive as a per-unit
// metric (dollars per nappy), not a raw pack price - thirdBeatsUnit compares
// unit-to-unit instead of thirdBeats' raw-shelf comparison. Plain items default
// to false, unchanged from before this parameter existed.
function thirdChipHTML(key, entries, ww, co, compareUnit, group) {
  if (!entries.length) return '';
  const beat = compareUnit
    ? thirdBeatsUnit(entries, ww?.price, co?.price)    // utils.js
    : thirdBeats(entries, ww?.price, co?.price);       // utils.js
  const open = isThirdOpen(key, beat);
  const meta = beat ? THIRD_STORES[beat.store] : null;
  // The chip has to show the SAME figure the comparison was made on - raw shelf
  // price normally, but the per-unit price (what actually won) when compareUnit
  // is set, or "Chemist Warehouse $13.99" would misreport a per-nappy verdict.
  const beatPrice = beat && compareUnit ? thirdUnitPrice(beat)?.value : beat?.price;
  // Match the FORMAT to the scale picked just above: a per-unit winner needs the
  // metric formatter, or the chip rounds 2.9c and 3.2c to the same "$0.03" and
  // silently claims a tie the panel below it disagrees with.
  const beatText = beatPrice == null ? ''
    : (compareUnit ? fmtUnitMetric(metricShown(group, beatPrice)) : fmt(beatPrice));
  // The shop's COLOURED LETTER, not its name. "＋12 · Chemist Warehouse $2.86"
  // wrapped onto a second line and stretched the whole product column; the badge
  // says the same thing in one character, and the full name is still in the
  // tooltip and on the panel heading below.
  const badge = beat && meta
    ? `<span class="third-chip-b" style="${thirdChipStyle(beat.store)}">${esc(meta.letter)}</span>`
    : '';
  const label = beat && meta && beatPrice != null
    ? `${badge}${beatText} <span class="third-chip-n">＋${entries.length}</span>`
    : `＋${entries.length}`;
  // data-third-beats lets the click handler resolve the same default this render
  // used, without re-deriving prices from a different scale than the one the
  // chip was built with (see isThirdOpen).
  return `<button class="third-chip${beat ? ' beats' : ''}${open ? ' open' : ''}"` +
         ` data-third="${escAttr(key)}"${beat ? ' data-third-beats="1"' : ''}` +
         ` title="${beat ? 'Cheaper at ' + esc(meta.label) : 'Also sold at other stores'}">` +
         `${label} <span class="third-caret">${open ? '▴' : '▾'}</span></button>`;
}

// One .vg-pv row (image, linked name, price) - the shared building block for
// every store column, W/C/third alike, so a supermarket entry and a
// third-store entry are visually the SAME kind of thing, not a special case.
function thirdPvRowHTML(chipCls, letter, name, price, url, img, extraTag, isBest) {
  if (price == null) {
    return `<div class="vg-pv empty"><span class="vg-pv-img vg-pv-noimg"></span>` +
           `<span class="vg-pv-name">Not stocked</span></div>`;
  }
  const imgHtml = img
    ? `<img class="vg-pv-img" src="${escAttr(img)}" alt="" loading="lazy" />`
    : '<span class="vg-pv-img vg-pv-noimg"></span>';
  const chip = letter ? `<span class="store-chip ${chipCls} sm">${letter}</span> ` : '';
  const unit = extraTag ? `<span class="third-tag">${extraTag}</span>` : '';
  const label = `${chip}${esc(name || '-')}${unit}`;
  const nameHtml = url
    ? `<a class="vg-pv-name" href="${escAttr(url)}" target="_blank" rel="noopener">${label}</a>`
    : `<span class="vg-pv-name">${label}</span>`;
  return `<div class="vg-pv${isBest ? ' win' : ''}">${imgHtml}${nameHtml}` +
         `<span class="vg-pv-kg">${fmt(price)}</span></div>`;
}

// The "other stores" column's inner rows, ranked cheapest first. `bestPrice`
// comes from whoever is calling this - a plain item's own W/C prices, or a
// group's cheapest member - so "win" highlighting is relative to the SAME
// comparison the surrounding panel is already making, not a third-store-only one.
//
// `compareUnit`: a per-kg/per-pack CATEGORY's bestPrice is a per-unit metric, not
// a raw shelf price (see thirdBeatsUnit's comment) - highlighting must compare
// unit-to-unit there too, or a cheap-per-nappy alternative could never light up
// against its own $13.99-for-forty shelf price. Plain items default to false and
// keep comparing raw price, exactly as before this parameter existed.
function thirdOthersColumnHTML(entries, bestPrice, fallbackImg, compareUnit) {
  const isBest = (p) => p != null && bestPrice != null && p <= bestPrice + 0.0001;
  return thirdRanked(entries).map(e => {
    const meta = THIRD_STORES[e.store] || { letter: '?', label: e.store };
    const u = thirdUnitPrice(e);
    return thirdPvRowHTML('third', meta.letter, e.name, e.price, e.url,
      resolveImgUrl(e.image) || fallbackImg, u ? `${fmt(u.value)}${u.label === 'each' ? ' each' : '/' + u.label}` : '',
      isBest(compareUnit ? u?.value : e.price));
  }).join('');
}

// One panel row, styled with the per-kg category classes so an expanded item and
// an expanded category look identical. Three columns: W, C, and ONE column for
// every other shop combined - two near-empty columns would cost table width for
// nothing. Used for a PLAIN item that isn't part of a category - a category's own
// third column instead renders inline inside its existing panel (see
// groupThirdColumnHTML), since that panel already exists and opens on the same click.
function thirdPanelRowHTML(key, entries, ww, co, colspan) {
  const ranked = thirdRanked(entries);   // utils.js
  if (!ranked.length) return '';

  const prices = [ww?.price, co?.price, ...ranked.map(e => e.price)].filter(p => p != null && p > 0);
  const bestPrice = prices.length ? Math.min(...prices) : null;
  const isBest = (p) => p != null && bestPrice != null && p <= bestPrice + 0.0001;

  // Same shape as a per-kg category member row: thumbnail, name that links to the
  // product page, then the price. A third store has no image of its own, so it
  // borrows the supermarket photo of the SAME product rather than showing a hole.
  const wwImg = resolveImgUrl(ww?.image_url) || '';
  const coImg = resolveImgUrl(co?.image_url) || '';

  const beat = thirdBeats(entries, ww?.price, co?.price);
  const bm = beat ? THIRD_STORES[beat.store] : null;
  const verdict = beat && bm
    ? `<span class="vg-panel-winner third">${esc(bm.label)} cheapest</span>`
    : `<span class="vg-panel-winner ww">Cheaper at your usual shops</span>`;

  return `<tr class="vg-panel-row third-panel-row"><td colspan="${colspan}"><div class="vg-panel">
      <div class="vg-panel-head"><span class="vg-panel-title">Also sold at</span>${verdict}</div>
      <div class="vg-panel-cols third-cols">
        <div class="vg-panel-store">${thirdPvRowHTML('ww', 'W', ww?.name, ww?.price, pinnedUrlFor(key, 'ww') || ww?.url, wwImg, '', isBest(ww?.price))}</div>
        <div class="vg-panel-store">${thirdPvRowHTML('coles', 'C', co?.name, co?.price, pinnedUrlFor(key, 'coles') || co?.url, coImg, '', isBest(co?.price))}</div>
        <div class="vg-panel-store">${thirdOthersColumnHTML(entries, bestPrice)}</div>
      </div>
      <div class="vg-panel-note">Other shops are shown for reference only - they never change the winner, the saving or any basket total.</div>
    </div></td></tr>`;
}

// The collapsed chip for a CATEGORY row. Wraps thirdChipHTML with the group's
// own metric as ww/co - see thirdChipHTML's compareUnit doc for why a category
// can't just reuse the plain-item call unchanged. Metric-scale comparison only
// applies to a sticker/perPack group; a true $/kg group gets no beats-check at
// all (see the identical guard on the panel's own third column) rather than a
// wrong one - no weighed category has third-store data yet.
function groupThirdChipHTML(group) {
  const s = groupThirdScale(group);
  return thirdChipHTML(group.list_item, groupThirdEntries(group), s.ww, s.co, s.perUnit, group);
}

// Third-store rows built to the SAME shape as a Woolworths/Coles variant row -
// image, linked name, grey shelf price, bold metric price - and grouped under a
// per-store header, so Priceline sits exactly where Woolworths sits rather than
// in a shape of its own. Two things this fixes over the generic renderer:
//   - the bold price is the CATEGORY's metric ($0.35 each), not the pack price
//     ($13.99), which is what the W and C rows beside it are showing;
//   - no per-100g badge on a sticker category - one deodorant's price is the
//     price of one deodorant.
// A third store has no photo of its own, so it borrows the category's, the same
// way the desktop panel does, rather than leaving a hole.
// How many products to show per outside store before folding the rest away.
// One: the only thing a reference shop needs to say at a glance is its best
// price. Its runner-up is one click away and was mostly just making the column
// taller than the two supermarket columns beside it.
const THIRD_ROWS_PER_STORE = 1;

function groupThirdRowsHTML(group, entries, bestMetric, fallbackImg, frame) {
  const suffix = group._metricSuffix ?? (group._sticker ? '' : '/kg');
  const byStore = new Map();
  for (const e of entries) {
    if (!byStore.has(e.store)) byStore.set(e.store, []);
    byStore.get(e.store).push(e);
  }
  // Cheapest SHOP first, ranked on its own best product - so when ALDI has the
  // best price in the category you see ALDI at the top, not wherever it happened
  // to sit in the file. A shop with nothing priced sorts last rather than first.
  const shopBest = (list) => Math.min(...list.map(e => {
    const m = thirdGroupMetric(group, e);
    return m == null ? Infinity : m;
  }));
  return [...byStore.entries()]
    .sort((a, b) => shopBest(a[1]) - shopBest(b[1]))
    .map(([storeKey, list]) => {
    const meta = THIRD_STORES[storeKey] || { letter: '?', label: storeKey };
    const rowHtml = ({ e, m }) => {
        const img = resolveImgUrl(e.image) || fallbackImg;
        const imgHtml = img
          ? `<img class="vg-pv-img" src="${escAttr(img)}" alt="" loading="lazy" />`
          : '<span class="vg-pv-img vg-pv-noimg"></span>';
        const nameHtml = e.url
          ? `<a class="vg-pv-name" href="${escAttr(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a>`
          : `<span class="vg-pv-name">${esc(e.name)}</span>`;
        // Same slot split as a W/C row: grey pack price only where the metric
        // isn't already the pack price (a sticker category would print it twice).
        const pack = group._sticker ? '' : (e.price != null ? fmt(e.price) : '');
        // bestMetric here is already the cheapest across ALL columns, so this
        // row wins outright - same tag the W/C columns use, so the category has
        // exactly one "CHEAPEST" no matter which shop it lands in.
        const isWin = m != null && bestMetric != null && m <= bestMetric + 0.0001;
        // The green mark and the frame answer different questions. `win` is
        // "cheapest among the columns this panel scores together"; the frame is
        // "cheapest full stop", and an outside store can only claim it when its
        // rate is on the category's own scale - never on a weighed category,
        // where its per-100g figure is a different unit (frame.includesThird).
        const isTop = !!frame && frame.includesThird && !frame.tied
          && frame.best != null && m != null && m <= frame.best + 0.0001;
        return `<div class="vg-pv${isWin ? ' win' : ''}${isTop ? ' vg-top' : ''}">
            ${imgHtml}
            ${nameHtml}
            <span class="vg-pv-pack">${pack}</span>
            <span class="vg-pv-kg">${m != null ? fmtUnitMetric(metricShown(group, m)) + suffix : fmt(e.price)}</span>
          </div>`;
    };
    // Cheapest first, then show only the best few. Four stores x every size they
    // stock made this column three times the height of the Woolworths one, and
    // the 5th-dearest option at a shop you are not going to is not a decision
    // you are making. The rest stay one click away.
    // <details> rather than a button + handler: native disclosure is keyboard-
    // and screen-reader-operable for free, and the panel's rows are not inside
    // a tr[data-item], so nothing here collides with the row click that opens
    // and closes this very panel.
    const sorted = list
      .map(e => ({ e, m: thirdGroupMetric(group, e) }))
      .sort((a, b) => (a.m ?? Infinity) - (b.m ?? Infinity));
    const head = sorted.slice(0, THIRD_ROWS_PER_STORE).map(rowHtml).join('');
    const rest = sorted.slice(THIRD_ROWS_PER_STORE);
    const more = rest.length
      ? `<details class="vg-more"><summary class="vg-more-sum"><span class="vg-more-ic"></span>${rest.length} more at ${esc(meta.label)}</summary>${rest.map(rowHtml).join('')}</details>`
      : '';
    return `<div class="vg-store-h"><span class="store-chip third sm" style="${thirdChipStyle(storeKey)}">${esc(meta.letter)}</span> ${esc(meta.label)}</div>${head}${more}`;
  }).join('');
}

// groupThirdScale / groupThirdBeat live in utils.js - pure, and covered by the
// self-check, because picking the wrong scale fails SILENTLY (a cheaper store
// just reads as dearer).

// Every third-store entry attached to any member of this category, merged into
// one list - a category compares different PRODUCTS already (that is the whole
// point), so its "also sold at" naturally spans whichever of its members has
// outside-store data, not just one. A group-level key (__group_<key>) is also
// checked, for an alternative that does not map 1:1 to any existing member.
function groupThirdEntries(group) {
  const own = thirdEntriesFor('__group_' + group._groupKey);
  const fromMembers = (group._members || []).flatMap(m => thirdEntriesFor(m.list_item));
  return [...own, ...fromMembers];
}

// ── Filter state ─────────────────────────────────────────────────────────────

// 'weekly' | 'monthly' | 'rare' | 'archive' | 'all' | 'watchlist' | 'list:<key>'
// A custom list rides in the SAME slot as the frequency pills rather than adding
// a second filter dimension. That is deliberate: a list is a hand-picked set, so
// intersecting it with "Weekly" would hide products you explicitly put in it and
// read as the list being wrong. Selecting one shows exactly its members, the way
// the watchlist filter already behaves.
let _activePriority = 'weekly';

const LIST_FILTER_PREFIX = 'list:';
function activeListKey() {
  return _activePriority.startsWith(LIST_FILTER_PREFIX)
    ? _activePriority.slice(LIST_FILTER_PREFIX.length) : null;
}
// Is this row in the selected list? A category row has no name of its own that a
// list can hold, so it counts as in the list when ANY of its members is - filing
// "Chicken Breast Large Pack" into a list should not make the Chicken Breast
// category row vanish from that list's view.
function itemInActiveList(item) {
  const key = activeListKey();
  if (!key) return true;
  const l = loadLists()[key];
  if (!l) return false;
  const members = new Set(l.items || []);
  if (item._isGroup) return (item._members || []).some(m => members.has(m.list_item));
  return members.has(item.list_item);
}

let _searchQuery = '';
let _perkgSet = new Set();   // items compared by $/kg (synced via user_settings.json)
// Store filter: null | 'woolworths' | 'coles'. "I'm in this store - what is
// actually cheaper HERE?" Cycles off -> W -> C -> off from one button.
// Session-only on purpose: it answers a question about where you are standing
// right now, so it must not silently survive into next week's planning.
let _storeFilter = null;
// off -> W -> C -> off. One function so the phone chip and the desktop pill can
// never disagree about the order or forget to re-render.
const STORE_FILTER_CYCLE = [null, 'woolworths', 'coles'];
function cycleStoreFilter() {
  const i = STORE_FILTER_CYCLE.indexOf(_storeFilter);
  _storeFilter = STORE_FILTER_CYCLE[(i + 1) % STORE_FILTER_CYCLE.length];
  if (_lastData) renderPage(_lastData);
}
let _perkgFilter = 'all';  // per-kg group visibility: 'all' | 'only' | 'hidden' (⚙ /kg button cycles)

// DEFAULT_VARIANT_GROUPS (the per-kg category seed) lives in utils.js so the
// basket page can exclude group members without loading all of app.js.

// Effective categories = seed defaults merged with the user's saved label/membership
// overrides (pw_perkg_cats_v1). Returns a fresh array each call.
// migratePerKgOverride / computePerKgItems / loadVariantGroups / resolveStoreLists
// live in utils.js - the basket builds the same category rows from them.
function loadVariantGroupOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch { return {}; }
}
function saveVariantGroupOverride(key, patch) {
  let ov = loadVariantGroupOverrides();
  const def = DEFAULT_VARIANT_GROUPS.find(d => d.key === key);
  const cur = migratePerKgOverride(ov[key], def ? def.items : []); // upgrade legacy in place
  ov[key] = { ...cur, ...patch, v: 2 };
  delete ov[key].items; delete ov[key].ww_items; delete ov[key].coles_items; // strip legacy snapshot keys
  localStorage.setItem('pw_perkg_cats_v1', JSON.stringify(ov));
  scheduleUserSettingsSync();   // publish membership so the other device sees it
}
// loadPerKgExclusions() lives in utils.js (the basket honours the same exclusions).
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
  window.pwSyncBasketBadge?.();   // header.js - basket count on the 🛒 nav icon
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
    // Custom lists too, or a deleted product lingers as a phantom member and its
    // list keeps counting it.
    names.forEach(n => purgeItemFromLists(n));
    renderListPills();
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
  // Every selection change lands here - a row tick, a bulk action, Deselect all -
  // so it is the one place that can keep the header's "select all" box honest
  // without a full re-render. Ticking two rows while scrolled down otherwise left
  // the pinned header showing an empty box until something happened to re-clone it.
  syncCheckAllState();
  // In the Archived view the archive button is a no-op (they're already
  // archived) - flip it to "Unarchive". Also hide the Priority chip there: it
  // only offers weekly/monthly/rare, which would silently unarchive anyway, so
  // Unarchive is the clear single action.
  const inArchive = _activePriority === 'archive';
  const archBtn = bar.querySelector('.bt-archive');
  if (archBtn) archBtn.innerHTML = inArchive ? '📤 Unarchive' : '🗄 Archive';
  // The Lists chip stays visible in the Archived view now that Unarchive lives
  // inside its menu - hiding it there would make unarchiving unreachable.
  const priChip = bar.querySelector('.bt-pri');
  if (priChip) priChip.style.display = '';
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
    case 'cheaper':      return CHEAPER_SORT_LABEL[rowCheaperStore(item)] ?? 'N/A';  // same verdict the chip and sort use
    case 'pct': {
      const ww = item.woolworths?.price, co = item.coles?.price;
      if (ww == null || co == null) return '-';
      return Math.round(Math.abs(ww - co) / Math.max(ww, co) * 100) + '%';
    }
    case 'saving':       { const s = savingAmount(item); return s > 0 ? fmt(s * getUnits(item.list_item)) : '-'; }
    case 'trips':        return String(item.trip_count || 0);
    // Kg rows filter as "1.0kg" (their real meaning), pack rows as plain counts.
    case 'units':        { const u = getUnits(item.list_item); return unitsLabel(item.list_item, u); }
    case 'category':     return getCategory(item);
    case 'last_scraped': {
      const ts = item._isGroup ? groupLastScraped(item) : item.last_scraped;
      return ts ? new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
    }
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
    // Chip only, no store name spelled out - the header row was too wide.
    // title carries the name that used to be inline text, same as every other
    // store chip in the app (row cells, the ➕ other-stores column).
    case 'ww':           return th('ww', '', '<span class="store-chip ww sm" title="Woolworths">W</span>');
    case 'coles':        return th('coles', '', '<span class="store-chip coles sm" title="Coles">C</span>');
    // 2026-07-20: all header text left-aligned (user request) - cells keep
    // their own center/right alignment, only the th labels line up left.
    case 'cheaper':      return th('cheaper', '', 'Cheaper');
    case 'pct':          return th('pct', '', 'Diff');
    case 'saving':       return th('saving', '', 'Savings');
    case 'trips':        return th('trips', '', 'Times bought');
    case 'priority':     return th('priority', '', 'Priority');
    case 'units':        return th('units', '', 'Qty');
    case 'category':     return th('category', '', 'Category');
    case 'last_scraped': return th('last_scraped', '', 'Last scraped');
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
// buildPriceBar() lives in utils.js - hot-deals draws the identical bar.


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
        // A category refresh sends "A|B|C" as one dispatch. Mark each MEMBER
        // pending, not the joined string - checkPendingItemRefresh matches a
        // marker against list_item, so the joined key would never resolve and
        // the "re-scraped" toast would never fire.
        for (const n of itemName.split('|').filter(Boolean)) m[n] = Date.now();
        localStorage.setItem('pw_pending_refresh', JSON.stringify(m));
      } catch {}
      if (btn) pollItemRefresh(s, btn, itemName.split('|')[0]);
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
      notifyIfFiltered(name);
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

// A newly added item has no frequency yet, so the default "Weekly" view filters
// it straight out: the scrape succeeds, nothing appears on screen, and it reads
// as "adding products doesn't work". (Real case 2026-08-03 - a Coles-pinned
// Biscoff jar scraped fine at $12.00 and was invisible until the dropdown was
// switched to All items.) Say so, and offer one click to reveal it.
//
// Deferred a tick because both callers fire from inside renderPage, BEFORE the
// rows exist - checking the DOM synchronously would always report "hidden".
// ponytail: DOM presence is the visibility test rather than re-deriving the
// filter predicate - it catches the category and search filters for free, and
// can't drift from whatever renderPage actually did.
function notifyIfFiltered(itemName) {
  setTimeout(() => {
    const own = `[data-item="${CSS.escape(itemName)}"]`;
    if (document.querySelector(own)) return;   // visible in its own right

    // Instant, not smooth: the row can be 8000px down an unfiltered list, and a
    // smooth scroll that long never arrived (measured).
    const scrollTo = (sel) => {
      if (sel) document.querySelector(sel)?.closest('tr, .item-card')?.scrollIntoView({ block: 'center' });
    };

    // A per-kg / sticker group member has no row of its own BY DESIGN - the
    // group row stands in for it. Saying "the filter is hiding it" would be
    // false, and switching the filter wouldn't produce a row either. This is
    // the case that made the Woolworths 720g Biscoff jar look like it never
    // saved: it was folded into the "Lotus Biscoff" row the whole time.
    const grp = (typeof loadVariantGroups === 'function' ? loadVariantGroups() : [])
      .find(g => (g.items || []).includes(itemName));
    const grpSel = grp ? `[data-item="__group_${grp.key}"]` : null;

    if (grpSel && document.querySelector(grpSel)) {
      showUndoToast(
        `"${stripWW(itemName)}" was updated. It has no row of its own - it counts inside the ${grp.label} category.`,
        () => scrollTo(grpSel), 9000, 'Show that');
      return;
    }

    showUndoToast(
      `"${stripWW(itemName)}" was updated, but the ${_activePriority} filter is hiding it.`,
      () => {
        // The pill is the canonical control - its handler also syncs the mobile
        // freqSelect dropdown, so going through it keeps both in step. Its
        // re-render is synchronous, so the row is queryable on the next line.
        document.querySelector('.priority-pill[data-priority="all"]')?.click();
        scrollTo(document.querySelector(own) ? own : grpSel);
      },
      9000, 'Show it');
  }, 0);
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
    if (fresh) { showToast(`✓ "${stripWW(itemName)}" updated`); renderPage(fresh); notifyIfFiltered(itemName); }
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
// getRunnerStatus() lives in utils.js - scrape-log dispatches workflows too and
// needs the same pre-flight.

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
// loadSettings() lives in utils.js (scrape-log reads it too).

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

// Live feedback under the "Other store URL" box: name the shop as soon as the
// hostname is recognisable, and say plainly when it isn't - a silently-ignored
// paste is exactly how "I added it and nothing happened" happens.
function updateThirdUrlNote() {
  const input = $('editThirdUrl'), note = $('editThirdNote');
  if (!input || !note) return;
  const raw = input.value.trim();
  if (!raw) {
    note.textContent = 'Shown as an extra "Other stores" option. Its price is fetched on the next scrape.';
    note.classList.remove('form-note-bad', 'form-note-ok');
    return;
  }
  const store = thirdStoreFromUrl(raw.startsWith('http') ? raw : 'https://' + raw);
  if (store) {
    note.textContent = `✓ ${THIRD_STORES[store].label} - priced on the next scrape.`;
    note.classList.add('form-note-ok');
    note.classList.remove('form-note-bad');
  } else {
    note.textContent = `Not a store I can price. Supported: ${thirdStoreNames()}.`;
    note.classList.add('form-note-bad');
    note.classList.remove('form-note-ok');
  }
}

// Merge one item's third-store entry into the repo's third_store.json. Empty
// url = remove this item's entry. Read-modify-write against the LIVE file so a
// hand-maintained entry (or another device's addition) is never clobbered.
async function persistThirdStoreEntry(s, itemName, url, storeKey) {
  if (!s?.user || !s?.repo || !s?.token) return;
  const doc = await githubGetJson(s, 'docs/data/third_store.json') || {};
  if (!url) {
    delete doc[itemName];
  } else {
    const prev = (doc[itemName] || [])[0] || {};
    // price is deliberately omitted on a NEW url - third_stores.py fills it on
    // the next run. Carrying the old price across a url change would attach one
    // product's price to another product's link.
    doc[itemName] = [{
      store: storeKey,
      name: prev.url === url ? (prev.name || itemName) : itemName,
      url,
      ...(prev.url === url && prev.price != null ? { price: prev.price, checked: prev.checked } : {}),
      ...(prev.url === url && prev.packs ? { packs: prev.packs } : {}),
      added: new Date().toISOString().slice(0, 10),
    }];
  }
  await githubPutJson(s, 'docs/data/third_store.json', doc,
                      `edit: third-store link for ${itemName}`);
}

// Replace one key's WHOLE third-store list (the category editor's Other-stores
// column). Same read-modify-write against the live file as the single-entry
// version, so other keys are never touched.
//
// A price is carried over ONLY when that exact url is unchanged - a re-pointed
// link keeps no price, or third_stores.py would leave one product's price
// attached to another product's link until the next run overwrote it. `status`
// is deliberately dropped: it is the scraper's to set, and a stale
// "unreachable" would otherwise outlive the fix.
async function persistThirdStoreList(s, key, list) {
  if (!s?.user || !s?.repo || !s?.token) return;
  const doc = await githubGetJson(s, 'docs/data/third_store.json') || {};
  const prevByUrl = new Map((doc[key] || []).map(e => [e.url, e]));
  if (!list.length) {
    delete doc[key];
  } else {
    const today = new Date().toISOString().slice(0, 10);
    doc[key] = list.map(e => {
      const prev = prevByUrl.get(e.url);
      return {
        ...e,
        ...(prev?.price != null ? { price: prev.price, checked: prev.checked } : {}),
        added: prev?.added || today,
      };
    });
  }
  await githubPutJson(s, 'docs/data/third_store.json', doc,
                      `edit: other-store links for ${key}`);
}

function initEditModal() {
  const modal = $('editModal');
  if (!modal) return;

  const close = () => { modal.classList.remove('open'); _editingItem = null; };

  $('editModalClose').addEventListener('click', close);
  $('editCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  $('editThirdUrl')?.addEventListener('input', updateThirdUrlNote);

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

    // Third store: refuse an unrecognised host rather than accepting the paste
    // and quietly doing nothing with it.
    const newThirdUrl = _normaliseUrl($('editThirdUrl')?.value || '') || '';
    const thirdStoreKey = newThirdUrl ? thirdStoreFromUrl(newThirdUrl) : null;
    if (newThirdUrl && !thirdStoreKey) {
      alert(`That "Other store" link is not a shop I can price.\n\nSupported: ${thirdStoreNames()}.`);
      return;
    }
    const prevThird = (thirdEntriesFor(_editingItem.list_item)[0]
                       || _thirdStores[_editingItem.list_item]?.[0] || {}).url || '';
    const thirdChanged = newThirdUrl !== prevThird;

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
        // Third store is priced by the pipeline's own step (third_stores.py),
        // not by a single-item dispatch - so say when the price will appear
        // rather than leaving a link that looks broken until then.
        if (thirdChanged) {
          await persistThirdStoreEntry(s, item.list_item, newThirdUrl, thirdStoreKey);
          showToast(newThirdUrl
            ? `✓ ${THIRD_STORES[thirdStoreKey].label} link saved - its price arrives with the next scrape.`
            : `✓ Other-store link removed from "${item.list_item}".`);
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
  // Third store: show the entry already stored for this item, if any. Only one
  // is editable here - a product sold at two outside shops is rare, and the
  // JSON still supports a list for the hand-maintained cases.
  const _t3 = thirdEntriesFor(item.list_item)[0] || _thirdStores[item.list_item]?.[0];
  if ($('editThirdUrl')) $('editThirdUrl').value = _t3?.url || '';
  updateThirdUrlNote();
  // Re-enable in case a previous write completed between modal open/close cycles
  if (!_overridesSaving) {
    $('editSave').disabled = false;
    $('editReset').disabled = false;
  }
  $('editModal').classList.add('open');
}

// The price-history modal lives in history-modal.js (shared with hot-deals).


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
// `label` exists because this is really "toast with one action button" - the
// filtered-item notice reuses it with "Show it". Default keeps every existing
// caller unchanged.
function showUndoToast(msg, onUndo, durationMs = 8000, label = 'Undo') {
  const toast = $('toastNotif');
  if (!toast) { if (onUndo) {/* no UI: leave change applied */} return; }
  clearTimeout(toast._timer);
  toast.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-undo-btn';
  btn.textContent = label;
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

  // Frequency, written EXPLICITLY at creation. Left unset, getPriority() falls
  // through to its trip-count guess, and a brand-new product has 0 trips - so it
  // came out 'rare' and the default Weekly filter hid it. The product you just
  // added was invisible in the very view you added it from, which is what "I can
  // never add products" actually was. Categories already default to weekly (see
  // getPriority's __group_ branch); this is the plain-product equivalent.
  // Only when unset, so re-adding a product you had deliberately filed as
  // monthly/rare doesn't quietly promote it back to weekly.
  const prios = loadPriorities();
  if (!prios[newName]) { prios[newName] = 'weekly'; savePriorities(prios); }

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

// Every name a row can legitimately be found by, lowercased into one haystack.
//
// The search used to test `override || list_item`. For a CATEGORY row list_item
// is the internal `__group_<key>` SLUG, never the label on screen - and the slug
// is a snapshot of the label taken when the category was created, so it matched
// only by luck. "Barramundi Fish" was minted as barramundi_fish and does find
// "fish"; "Basa Fish Fillets" was minted as basa_fillets and vanishes the moment
// you type the "s" of "fis", even though the row reads Fish. Renaming a category
// never rewrites its slug, so renaming Salmon to "Salmon fish" left it
// unfindable by the one word you can actually read on it.
//
// The SORT has read the displayed label since the A-Z fix ("so A-Z order matches
// what the eye reads"); search was simply never brought along. Both now go
// through here.
//
// Members are in the haystack too, because a category IS its products: the
// Salmon row really does contain the Tassal packs, and typing "tassal" used to
// hide the only row holding them.
//
// A rename ADDS a name rather than replacing one - the raw and store names stay
// searchable. An override is another handle on a product, not a denial of the
// name the store prints on it.
function searchHaystack(item, ovr) {
  const namesOf = n => [n, ovr[n]?.displayName, window.PW_NAME_MAP?.[n], stripWW(n)];
  const parts = (item._isGroup || item._groupLabel)
    ? [item._groupLabel, ...(item._members || []).flatMap(m => namesOf(m.list_item))]
    : namesOf(item.list_item);
  return parts.filter(Boolean).join(' ').toLowerCase();
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
  // Category LABELS count as a match, not just raw products. A category name
  // exists nowhere in the item list - "Barramundi Fish" is a label over five
  // products none of which say "fish" - so searching it would have been filed as
  // a product the user doesn't track, while the row sat on screen matching it.
  // Same haystack the filter uses, so what the page shows and what this records
  // cannot disagree.
  const anyMatch = _lastData.items.some(i => !i.archived && nameMatchesSearch(searchHaystack(i, ovr), terms))
    || buildVariantGroups(new Map(_lastData.items.map(i => [i.list_item, i])))
         .some(g => nameMatchesSearch(searchHaystack(g, ovr), terms));
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

// Custom-list pills, rebuilt whenever the lists change. Delegation would be
// tidier, but the frequency pills bind individually and a mixed model is worse
// than one repeated line - so these bind the same way and get rebuilt wholesale.
function renderListPills() {
  const host = $('listPills');
  if (!host) return;
  const all = loadLists();
  // Lists hidden on the Lists page keep their products but give up their pill -
  // filtered HERE rather than at the source so every other list surface (the
  // bulk "Add to list" menu, the Lists page itself) still sees all of them.
  const keys = Object.keys(all).filter(k => listShownOnMain(k))
    .sort((a, b) => (all[a].label || a).localeCompare(all[b].label || b));
  host.innerHTML = '';
  if (keys.length) {
    const sep = document.createElement('span');
    sep.className = 'filter-separator';
    host.appendChild(sep);
    for (const k of keys) {
      const btn = document.createElement('button');
      btn.className = 'priority-pill list-pill' + (_activePriority === LIST_FILTER_PREFIX + k ? ' active' : '');
      btn.dataset.priority = LIST_FILTER_PREFIX + k;
      btn.textContent = all[k].label || k;
      btn.title = `Show only the products in "${all[k].label || k}"`;
      btn.addEventListener('click', () => applyPriorityFilter(btn.dataset.priority, btn));
      host.appendChild(btn);
    }
  }
  // Mobile hides the pill row entirely, so the same choices have to exist in the
  // frequency dropdown or lists would be desktop-only.
  //
  // Runs even with NO visible lists - this used to sit behind an early return on
  // `keys.length`, so the last list's option outlived its pill (deleting your
  // only list left it selectable in the dropdown). Hiding every list makes that
  // a one-click state instead of a rare one, so the stale optgroup has to go.
  const fs = $('freqSelect');
  if (fs) {
    fs.querySelector('optgroup[data-lists]')?.remove();
    if (keys.length) {
      const og = document.createElement('optgroup');
      og.label = 'My lists';
      og.setAttribute('data-lists', '1');
      for (const k of keys) {
        const o = document.createElement('option');
        o.value = LIST_FILTER_PREFIX + k;
        o.textContent = all[k].label || k;
        og.appendChild(o);
      }
      fs.appendChild(og);
    }
    // Only re-assert a list selection that still EXISTS as an option. Setting
    // .value to a removed option silently blanks the <select>, which reads as
    // "no filter" while the table is still filtered.
    if (_activePriority.startsWith(LIST_FILTER_PREFIX)
        && fs.querySelector(`option[value="${CSS.escape(_activePriority)}"]`)) {
      fs.value = _activePriority;
    }
  }
}

// The four pills that are a plain frequency view. Exactly one is always on, so
// these do NOT toggle off - there is no "no frequency" state to fall back to.
const FREQ_FILTERS = ['all', 'weekly', 'monthly', 'rare'];
// The frequency view to come back to when a toggleable filter is switched off.
// Seeded with the app's default so the very first "off" click has somewhere to go.
let _prevFreqFilter = 'weekly';

// One place that applies a filter choice, so the frequency pills, the list pills
// and the mobile dropdown can't drift in what "selected" means.
function applyPriorityFilter(p, btn) {
  if (!p) { if (_lastData) renderPage(_lastData); return; }
  // Clicking the pill that is ALREADY on turns it off again - for Archived and
  // for a list, which were one-way doors: once on, the only way out was picking
  // some other filter. Off returns to the frequency view you came from rather
  // than a hardcoded "All", so turning Archived off while you were on Monthly
  // puts you back on Monthly.
  if (p === _activePriority && !FREQ_FILTERS.includes(p)) {
    p = FREQ_FILTERS.includes(_prevFreqFilter) ? _prevFreqFilter : 'weekly';
    btn = null;   // the pill to light up is the frequency one, not the one clicked
  }
  if (FREQ_FILTERS.includes(p)) _prevFreqFilter = p;
  _activePriority = p;
  const container = $('priorityFilter');
  container?.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
  // Quoted attribute selector, so a "list:birthdays" value needs no escaping.
  (btn || container?.querySelector(`.priority-pill[data-priority="${p}"]`))?.classList.add('active');
  const fs = $('freqSelect');
  if (fs && ([...FREQ_FILTERS, 'archive'].includes(p) || p.startsWith(LIST_FILTER_PREFIX))) fs.value = p;
  if (_lastData) renderPage(_lastData);
}

function initPriorityFilter() {
  const container = $('priorityFilter');
  if (!container) return;
  renderListPills();

  container.querySelectorAll('.priority-pill').forEach(btn => {
    if (btn.id === 'watchlistPill') return; // has its own toggle handler below
    if (btn.classList.contains('list-pill')) return; // bound in renderListPills
    // Same single entry point the list pills use, so Archived toggles off the
    // way they do. (Search is intentionally preserved across filter switches.)
    btn.addEventListener('click', () => applyPriorityFilter(btn.dataset.priority, btn));
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
  // Routed through applyPriorityFilter so all three toggleable filters (watchlist,
  // archived, lists) turn off the same way and return to the same remembered
  // frequency view - this used to land on "All" regardless of where you started.
  function toggleWatchlistFilter() {
    applyPriorityFilter('watchlist', $('watchlistPill'));
  }

  $('watchlistPill')?.addEventListener('click', toggleWatchlistFilter);
  // Page-level controls, bound HERE and not in bindCategoryEditBody(): that
  // runs only when the category editor is first opened, so New product sat dead
  // until you happened to edit some category - and the store filter would have
  // shipped with the same bug.
  $('storeFilterPill')?.addEventListener('click', cycleStoreFilter);
  $('newProductBtn')?.addEventListener('click', openNewProductModal);
  // The edit form's "which shops can I paste?" hint, spelled from THIRD_STORES
  // rather than typed into the HTML - see thirdStoreNames().
  const thirdHint = $('editThirdStores');
  if (thirdHint) thirdHint.textContent = thirdStoreNames();

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
    items.forEach(({ label, value, disabled }) => {
      // Section heading, not an option - the menu now mixes frequency with
      // custom lists and needs to say where one ends and the other begins.
      if (disabled) {
        const h = document.createElement('div');
        h.className = 'bt-dropdown-sep';
        h.textContent = label;
        drop.appendChild(h);
        return;
      }
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

  // Frequency AND custom lists share ONE chip. The toolbar is already at its
  // width budget, so a separate "Add to list" control was not affordable - and
  // under this model it would be redundant anyway: Weekly/Monthly/Rare IS an
  // exclusive list, so the two belong in the same menu rather than two menus
  // that do the same kind of thing.
  bar.querySelector('.bt-pri')?.addEventListener('click', (e) => {
    const lists = loadLists();
    const listOpts = Object.keys(lists)
      .sort((a, b) => (lists[a].label || a).localeCompare(lists[b].label || b))
      .map(k => {
        // Tick state reflects the SELECTION: ✓ only when every checked product is
        // already in the list, so the menu says what clicking will change.
        const items = new Set(lists[k].items || []);
        const names = [..._checkedItems];
        const all = names.length && names.every(n => items.has(n));
        return { label: `${all ? '✓' : '＋'} ${lists[k].label || k}`, value: LIST_FILTER_PREFIX + k, _allIn: all };
      });
    const inArchiveView = _activePriority === 'archive';
    const opts = [
      { label: '⭐ Weekly',  value: 'weekly'  },
      { label: '📅 Monthly', value: 'monthly' },
      { label: '🔵 Rare',    value: 'rare'    },
      // Archiving is a frequency, so it reads as the fourth option here rather
      // than a separate chip competing for room in an already-full toolbar.
      { label: inArchiveView ? '📤 Unarchive' : '🗄 Archive', value: '__archive' },
      ...(listOpts.length ? [{ label: '— My lists —', value: '', disabled: true }] : []),
      ...listOpts,
    ];
    openChipDropdown(e.currentTarget, opts, (p) => {
      if (!p) return;
      if (p === '__archive') { bar._applyBulkArchive?.(); return; }
      if (p.startsWith(LIST_FILTER_PREFIX)) {
        const key = p.slice(LIST_FILTER_PREFIX.length);
        const chosen = listOpts.find(o => o.value === p);
        // Already all in -> the useful action is to take them OUT again, so the
        // one menu entry toggles rather than being a dead no-op.
        const on = !(chosen && chosen._allIn);
        _checkedItems.forEach(name => setListMembership(name, key, on));
        renderListPills();
        showToast(`${on ? 'Added to' : 'Removed from'} "${loadLists()[key]?.label || key}"`);
      } else {
        const pr = loadPriorities();
        _checkedItems.forEach(name => { pr[name] = p; });
        savePriorities(pr);
        scheduleArchiveSync();
      }
      if (_lastData) renderPage(_lastData);
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

  // Archiving lives in the Lists menu now (it IS a frequency value - 'archive' -
  // so it belongs with Weekly/Monthly/Rare rather than as its own chip). Kept as
  // a named function because the menu and the legacy chip both call it.
  function applyBulkArchive() {
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
  }
  bar.querySelector('.bt-archive')?.addEventListener('click', applyBulkArchive);
  bar._applyBulkArchive = applyBulkArchive;   // the Lists menu calls it too
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
  // shelfPrice(): for a WW by-weight item `price` is a per-KG RATE, not what one
  // unit costs. This function is the single source of every money figure on the
  // page - Best, Savings, Total, the sort keys and the basket line - so reading
  // the rate here priced ONE portion of loose mushrooms at $13.90 instead of
  // $2.78, and handed the "cheaper" verdict to Coles at $4.00. The scraper had
  // it right in latest.json (cheaper_store: woolworths, saving 1.22 = 4.00-2.78);
  // the client recomputed it wrong and overrode it.
  // A multi-buy is priced off the pack and never coexists with a by-weight item,
  // so multiBuyCost still gets the same number it always did for those.
  return multiBuyCost(units, shelfPrice(res), res.multi_buy);
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
// The Best column's verdict for ANY row - the ONE thing the chip and the sort
// key both read, because they disagreed and the column looked randomly ordered.
// A CATEGORY carries .woolworths/.coles holding its cheapest member's raw PACK
// price, but it is judged on its per-kg/per-unit metric (that's the whole point
// of a category), and the two routinely disagree - a cheaper pack is often the
// dearer kilo. So a group answers with the verdict it already displays; only a
// plain row goes through the multi-buy line-cost comparison.
function rowCheaperStore(item) {
  return item._isGroup ? item.cheaper_store : mbCheaperStore(item);
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
  if (item._isGroup) return groupStoreTotal(item, store);   // utils.js - basket uses the same
  return mbLineCost(store === 'ww' ? item.woolworths : item.coles, getUnits(item.list_item));
}

// ── Banner stats (priority-aware) ────────────────────────────────────────────

// The price this row SHOWS in a store's column: per-kg groups show $/kg, normal
// items show their effective per-unit price (multi-buy applied). NOT multiplied
// by qty - the column footers sum the numbers actually on screen, and the Qty
// column's effect already lives in the Total column.
function shownStorePrice(item, store) {
  // metricShown(), not the raw _wwPerKg/_coPerKg: those are stored per KILO (or
  // per ONE piece), and a category that quotes anything else renders the scaled
  // figure. Summing the raw value made the price-column footer disagree with the
  // column above it by the quote factor - a $/100g category showed "$5.00/100g"
  // in the row and "$50.00" in the footer, and a per-piece category under-counts
  // the same way. Identical for $/kg categories, which is why it hid this long.
  if (item._isGroup) return metricShown(item, store === 'ww' ? item._wwPerKg : item._coPerKg);
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
  // Members are excluded unconditionally by the filter below (they render only as
  // part of their group, in every view). Group ROWS are added everywhere except
  // the archive view, matching what the table draws - see the collapse block in
  // _renderPageInner.
  let pool = items;
  if (_activePriority !== 'archive') {
    const groups = buildVariantGroups(new Map(items.map(i => [i.list_item, i]))).map(withGroupCounts);
    if (groups.length) pool = items.filter(i => !perkgMembers.has(i.list_item)).concat(groups);
  }
  const baseFiltered = pool.filter(item => {
    if (perkgMembers.has(item.list_item)) return false;
    // The ⚙ /kg and W/C buttons narrow the TABLE, so they have to narrow these
    // totals too - this predicate is a hand-copy of applyFilters() and had simply
    // never gained them. With "$/kg only" on, the table drew 33 category rows
    // while this still summed 165 items, so the price-column footers ($1,002.77)
    // and the Total footer beside them ($357.84) were adding up different sets of
    // rows. Same drift applyValueFilters() was extracted to stop, one level up.
    if (_storeFilter && rowCheaperStore(item) !== _storeFilter) return false;
    if (_perkgFilter === 'only' && !item._isGroup) return false;
    if (_perkgFilter === 'hidden' && item._isGroup) return false;
    if (_activePriority === 'watchlist') {
      if (!isWatchedItem(item.list_item)) return false;
    } else if (activeListKey()) {
      if (!itemInActiveList(item)) return false;
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
    // An item needs a price SOMEWHERE to count. It used to need one at BOTH
    // stores, which quietly dropped single-store items from the cards - so these
    // totals disagreed with the Basket's, and neither answered "what does this
    // whole shop cost?". Group rows carry their price as _wwPerKg/_coPerKg, not
    // woolworths.price, so ask shownStorePrice.
    if (shownStorePrice(item, 'ww') == null && shownStorePrice(item, 'coles') == null) return false;
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
  // An item a store doesn't stock is counted at the price you'd actually pay for
  // it elsewhere - you still have to buy it. Both totals therefore cover the SAME
  // item set, which is the only way the comparison means anything (and is exactly
  // what the Basket page does, so the two pages' figures match).
  const storeTotal = (i, store) =>
    rowStoreTotal(i, store) ?? rowStoreTotal(i, store === 'ww' ? 'coles' : 'ww') ?? 0;
  const ww_total = filtered.reduce((s, i) => s + storeTotal(i, 'ww'), 0);
  const co_total = filtered.reduce((s, i) => s + storeTotal(i, 'coles'), 0);
  const col_ww = filtered.reduce((s, i) => s + (shownStorePrice(i, 'ww') ?? 0), 0);
  const col_coles = filtered.reduce((s, i) => s + (shownStorePrice(i, 'coles') ?? 0), 0);
  const total_saving = Math.abs(ww_total - co_total);
  // "Max saving": buy each item at whichever store is cheapest, vs doing the
  // whole shop at the more expensive single store. Same qty-weighted basis as the
  // store totals, so cherry_total IS the Total-column best-of-each figure.
  const cherry_total = filtered.reduce((s, i) =>
    s + Math.min(storeTotal(i, 'ww'), storeTotal(i, 'coles')), 0);
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

// infoIcoHTML() lives in utils.js - the basket uses it too (per-kg rate note).
// Renders the two saving figures shown between the store cards:
//   • Basket saving - the gap between the two whole-basket totals (matches the cards).
//   • Max saving - buy each item at its cheaper store vs the dearer single store.
//     Only shown when splitting the shop beats just visiting the cheaper store.

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
  // How the two store totals are built. Rides along inside this panel (which has
  // spare room) rather than as its own full-width line under the cards.
  const rule = `<div class="saving-rule">How these totals are calculated${infoIcoHTML(TOTALS_RULE_TIP)}</div>`;
  return basket + maxRow + rule;
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

  // The ghost is a cloneNode() of the real thead, so its "select all" box is a
  // COPY: cloneNode carries no event listeners, and the clone's id is stripped
  // (see syncStickyNow), so nothing was listening to it and updateBulkBar never
  // synced it either. Clicking it while the header was stuck ticked a checkbox
  // that nothing read - no rows selected - and left the real one untouched, so
  // scrolling back up showed it unticked and clicking THERE worked.
  //
  // Delegated on the ghost CONTAINER, which outlives every re-clone, and
  // forwarded to the real control so the sticky header drives the exact same
  // code path rather than a second copy of the logic.
  ghost.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const real = $('checkAll');
    if (!real) return;
    real.checked = cb.checked;
    real.indeterminate = false;
    real.dispatchEvent(new Event('change', { bubbles: true }));
  });

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

// Put the real "select all" box into the right one of its three states for the
// rows currently on screen, then mirror it onto the sticky header's copy.
function syncCheckAllState() {
  const allChecks = document.querySelectorAll('.row-check');
  const checkAll = $('checkAll');
  if (checkAll && allChecks.length) {
    const numChecked = [...allChecks].filter(c => c.checked).length;
    checkAll.checked = numChecked === allChecks.length;
    checkAll.indeterminate = numChecked > 0 && numChecked < allChecks.length;
  }
  syncGhostCheckAll();
}

// Mirror the real "select all" box onto the ghost's copy. `checked` and
// `indeterminate` are IDL PROPERTIES, not attributes, so cloneNode does not carry
// them - without this the sticky header showed an empty box over a fully selected
// table (and vice versa) whenever it re-synced.
function syncGhostCheckAll() {
  if (!_stickyGhostTable) return;
  const real = $('checkAll');
  const ghost = _stickyGhostTable.querySelector('th.check-cell input[type="checkbox"]');
  if (!real || !ghost) return;
  ghost.checked = real.checked;
  ghost.indeterminate = real.indeterminate;
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
  syncGhostCheckAll();

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

async function triggerRefresh(mode) {
  // `mode` is 'quick' | 'full'; omitted means "whatever the schedule says".
  const scrapeMode = ['quick', 'full', 'new'].includes(mode) ? mode : defaultScrapeMode().mode;
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
        body: JSON.stringify({ ref: 'main', inputs: { scrape_mode: scrapeMode } }),
      }
    );

    if (res.status === 204) {
      // Only a FULL run satisfies the weekly obligation, so only a full run
      // stamps the week. Stamped on dispatch rather than on completion: a run
      // that dies half way still checked the long tail, and re-defaulting to a
      // 20-minute scrape because the tail-end failed helps nobody.
      if (scrapeMode === 'full') markFullScrapeDone();
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
// Same short descriptions the ▾ menu items use (header.js), duplicated rather
// than shared: header.js builds its HTML before utils.js has loaded, so it
// cannot read a constant defined there, and this pair of phrases is small
// enough that keeping them in sync by eye is cheaper than restructuring
// script load order for it.
const SCRAPE_MODE_DESC = { full: 'everything, including the never-movers', quick: 'only items whose price actually moves' };
// What the plain click is ABOUT to do, so it doesn't have to be discovered by
// clicking. defaultScrapeMode() already carries the WHY (used by the ▾ menu's
// note); this just also names the WHAT.
function refreshTooltipText(now) {
  const d = defaultScrapeMode(now);
  return `${d.mode === 'full' ? 'Full' : 'Quick'} scrape - ${SCRAPE_MODE_DESC[d.mode]}. ${d.reason}`;
}
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
    btn.title = refreshTooltipText();
    btn.innerHTML = SVG_REFRESH_ICO;
  }
}
// Refresh just the idle tooltip's WORDING (e.g. Wednesday has rolled around
// since the page was opened) without touching disabled/icon/classes - called
// from every render, so it must never fight a working/done/error state that a
// renderPage() mid-dispatch could otherwise stomp back to idle.
function syncRefreshIdleTooltip() {
  const btn = $('refreshBtn');
  if (!btn || btn.classList.contains('is-working') || btn.classList.contains('is-done') || btn.classList.contains('is-error')) return;
  btn.title = refreshTooltipText();
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
    // "I'm standing in this store - what's worth buying HERE?" Only rows where
    // that store is genuinely the cheaper one. Equal-priced rows are excluded
    // deliberately: they are not a reason to pick one store over the other, and
    // including them would pad the list with items you may as well buy anywhere.
    // Sits ahead of every other test so it applies in the archive and watchlist
    // views too - it is a question about the row, not about which tab you're on.
    // rowCheaperStore is THE verdict the Best column shows - reusing it means
    // the filter can never disagree with the badge on the row it kept.
    if (_storeFilter && rowCheaperStore(item) !== _storeFilter) return false;
    // Per-kg group visibility (⚙ /kg button): isolate the groups, or hide them entirely
    if (_perkgFilter === 'only') return !!item._isGroup;
    if (_perkgFilter === 'hidden' && item._isGroup) return false;
    // Watchlist filter: show only watchlisted items; bypass archive/priority checks
    if (_activePriority === 'watchlist') return isWatchedItem(item.list_item);
    // A custom list is likewise its own view - membership is the whole filter.
    if (activeListKey()) return itemInActiveList(item);
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
    filtered = filtered.filter(i => nameMatchesSearch(searchHaystack(i, ovr), terms));
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
      // Sort on the label the column DISPLAYS, not the internal store key:
      // 'coles'/'equal'/'woolworths' sorted alphabetically read as C, =, W, which
      // matches nothing the eye can see. rowCheaperStore keeps categories on the
      // same verdict their own chip shows (see its comment).
      case 'cheaper':  return CHEAPER_SORT_LABEL[rowCheaperStore(item)] ?? 'N/A';
      case 'saving':   return item._isGroup ? (savingAmount(item) ?? NaN) : (mbSaving(item) ?? NaN);
      case 'trips':    return item.trip_count || 0;
      // One column, one numeric order - see qtySortValue in utils.js.
      case 'units':    return qtySortValue(getUnits(item.list_item), isKgQty(item.list_item));
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
      // Groups sort by the same freshest-member date their cell prints, so the
      // column can never sort differently from what it shows.
      case 'last_scraped': return (item._isGroup ? groupLastScraped(item) : item.last_scraped) || '';
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
    const cheaper = rowCheaperStore(item);  // multi-buy-aware, same verdict as the desktop table
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

    // Prices come from shownStorePrice() - the SAME source as the table column,
    // multi-buy applied at the current qty. The per-100 measure is scaled to
    // match, so a dropped headline never sits above a shelf-price $/100g.
    const wwShown = shownStorePrice(item, 'ww');
    const coShown = shownStorePrice(item, 'coles');
    const wwP100e = per100AtEffective(wwP100, ww, item.list_item);
    const coP100e = per100AtEffective(coP100, co, item.list_item);

    let wwHtml;
    if (ww) {
      const shown = fmt(wwShown != null ? wwShown : ww.price);
      const pv = wwUrl ? `<a href="${wwUrl}" target="_blank" rel="noopener" class="price-link">${shown}</a>` : shown;
      const fire = hotDeal && cheaper === 'woolworths' ? hotBadge : '';
      const unit = wwP100e.value != null ? `$${wwP100e.value.toFixed(2)}/${wwP100e.label}` : (wwP100e.blanked ? '' : fmtUnit(ww.unit_price, ww.unit));
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}</div>`;
    } else {
      wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span> <a href="https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}" target="_blank" rel="noopener" class="search-link">Find →</a></div>`;
    }

    let coHtml;
    if (co) {
      const shown = fmt(coShown != null ? coShown : co.price);
      const pv = coUrl ? `<a href="${coUrl}" target="_blank" rel="noopener" class="price-link">${shown}</a>` : shown;
      const fire = hotDeal && cheaper === 'coles' ? hotBadge : '';
      const unit = coP100e.value != null ? `$${coP100e.value.toFixed(2)}/${coP100e.label}` : (coP100e.blanked ? '' : fmtUnit(co.unit_price, co.unit));
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span><span class="card-store-price">${pv}${fire}</span></div><div class="card-store-unit">${unit}</div>`;
    } else {
      coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span> <a href="https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}" target="_blank" rel="noopener" class="search-link">Find →</a></div>`;
    }

    // Winner tint follows the qty-aware comparison, so the coloured side is
    // always the side showing the lower number above it. Only when BOTH stores
    // actually have a price - one store's price cannot "win" against a store
    // that was never priced, but the scraper's cheaper_store falls back to
    // whichever single store IS priced, so this used to tint (and checkmark)
    // single-store items as if they'd beaten a competitor.
    const mbCheaper = mbCheaperStore(item);
    const wwClass   = (ww && co && mbCheaper === 'woolworths') ? 'winner-ww' : '';
    const coClass   = (ww && co && mbCheaper === 'coles')      ? 'winner-coles' : '';
    // Verdict + any multi-buy tag share one always-present row (see cardVerdictHTML).
    const mbTag = multiBuyBadge(ww) + multiBuyBadge(co);
    const savingHtml = `<div class="card-saving">${cardVerdictHTML(item)}${mbTag}</div>`;

    const _trendSeries = getTrendSeries(item, getUnits(item.list_item));
    // historyBtn:false - the clock moved into the card footer, beside the qty.
    const bar = buildPriceBar(item.list_item, _trendSeries.past.map(p => ({price: p})), _trendSeries.current, 1, false);
    const isChecked = _checkedItems.has(item.list_item);
    const notFound = !ww && !co;

    parts.push(`<div class="item-card${notFound ? ' card-not-found' : ''}" data-item="${safeKey}">
      <div class="card-top">
        <input type="checkbox" class="row-check card-check" data-item="${safeKey}"${isChecked?' checked':''}>
        <div class="card-img-wrap">${imgHtml}</div>
        <div class="card-info">
          <div class="card-name">${esc(displayName)}${hotDeal ? hotBadge : ''}</div>
          <div class="card-cat">${esc(cat)}</div>
        </div>
        ${cardWatchHTML(item.list_item)}
      </div>
      <div class="card-prices">
        <div class="card-store ${wwClass}">${wwHtml}</div>
          <div class="card-store ${coClass}">${coHtml}</div>
      </div>
      ${savingHtml}
      ${bar ? `<div class="card-bar">${bar}</div>` : ''}
      ${cardFooterHTML(item.list_item, !!bar)}
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
// buildVariantGroups() lives in utils.js so the basket builds IDENTICAL category
// rows (same members, same $/kg exclusions, same metric) - that is what makes the
// two pages' store totals agree. Display-only member counts are attached by
// withGroupCounts() below, which needs this file's name/dedupe helpers.
function withGroupCounts(group) {
  const ovr = loadOverrides();
  const memberByName = new Map(group._members.map(m => [m.list_item, m]));
  const count = (list, storeKey) =>
    dedupePerKgVariants(list.map(x => ({ name: x.name, res: x.result, pk: x.perkg })), storeKey, ovr, memberByName).length;
  group._wwCount = count(group._wwAll || [], 'ww');
  group._coCount = count(group._coAll || [], 'coles');
  return group;
}

// ── Card-view shared pieces ──────────────────────────────────────────────────
// Card view used to render raw shelf prices while the table rendered qty-aware
// ones, so the same product read $5.50 on a card and $4.40 in the table once a
// multi-buy went live. Everything below exists so the two views cannot diverge
// again: cards now go through the SAME shownStorePrice()/rowStoreTotal() the
// table uses, and the pieces that hang off the price are derived from those.

// Per-unit measure ($/100g, $/100ml) recomputed at the EFFECTIVE price rather
// than the ticket price: when a deal drops the headline, a $/100g still figured
// off the shelf price contradicts the number directly above it. Pack size is
// unchanged, so scaling by effective÷shelf is exact.
function per100AtEffective(p100, res, itemName) {
  if (!res) return p100;
  return scalePer100(p100, res.price, mbEffUnit(res, getUnits(itemName)));   // utils.js
}

// The verdict line: which store wins AT THE CURRENT QTY and by how much in
// total (qty included), or "=" when they tie. Always renders something, which
// is what keeps every card the same height so the trend bars line up across a
// row - a tie used to collapse to nothing and float its card's bar upward.
// Works for normal items and per-kg groups alike: rowStoreTotal() already
// branches on _isGroup.
function cardVerdictHTML(item) {
  const w = rowStoreTotal(item, 'ww'), c = rowStoreTotal(item, 'coles');
  if (w == null || c == null) return '';
  const diff = Math.abs(w - c);
  if (diff < 0.005) return '<span class="card-eq" title="Same price at both stores">=</span>';
  const wwWins = w < c;
  return `<span class="store-chip ${wwWins ? 'ww' : 'coles'} sm">${wwWins ? 'W' : 'C'}</span>` +
         `<span class="card-save-amt ${wwWins ? 'is-ww' : 'is-coles'}">Save ${fmt(diff)}</span>`;
}

// Quantity stepper + history clock, sharing the bottom row of every card. Same
// .units-inc/.units-dec/.units-val contract the table row uses, so both views
// read and write the one pw_units_v1 store and can never show different counts.
function cardFooterHTML(itemName, hasBar) {
  const safe = escAttr(itemName);
  const u = getUnits(itemName);
  return `<div class="card-footer">
      <span class="units-ctrl card-units">
        <button class="units-dec" data-item="${safe}" aria-label="Decrease quantity">−</button>
        <span class="units-val">${unitsLabel(itemName, u)}</span>
        <button class="units-inc" data-item="${safe}" aria-label="Increase quantity">+</button>
      </span>
      ${hasBar ? `<button class="price-bar-manage card-hist" data-manage-item="${safe}" title="Price history" aria-label="View price history">${HIST_CLOCK_SVG}</button>` : ''}
    </div>`;
}

// THE one writer of pw_units_v1 from a stepper - table and card view both call
// it, so the two views cannot end up showing different quantities for the same
// product. kg steps for loose cuts (0.2kg, floor 0.2), whole packs otherwise.
function stepUnits(itemName, isInc) {
  const ov = loadUnitOverrides();
  const cur = getUnits(itemName);
  if (isKgQty(itemName)) {
    ov[itemName] = Math.max(0.2, Math.round((cur + (isInc ? 0.2 : -0.2)) * 10) / 10);
  } else {
    ov[itemName] = Math.max(1, Math.round(cur) + (isInc ? 1 : -1));
  }
  saveUnitOverrides(ov);
  if (_lastData) renderPage(_lastData);
}

// Watchlist eye, pinned to the card's top-right corner (mirrors the mobile card).
function cardWatchHTML(itemName) {
  const on = isWatchedItem(itemName);
  return `<button class="item-watch-btn card-watch${on ? ' active' : ''}" data-item="${escAttr(itemName)}" title="${on ? 'Remove from watchlist' : 'Add to watchlist'}" aria-label="${on ? 'Remove from watchlist' : 'Add to watchlist'}">👁</button>`;
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
// A category's own tag: the offer is ALWAYS counted there (see groupMetric), so
// it is never the muted "buy N more to unlock" state - the price beside it has
// the offer already in it.
function multiBuyTagAlways(res) {
  const mb = res?.multi_buy;
  if (!mb?.qty || mb.total == null || res.price == null) return '';
  const eff = (mb.total / mb.qty).toFixed(2);
  return `<span class="mb-tag on" title="Multi-buy: ${mb.qty} for $${mb.total.toFixed(2)} - $${eff} each (shelf $${res.price.toFixed(2)}). Counted in this category's price.">${MB_TAG_SVG}</span>`;
}

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
  const head = `${fmtUnitMetric(perkg)}${suf}`;
  const linked = url ? `<a href="${url}" target="_blank" rel="noopener" class="price-link">${head}</a>` : head;
  return `<div class="price-main">${linked}</div>`;
}

// Trend cell for a group. The bar is built from EVERY member's $/kg series
// (memberPerKgPrices - the same conversion the price column and history modal
// use), and the marker is the group's current best $/kg (best.perkg, the exact
// number shown in the price column). History, current price and trend therefore
// all share one source of truth and cannot diverge.
// historyBtn:false for card view, whose clock lives in the card footer beside
// the qty. The table row keeps its inline clock.
function groupTrendCellHTML(group, historyBtn = true) {
  const cands = [group._wwBest, group._coBest].filter(Boolean);
  if (!cands.length) return '';
  const best = cands.reduce((a, b) => (a.perkg <= b.perkg ? a : b));

  // ONE series for the bar and for the sort - groupPastPrices. They used to be
  // built separately and the two disagreed: this branched on _sticker FIRST, so a
  // per-piece-but-not-sticker category (garbage bags, dishwashing tablets) drew a
  // $/kg axis under a per-piece marker, and when that produced under 2 points the
  // bar vanished altogether. groupPastPrices puts perPack first, like groupMetric.
  // Whatever minimum the bar draws is now exactly the minimum the sort measures
  // against, so a price below the bar really does sort ahead of one sitting on it.
  // 'best' measures against the cheapest option at each store on each date;
  // 'all' against every member's every price. Its series is already in display
  // units, so it skips the metricShown() pass below - see groupBestPastShown.
  const bestOnly = loadTrendRangeMode() === 'best';
  const prices = bestOnly ? groupBestPastShown(group) : groupPastPrices(group);
  // Under two points there is no range to draw, but buildPriceBar still hands
  // back the History button - so a brand-new category (Tahini Neri, one scrape
  // old and a category of one) keeps a way into its history instead of showing a
  // blank Trend cell. Returning '' here short-circuited that.
  if (prices.length < 2) return buildPriceBar(`__group_${group._groupKey}`, [], null, 1, historyBtn);
  // Shown in the SAME units as the price column, the total and the basket. The
  // bar itself is relative so the scale never mattered to it, but its min/max
  // labels are real money and were printing the hidden per-ONE-piece figure -
  // "$0.03  $0.12" beside a price reading "$3.17 /100".
  const hist = prices.map(p => ({ price: bestOnly ? p : metricShown(group, p) }));
  // History button opens the group's own merged history (see buildGroupHistoryItem),
  // not one member's - a group can mix a WW-only and a Coles-only product, so
  // picking a single member's history hides whichever store that member doesn't sell at.
  return buildPriceBar(`__group_${group._groupKey}`, hist, metricShown(group, best.perkg), 1, historyBtn);
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
      // A per-pack sticker group (nappies) instead needs 1/count, per member -
      // same reasoning as groupTrendCellHTML just above: a 30-pack and a 40-pack
      // read the same $ scale here otherwise, and the cheapest-per-date pick
      // would favour whichever pack happens to be bigger rather than cheaper.
      // qtyPiecesPer, not 1: the series has to be in the SAME units the row,
      // the total and the basket use, or the history chart contradicts them.
      // It also rescues the precision - at per-ONE-piece the .toFixed(2) below
      // flattened every wipe in the category to "$0.03".
      // A WEIGHED group must be scaled to its gram quote here for exactly the
      // reason the per-piece branch is scaled to its piece quote - see the
      // "today" row below, which goes through metricShown() and therefore IS
      // quoted per gramQuote. Leaving the series at raw $/kg made a /100g
      // category (Aero Peppermint, Cadbury Dairy Milk) show today at $4.24 and
      // every earlier date at $42.40: the same price reading as a 10x overnight
      // jump. The per-piece half of this bug was already found and fixed; the
      // weighed half was missed because $/kg is the default and most categories
      // never override it.
      let ratio;
      if (group._perPack) {
        ratio = packCountOf(m.list_item) > 0 ? qtyPiecesPer(group) / packCountOf(m.list_item) : null;
      } else if (group._sticker) {
        ratio = 1;   // sticker groups compare raw pack prices - nothing to convert
      } else {
        const kgR = perKgRatio(isWw ? m.woolworths : m.coles);
        // Guarded, not inlined: `null * 0.1` is 0, which would sail past the
        // `ratio == null` check below and plot every point at $0.00.
        ratio = kgR == null ? null : kgR * (weightQuoteOf(group) / 1000);
      }
      if (ratio == null) return [];
      const ex = exclSetsFor(m.list_item)[isWw ? 'ww' : 'co'];
      const raw = isWw ? [...(m.price_history || []), ...(m.ww_price_history || [])]
                        : (m.coles_price_history || []);
      const byDate = new Map();
      for (const e of raw) {
        if (!(e.price > 0) || ex.has(Number(e.price).toFixed(2))) continue;
        // metricRound, not a bare toFixed(2): the "today" row below comes from
        // metricShown, and the two must land on the same number for the same
        // price or the newest point reads as a one-cent move that never
        // happened. It also keeps sub-20c metrics at three decimals.
        byDate.set(e.date, { price: metricRound(e.price * ratio), src: m.list_item, raw: Number(e.price) }); // later entries for the same date win
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
    // What the plotted numbers MEAN. A per-piece category's history is per
    // `quote` pieces, so the modal has to say so - "$10.93" with no unit is
    // indistinguishable from a pack price.
    // Reads the category's own gram quote instead of asserting "$/kg". The
    // modal titled a /100g category "($/kg)" while plotting /100g numbers, so
    // the one label that was supposed to say what the numbers mean was the
    // thing telling you they meant something else.
    _unitLabel: group._perPack ? `per ${qtyPiecesPer(group)} pcs`
              : (group._sticker ? null : '$' + weightQuoteSuffix(weightQuoteOf(group))),
    // date → winning source, for the modal's per-point exclusion buttons
    _wwMeta: new Map(wwSeries.map(e => [e.date, e])),
    _coMeta: new Map(coSeries.map(e => [e.date, e])),
    price_history: [],
    ww_price_history: wwSeries,
    coles_price_history: coSeries,
    // The modal adds a "today" row from these live prices. They must be in the
    // SAME units as the series above, which is scaled by the category's quote -
    // otherwise today appears twice: once per single piece from here ($0.03) and
    // once per 100 from the series ($10.00), as if the price had moved 300x
    // overnight.
    woolworths: group._wwBest ? { price: metricShown(group, group._wwPerKg), scraped_at: group._wwBest.result?.scraped_at } : null,
    coles: group._coBest ? { price: metricShown(group, group._coPerKg), scraped_at: group._coBest.result?.scraped_at } : null,
  };
}

// Trend SORT position for a per-kg group. Mirrors the bar in groupTrendCellHTML - built
// from the members' $/kg series with the best $/kg as "current" - so sorting by trend
// orders groups by the same metric the bar shows. calcTrendPosition can't be used on a
// group: its price_history is empty and woolworths.price is a pack price, not $/kg, so it
// returned a meaningless value (the "per-kg items sort weird" bug).
function memberRawHistory(m) {
  return [...(m.price_history || []), ...(m.ww_price_history || []), ...(m.coles_price_history || [])]
    .map(e => e.price).filter(p => p > 0);
}

// A group's PAST prices, expressed in the same unit as groupMetric() - so the
// range and the point being placed in it are the same kind of number. Flag
// precedence matches groupMetric: perPack BEFORE sticker (nappies set both).
function groupPastPrices(group) {
  if (group._perPack) {
    // The metric is dollars-per-piece, so the history has to be per-piece too.
    // Measuring a $0.29 nappy against a range of $11-$25 PACK prices put every
    // per-piece category below its own floor, i.e. permanently "cheapest ever".
    // Honours the same per-point exclusions and per-store flags memberPerKgPrices
    // does: a series the user has pruned must be pruned HERE too, or the bar's
    // minimum and the sort's minimum quietly disagree - which is exactly how a
    // row sitting below its own drawn minimum failed to sort ahead of one merely
    // sitting on it.
    return group._members.flatMap(m => {
      const [useWw, useCo] = memberStoreFlags(group, m);
      const n = packCountOf(m.list_item) || packCountOf(m.woolworths?.name) || packCountOf(m.coles?.name);
      if (!(n > 0)) return [];
      const { ww: wwEx, co: coEx } = exclSetsFor(m.list_item);
      // NOT rounded here. These are per-ONE-piece figures that metricShown will
      // multiply back up by the category's quote, so a third decimal at this
      // scale is a coarse grid, not a fine one: a 40-pack at $11.50 is
      // $0.2875/piece, and toFixed(3) shaved that to $0.287 - which came out as
      // a $14.35 floor on a bar whose real low was $14.38, making the category
      // look permanently below its own cheapest price. Round once, at the end,
      // where the number is displayed.
      const take = (arr, use, ex) => (!use ? [] : (arr || [])
        .filter(e => e.price > 0 && !ex.has(Number(e.price).toFixed(2)))
        .map(e => e.price / n));
      return [
        ...take(m.price_history,       useWw, wwEx),
        ...take(m.ww_price_history,    useWw, wwEx),
        ...take(m.coles_price_history, useCo, coEx),
      ];
    });
  }
  // Sticker groups compare on the raw pack price, so the range is raw too.
  if (group._sticker) return group._members.flatMap(memberRawHistory);
  return group._members.flatMap(m => memberPerKgPrices(m, ...memberStoreFlags(group, m), true));
}

// The same past, reduced to what the category actually COST: the cheapest member
// at each store on each date, i.e. at most two points per scrape. See
// loadTrendRangeMode() in utils.js for why the flat "every member's every price"
// range was misleading.
//
// Built from buildGroupHistoryItem rather than a second reduction of its own -
// that function already does the hard parts (per-store, forward-filled so an
// unscraped-but-cheaper member still wins its date, per-point and per-member
// exclusions honoured) and this way the bar cannot drift from the history chart
// the clock button opens, because they are the same numbers.
//
// NOTE the units: these come back ALREADY scaled for display, the same scaling
// metricShown() applies, for all three group shapes - so callers must NOT put
// them through metricShown a second time. groupPastPrices() is the opposite
// (raw $/kg or per ONE piece) and does need it. group_history_units_selfcheck.js
// pins that difference; getting it wrong is the 10x phantom-jump bug again.
//
// ponytail: memoized on the per-render group OBJECT, so the entry dies with the
// render and there is nothing to invalidate. Ceiling: no reuse ACROSS renders -
// if that ever shows up in a profile, key a Map on _groupKey + last_updated.
const _groupBestSeriesCache = new WeakMap();
function groupBestPastShown(group) {
  let out = _groupBestSeriesCache.get(group);
  if (!out) {
    const h = buildGroupHistoryItem(group);
    out = [...h.ww_price_history, ...h.coles_price_history]
      .map(e => e.price).filter(p => p > 0);
    _groupBestSeriesCache.set(group, out);
  }
  return out;
}

function groupTrendPosition(group) {
  const cands = [group._wwBest, group._coBest].filter(Boolean);
  if (!cands.length) return 999;
  const best = cands.reduce((a, b) => (a.perkg <= b.perkg ? a : b));
  // Measured against history ONLY and left UNCLAMPED - the two rules
  // calcTrendPosition follows for a normal item. Groups used to do neither:
  // today's price was inside the range (so a group at its own low landed exactly
  // on 0 instead of below it) and the result was clamped to [0,1] (so it could
  // never go below 0 anyway). Eleven of 26 groups therefore tied on 0 and the
  // A-Z tiebreak stacked every category at the top of a trend sort, which is
  // exactly the "per-kg items come first" report.
  // Same series the BAR draws (see groupTrendCellHTML), in the same DISPLAY
  // units, so the sort keeps agreeing with the picture. Both modes go through
  // metricShown now: the normalised position is scale-invariant, but the
  // flat-range epsilons below are absolute money, so mixing a raw $/kg `cur`
  // with a /100g series graded a flat category against the wrong number - and
  // an unrounded `cur` lost to its own rounded series by a float hair, which is
  // how a category sitting exactly ON its all-time low was drawn beneath it.
  const bestOnly = loadTrendRangeMode() === 'best';
  const past = bestOnly ? groupBestPastShown(group)
                        : groupPastPrices(group).map(p => metricShown(group, p));
  const cur = metricShown(group, best.perkg);
  if (past.length < 2 || cur == null) return 999;
  const lo = Math.min(...past), hi = Math.max(...past);
  if (lo === hi) {
    if (cur < lo - 0.005) return -1;
    if (cur > lo + 0.005) return 2;
    return 0.5;
  }
  return (cur - lo) / (hi - lo);
}

// Trend position for any row: groups use their $/kg series, normal items use the shared
// calcTrendPosition. One dispatcher so desktop and mobile trend sorts stay consistent.
function trendPositionOf(item) {
  return item._isGroup ? groupTrendPosition(item) : calcTrendPosition(item, getUnits(item.list_item));
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

function groupStoreVariantsHTML(group, store, overrides, globalBest, globalTied) {
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
      // ONE metric for the panel and the headline: groupMetric decides per-piece,
      // pack price or $/kg. Computing it a second way here is how the two drift.
      return { name: m.list_item, res,
               pk: groupMetric({ sticker: group._sticker, perPack: group._perPack }, res, m.list_item) };
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
    // Size in brackets on EVERY member, not just where two names collide: in a
    // $/kg category the pack size is what tells the rows apart, so it is part of
    // the identity rather than a tie-breaker. nameWithSize() lives in utils.js.
    let name = nameWithSize(displayName(v), v.name);
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
    // Best at THIS store vs best ANYWHERE are different claims. Every column
    // marking its own winner green left three green rows and no way to see that
    // ALDI beat both supermarkets - so the overall winner gets its own tag.
    const isTop = globalBest != null && !globalTied && v.pk <= globalBest + 0.0001;
    const inBasket = _selectedItems.has(v.name);
    return `<div class="vg-pv${isWin ? ' win' : ''}${isTop ? ' vg-top' : ''}">
        ${imgHtml}
        ${nameHtml}${multiBuyTagAlways(v.res)}
        <span class="vg-pv-pack">${pack}</span>
        <span class="vg-pv-kg">${fmtUnitMetric(metricShown(group, v.pk))}${group._metricSuffix ?? (group._sticker ? '' : '/kg')}</span>
        <button class="vg-pv-basket${inBasket ? ' selected' : ''}" data-item="${safeKey}" title="${inBasket ? 'Remove from basket' : 'Add to basket'}" aria-label="${inBasket ? 'Remove from basket' : 'Add to basket'}">${inBasket ? '✓' : '＋'}</button>
      </div>`;
  }).join('');

  return variantRows;
}

// Group sub-label: per-store product counts (e.g. "2 Woolworths · 1 Coles").
// "N products" was ambiguous - it counted the deduped union of list-items, which
// rarely matched the two store columns the user actually sees.
// Returns HTML, not text: the store initial is bolded and the count left plain,
// so "7 W · 11 C" scans as a count-per-store instead of running together. Both
// values are numbers straight from the counters, so there is nothing to escape.
function groupSubLabel(group) {
  const parts = [];
  if (group._wwCount) parts.push(`${group._wwCount} <b>W</b>`);
  if (group._coCount) parts.push(`${group._coCount} <b>C</b>`);
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
  const _sfx = group._metricSuffix ?? group._unitSuffix;
  const suf = _sfx ? `<span class="perkg-suffix">${_sfx}</span>` : '';
  const priceHtml = (perkg, url) => perkg == null
    ? '<span class="no-data">-</span>'
    : (url
      ? `<a href="${url}" target="_blank" rel="noopener" class="price-link">${fmtUnitMetric(metricShown(group, perkg))}${suf}</a>`
      : `${fmtUnitMetric(metricShown(group, perkg))}${suf}`);

  // The empty unit line is deliberate: a group's headline IS $/kg so there is no
  // second measure to show, but the element reserves the same line a normal
  // card's $/100g occupies, keeping both card types the same height.
  const wwHtml = `<div class="card-store-price-row"><span class="store-chip ww sm">W</span><span class="card-store-price">${priceHtml(group._wwPerKg, wwUrl)}</span></div><div class="card-store-unit"></div>`;
  const coHtml = `<div class="card-store-price-row"><span class="store-chip coles sm">C</span><span class="card-store-price">${priceHtml(group._coPerKg, coUrl)}</span></div><div class="card-store-unit"></div>`;

  // Both sides need a $/kg figure before either can "win" - see the per-item
  // card's identical guard a few lines up in renderCards().
  const wwClass = (wwBest && coBest && cheaper === 'woolworths') ? 'winner-ww' : '';
  const coClass = (wwBest && coBest && cheaper === 'coles')      ? 'winner-coles' : '';

  // Same always-present verdict row as the per-item card, off the same
  // rowStoreTotal() the table sums - so a tie shows "=" and holds its line
  // instead of collapsing and floating this card's trend bar out of alignment.
  const savingHtml = `<div class="card-saving">${cardVerdictHTML(group)}</div>`;

  const bar = groupTrendCellHTML(group, false);

  return `<div class="item-card" data-item="${safeKey}" data-group="${group._groupKey}">
    <div class="card-top">
      <input type="checkbox" class="row-check card-check" data-item="${safeKey}"${isChecked ? ' checked' : ''}>
      <div class="card-img-wrap">${imgHtml}</div>
      <div class="card-info">
        <div class="card-name">${esc(group._groupLabel)}</div>
        <div class="card-cat">${esc(getCategory(group))} · ${groupSubLabel(group)}</div>
      </div>
      ${cardWatchHTML(group.list_item)}
    </div>
    <div class="card-prices">
      <div class="card-store ${wwClass}">${wwHtml}</div>
      <div class="card-store ${coClass}">${coHtml}</div>
    </div>
    ${savingHtml}
    ${bar ? `<div class="card-bar">${bar}</div>` : ''}
    ${cardFooterHTML(group.list_item, !!bar)}
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
        <span class="vg-group-sub">${groupSubLabel(group)}${groupThirdChipHTML(group)}</span>
      </div>
    </div></td>`;

  const wwUrl = wwBest ? (overrides[wwBest.name]?.wwUrl || wwBest.result?.url || null) : null;
  const coUrl = coBest ? (overrides[coBest.name]?.colesUrl || coBest.result?.url || null) : null;

  // Both sides need a $/kg figure before either can "win" - the badge column a
  // few lines down already applies this exact guard (N/A when either is
  // missing); the price cells' tint+checkmark just hadn't matched it.
  const wwClass = (wwBest && coBest && cheaper === 'woolworths') ? 'cell-ww' : '';
  const coClass = (wwBest && coBest && cheaper === 'coles') ? 'cell-coles' : '';

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
      <span class="units-val">${unitsLabel(group.list_item, units)}</span>
      <button class="units-inc" data-item="${group.list_item}">+</button>
    </div></td>`;

  // Per-group priority (stored under the synthetic group key, shared by all members).
  const gp = getPriority(group.list_item);
  const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${group.list_item}">
      <option value="weekly"${gp === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${gp === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${gp === 'rare' ? ' selected' : ''}>Rare</option>
    </select></td>`;

  // Via groupStoreTotal so the table and the basket cost a category through
  // ONE function - and so a per-piece row totals at the price it displays.
  const wwTotal = groupStoreTotal(group, 'ww');
  const coTotal = groupStoreTotal(group, 'coles');
  // Two independent per-store totals (matches normal rows); cheaper side tinted.
  const gCell = (v, isWin, cls) =>
    `<td class="total-cell ${isWin ? cls : ''}" style="font-size:13px;font-weight:600;white-space:nowrap">${
      v != null ? fmt(v) : '<span class="no-data">-</span>'}</td>`;
  const gWwWin = wwTotal != null && coTotal != null && wwTotal < coTotal - 0.005;
  const gCoWin = wwTotal != null && coTotal != null && coTotal < wwTotal - 0.005;
  let savingContent = '<span class="no-data">-</span>';
  if (group._wwPerKg != null && group._coPerKg != null) {
    // Saving is the gap between the two TOTALS, so it can never disagree with
    // the two numbers printed either side of it.
    const sav = Math.abs(wwTotal - coTotal);
    savingContent = sav > 0 ? `<span class="saving-cell">${fmt(sav)}</span>` : '<span class="no-data">$0.00</span>';
  }

  // A group has no last_scraped of its own - it isn't a row the scraper ever
  // writes. Its members are, so the group reports the FRESHEST member: the group
  // is as current as the most recently checked thing in it. This cell used to be
  // blank, which read as "never scraped" rather than "not applicable".
  const gScrapedTs = groupLastScraped(group);
  const gScrapedCell = gScrapedTs
    ? new Date(gScrapedTs).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    : '-';

  const tds = {
    name:         nameCell,
    trend:        `<td class="trend-cell">${groupTrendCellHTML(group)}</td>`,
    priority:     priorityCell,
    units:        unitsCell,
    ww:           `<td class="price-cell ${wwClass}">${perKgCellHTML(metricShown(group, group._wwPerKg), wwUrl, group._metricSuffix ?? group._unitSuffix)}</td>`,
    coles:        `<td class="price-cell ${coClass}">${perKgCellHTML(metricShown(group, group._coPerKg), coUrl, group._metricSuffix ?? group._unitSuffix)}</td>`,
    cheaper:      `<td class="cheaper-cell">${badgeHtml}</td>`,
    pct:          `<td class="pct-cell">${pctHtml}</td>`,
    saving:       `<td><div class="saving-row">${savingContent}</div></td>`,
    trips:        `<td class="trips-cell"></td>`,
    category:     `<td style="font-size:12px;color:var(--text-mid)">${getCategory(group)}</td>`,
    last_scraped: `<td style="font-size:11px;color:var(--text-soft);white-space:nowrap">${gScrapedCell}</td>`,
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
  // A third column for outside stores, appended into this SAME panel rather than
  // a second popup - the category's expand state already opened this panel, so
  // reusing it means one click gets you everything instead of two. Only present
  // when the chip's own toggle (_thirdOpen, same Set the plain-item chip uses)
  // is on AND the category actually has any outside-store data.
  const gThirdEntries = groupThirdEntries(group);
  // Highlighting and the verdict both have to use the category's OWN scale -
  // see groupThirdScale for why a weighed group gets neither.
  const gScale = groupThirdScale(group);
  const gMetricPrices = [gScale.ww?.price, gScale.co?.price].filter(p => p != null);
  const gBeat = groupThirdBeat(group, gThirdEntries);
  const showThird = gThirdEntries.length && isThirdOpen(group.list_item, gBeat);
  // One "cheapest" across all three columns, on the category's own metric.
  const gThirdMetrics = gThirdEntries.map(e => thirdGroupMetric(group, e)).filter(v => v != null);
  const gBestMetric = [...gMetricPrices, ...gThirdMetrics].length
    ? Math.min(...gMetricPrices, ...gThirdMetrics) : null;
  // Two shops genuinely level on the metric. A frame says "this one wins", so
  // when nothing wins outright we fall back to the plain green on each - a box
  // around one of two identical prices is just wrong.
  // The FRAME is a different question from the third column's green mark:
  // Woolworths and Coles are always comparable with each other, even on a
  // weighed category where an outside store's rate is not. gBestMetric stays as
  // it was (it drives that green mark); groupFrameBest decides the outline.
  const gFrame = groupFrameBest(group, gThirdEntries);
  // Collapsed, the outside stores are a narrow rail on the RIGHT rather than a
  // third of the panel's width: two supermarket columns stay full-size, which is
  // what you actually compare, and the rail costs ~28px to say "there is more
  // here". Expanded it becomes a normal column. Cheaper-elsewhere opens itself.
  const thirdCol = !gThirdEntries.length ? ''
    : showThird
    ? `<div class="vg-panel-store third-open-col">
        <button class="third-fold" data-third="${escAttr(group.list_item)}"${gBeat ? ' data-third-beats="1"' : ''} title="Hide other stores" aria-label="Hide other stores"><span class="third-fold-ic">✕</span></button>
        ${groupThirdRowsHTML(group, gThirdEntries, gBestMetric, imgSrc, gFrame)}
      </div>`
    : `<button class="third-rail${gBeat ? ' beats' : ''}" data-third="${escAttr(group.list_item)}"${gBeat ? ' data-third-beats="1"' : ''}
         title="Show ${gThirdEntries.length} other store${gThirdEntries.length > 1 ? 's' : ''}">
        <span class="third-rail-count">＋${gThirdEntries.length}</span>
      </button>`;
  const panel = `<tr class="vg-panel-row" data-group="${group._groupKey}"><td colspan="${colSpan}">
    <div class="vg-panel">
      <div class="vg-panel-head">
        <span class="vg-panel-title">${esc(group._groupLabel)}</span>
        ${winnerTag}
      </div>
      <div class="vg-panel-cols${showThird ? ' third-cols' : (gThirdEntries.length ? ' third-rail-cols' : '')}">
        <div class="vg-panel-store">
          <div class="vg-store-h"><span class="store-chip ww sm">W</span> Woolworths</div>
          ${groupStoreVariantsHTML(group, 'woolworths', overrides, gFrame.best, gFrame.tied)}
        </div>
        <div class="vg-panel-store">
          <div class="vg-store-h"><span class="store-chip coles sm">C</span> Coles</div>
          ${groupStoreVariantsHTML(group, 'coles', overrides, gFrame.best, gFrame.tied)}
        </div>
        ${thirdCol}
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
  // Both sides need a $/kg figure before either can "win" against the other -
  // same guard as the desktop table/card group rows.
  const bothPriced = group._wwPerKg != null && group._coPerKg != null;
  const wwWin = bothPriced && cheaper === 'woolworths', coWin = bothPriced && cheaper === 'coles';
  const borderCls = wwWin ? ' cheaper-ww' : coWin ? ' cheaper-coles' : '';

  // Same layout as a normal mobile card in BOTH views: compact = the same
  // single-line row, detailed = image + name/icons/priority + trend + prices.
  // Only two things mark it as per-kg - the /kg price suffix and the expand
  // chevron sitting at the end of the prices row. The 🔥 uses the same
  // isHotDeal() as every other item; the 👁 watches the whole CATEGORY (the
  // group key), not individual member products.
  const wwKg = group._wwPerKg != null ? fmtUnitMetric(metricShown(group, group._wwPerKg)) : '-';
  const coKg = group._coPerKg != null ? fmtUnitMetric(metricShown(group, group._coPerKg)) : '-';
  // The suffix is the category's own metric, NOT always "/kg" - this card had
  // it hardcoded, so every per-piece and sticker category read as a weight on
  // mobile ("$0.35/kg" for a nappy, "$4.90/kg" for a deodorant). Desktop has
  // always used _metricSuffix here; this is the same expression.
  const mSuf = group._metricSuffix ?? (group._sticker ? '' : '/kg');
  const mSufHtml = mSuf ? `<span class="vgm-kg-suffix">${esc(mSuf)}</span>` : '';
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
          <div class="mc-badges-left">${prioHtml}${groupThirdChipHTML(group)}</div>
        </div>
      </div>
    </div>
    ${bar ? `<div class="mc-bar">${bar}</div>` : ''}
    <div class="mc-prices">
      <div class="mc-store-col">
        <div class="mc-store-label ww-col"><span class="store-chip sm ww">W</span> Woolworths</div>
        <div class="mc-price${wwWin ? ' cheaper' : ''}">${wwKg}${mSufHtml}</div>
      </div>
      <div class="mc-store-col">
        <div class="mc-store-label coles-col"><span class="store-chip sm coles">C</span> Coles</div>
        <div class="mc-price${coWin ? ' cheaper-c' : ''}">${coKg}${mSufHtml}</div>
      </div>
      <button class="vgm-chevron-btn" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Hide store options' : 'Show store options'}" title="${isExpanded ? 'Hide store options' : 'Show store options'}">${isExpanded ? '▾' : '▸'}</button>
    </div>`;

  if (isExpanded) {
    // Outside stores stack UNDER the two supermarkets here rather than beside
    // them - a phone has no room for a third column, and the desktop panel's
    // right-hand rail becomes a normal collapsed section on this axis. Same
    // open-by-default-when-cheaper rule as everywhere else (see isThirdOpen).
    const mThirdEntries = groupThirdEntries(group);
    const mScale = groupThirdScale(group);
    const mMetricPrices = [mScale.ww?.price, mScale.co?.price].filter(p => p != null);
    const mBeat = groupThirdBeat(group, mThirdEntries);
    const mOpen = isThirdOpen(group.list_item, mBeat);
    // Cheapest across BOTH supermarkets and the outside stores, on the category's
    // own metric - so the green "win" row means the same thing in all three.
    const mThirdMetrics = mThirdEntries.map(e => thirdGroupMetric(group, e)).filter(v => v != null);
    const mBest = [...mMetricPrices, ...mThirdMetrics].length
      ? Math.min(...mMetricPrices, ...mThirdMetrics) : null;
    const mFrame = groupFrameBest(group, mThirdEntries);
    const thirdSec = !mThirdEntries.length ? '' : `
      <div class="vgm-store-sec vgm-third-sec${mOpen ? ' open' : ''}">
        <button class="vgm-third-h${mBeat ? ' beats' : ''}" data-third="${escAttr(group.list_item)}"${mBeat ? ' data-third-beats="1"' : ''} aria-expanded="${mOpen}">
          <span class="vgm-third-label"><span class="vgm-third-count">${mThirdEntries.length}</span></span>
          ${mOpen ? '' : '<span class="vgm-third-toggle">Show ▼</span>'}
        </button>
        ${mOpen ? `<button class="third-fold" data-third="${escAttr(group.list_item)}"${mBeat ? ' data-third-beats="1"' : ''} title="Hide other stores" aria-label="Hide other stores"><span class="third-fold-ic">✕</span></button>` : ''}
        ${mOpen ? groupThirdRowsHTML(group, mThirdEntries, mBest, imgSrc, mFrame) : ''}
      </div>`;
    html += `<div class="vgm-body">
      <div class="vgm-store-sec">
        <div class="vg-store-h"><span class="store-chip ww sm">W</span> Woolworths</div>
        ${groupStoreVariantsHTML(group, 'woolworths', overrides, mFrame.best, mFrame.tied)}
      </div>
      <div class="vgm-store-sec">
        <div class="vg-store-h"><span class="store-chip coles sm">C</span> Coles</div>
        ${groupStoreVariantsHTML(group, 'coles', overrides, mFrame.best, mFrame.tied)}
      </div>
      ${thirdSec}
    </div>`;
  }

  card.innerHTML = html;
  container.appendChild(card);
}

// ── Per-kg category edit modal ────────────────────────────────────────────────
let _catEditKey = null;
let _catEditOrig = null; // per-store membership at modal-open, for removal detection
// The item name when the editor was opened on a plain product, else null. Such a
// product is NOT a category yet - see saveCategoryEdit, which only files one once
// the product has actually grown past what a plain item can express.
let _catEditPlain = null;
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

const CAT_STORE_LABEL = { ww: 'Woolworths', coles: 'Coles', third: 'Other store' };

// The pieces-per-pack cell. Deliberately NOT something you have to fill in:
// packCountOf() already reads "40 Pack" / "20pk" out of the product name and that
// is what groupMetric() uses, so this shows the parsed number greyed out and only
// becomes a real value once typed in. It exists for the occasional product whose
// name doesn't state a count - not as a data-entry chore.
// Rendered for every row but only VISIBLE under "Per piece" (see catEditApplyMetric),
// so switching metric doesn't have to rebuild the columns.
// `editable` only for third-store rows: third_store.json has a real `packs` field
// that thirdUnitPrice() reads. A Woolworths/Coles member has no such slot - its
// count comes from the product NAME, which is the input directly to its left, so
// the box is a read-only readout of what packCountOf() got. Blank means "the name
// doesn't state a count", which is exactly the thing worth seeing.
// `name` may be several candidate strings; the first that states a count wins.
// groupMetric reads `packCountOf(list_item) || packCountOf(scrapedName)`, so the
// cell has to try the SAME sources in the SAME order or it reports "?" for rows
// the metric is happily pricing per piece - which is what the Woolworths nappies
// did: their display name carries no pack size, their list_item does.
function catEditPcsCell(name, editable) {
  const auto = [].concat(name).map(n => packCountOf(n)).find(n => n > 0) || null;
  const title = editable
    ? 'Pieces in the pack. Filled in from the product name - type only to override.'
    : 'Pieces in the pack, read from the product name. Edit the name to change it.';
  return `<label class="cat-pcs" title="${escAttr(title)}">
        <span>pcs</span>
        <input type="text" inputmode="numeric" class="cat-pcs-in${auto ? ' auto' : ''}"
               value="${auto || ''}" data-auto="${auto || ''}" placeholder="?"${editable ? '' : ' readonly'} />
      </label>`;
}

function catEditNewRow(store) {
  const label = CAT_STORE_LABEL[store] || 'Store';
  // A third-store row has no store picker: thirdStoreFromUrl() resolves the shop
  // from the pasted link's hostname, so asking twice would just be a way to
  // disagree with the URL. The resolved name is echoed back in .cat-third-tag.
  const ph = store === 'third'
    ? `${thirdStoreNames(' / ')} URL`
    : `${label} product URL`;
  return `<div class="cat-prod" data-store="${store}" draggable="true">
        <span class="cat-item-handle">⠿</span>
        <input type="checkbox" class="cat-incl" checked title="Include in the comparison" />
        <div class="cat-prod-main">
          <input type="text" class="cat-name" value="" placeholder="${label} product name" />
          <input type="text" class="cat-url" value="" placeholder="${escAttr(ph)}" />
          ${store === 'third' ? '<span class="cat-third-tag"></span>' : ''}
        </div>
        ${catEditPcsCell('', store === 'third')}
        <button class="cat-prod-remove" title="Remove from this store">✕</button>
      </div>`;
}

// Which of the three comparison metrics a category is currently on, and the
// flag pair each one means. perPack is checked BEFORE sticker in groupMetric(),
// so "piece" must set perPack; it also sets sticker so the Units column counts
// PACKS rather than kilos (you buy a box of nappies, not 1.2kg of them).
const CAT_METRICS = {
  pack:  { sticker: true,  perPack: false, note: 'Compared on the shelf price of the pack.' },
  kg:    { sticker: false, perPack: false, note: 'Compared on $/kg, so different pack sizes line up.' },
  piece: { sticker: true,  perPack: true,  note: 'Compared on the price of ONE piece, using the pcs box on each row.' },
};
function catMetricOf(cat) {
  return cat?.perPack ? 'piece' : (cat?.sticker ? 'pack' : 'kg');
}

// Where this editor's outside-store links live in third_store.json.
function thirdStoreKeyFor() {
  return _catEditPlain || ('__group_' + _catEditKey);
}

// ONE editor for everything. A plain product is not a different kind of thing
// from a category - it is a category that happens to have one row per store - so
// it gets the identical dialog rather than a cut-down form plus a button to
// "convert". Nothing is created on open: a plain product stays a plain product in
// storage until you actually give it a second product or a non-default metric,
// at which point saveCategoryEdit files the category for you. That is the whole
// mode switch, removed by making the two cases indistinguishable to use.
function openProductEditor(itemName) {
  const item = _lastData?.items?.find(i => i.list_item === itemName);
  if (!item) return;
  const ov = loadOverrides()[itemName] || {};
  const cat = {
    key: categoryKeyFor(itemName),
    label: ov.displayName || itemName,
    category: item.category,
    sticker: false, perPack: false,
    items: [itemName],
  };
  // Only list the item under a store it actually has, so an unpinned Coles-only
  // product doesn't open with a phantom empty Woolworths row.
  const stores = {
    ww:    (item.woolworths || ov.wwUrl)    ? [itemName] : [],
    coles: (item.coles      || ov.colesUrl) ? [itemName] : [],
  };
  openCategoryEditModal(cat.key, { cat, stores, plain: itemName });
}

// `opts` is the plain-product path above; without it this resolves a real
// category by key exactly as before.
// Open the SAME editor with nothing in it. This is the one route into the app
// for a product it has never scraped: name it, paste the store links, save.
// Everything else in the UI edits a row that already exists, which meant a new
// product could only be added by hand-editing url_overrides.json.
let _catEditIsNew = false;
function openNewProductModal() {
  const label = (prompt('Name this product or category\n\ne.g. "Cadbury Dairy Milk" or "Aero Peppermint"') || '').trim();
  if (!label) return;
  const key = categoryKeyFor(label);
  if (!key) { alert('That name has no letters or numbers in it - try another.'); return; }
  if (loadVariantGroups().some(g => g.key === key)) {
    alert(`"${label}" already exists - open it from its own row to edit it.`);
    return;
  }
  _catEditIsNew = true;
  openCategoryEditModal(key, {
    // A synthetic seed: no members yet, and $/kg to start because that is the
    // right default for anything sold in varying pack sizes.
    cat: { key, label, items: [], sticker: false, perPack: false, category: 'Pantry' },
    stores: { ww: [], coles: [] },
  });
  // One empty row per supermarket, so the dialog opens ready to paste into.
  ['ww', 'coles'].forEach(store => {
    const list = document.querySelector(`#catEditBody .cat-col-list[data-store="${store}"]`);
    if (list && !list.querySelector('.cat-prod')) list.insertAdjacentHTML('beforeend', catEditNewRow(store));
  });
  if ($('catEditTitle')) $('catEditTitle').textContent = `New — ${label}`;
  if ($('catEditSave')) $('catEditSave').textContent = 'Create';
}

function openCategoryEditModal(groupKey, opts) {
  const cat = opts?.cat || loadVariantGroups().find(g => g.key === groupKey);
  if (!cat || !_lastData) return;
  _catEditKey = groupKey;
  _catEditPlain = opts?.plain || null;
  const byName = new Map(_lastData.items.map(i => [i.list_item, i]));
  const ov = loadOverrides();
  const excl = loadPerKgExclusions();
  const stores = opts?.stores || resolveStoreLists(cat, byName);
  // Snapshot the per-store membership so save can detect deletions (a member the
  // user pulled out of a store's column) and actually make them stick - see
  // saveCategoryEdit's removal handling.
  _catEditOrig = { ww: [...stores.ww], coles: [...stores.coles] };

  $('catEditName').value = cat.label;
  // Same dialog, honest labels: it is "this product" until it has rivals in it.
  if ($('catEditTitle')) $('catEditTitle').textContent = `Edit — ${cat.label}`;
  if ($('catEditSave')) $('catEditSave').textContent = 'Save';

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
        <input type="checkbox" class="cat-incl"${incl ? ' checked' : ''} title="Include in the comparison" />
        <div class="cat-prod-main">
          <input type="text" class="cat-name" value="${escAttr(name)}" placeholder="${escAttr(label)} product name" />
          <input type="text" class="cat-url" value="${url}" placeholder="${label} product URL" />
        </div>
        ${catEditPcsCell([itemName, name, data?.woolworths?.name, data?.coles?.name], false)}
        <button class="cat-prod-remove" title="Remove from this store">✕</button>
      </div>`;
  };

  // Third-store rows. These edit the GROUP-level list (`__group_<key>`) only -
  // a third-store link attached to an individual MEMBER was added from that
  // item's own dialog and stays its business, so it is left untouched here
  // rather than being hoovered up and rewritten under the group key.
  const thirdRow = (e) => {
    const store = e.store || thirdStoreFromUrl(e.url);
    const meta = THIRD_STORES[store];
    return `<div class="cat-prod" data-store="third" data-third="1" draggable="true">
        <span class="cat-item-handle">⠿</span>
        <input type="checkbox" class="cat-incl" checked title="Include in the comparison" />
        <div class="cat-prod-main">
          <input type="text" class="cat-name" value="${escAttr(e.name || '')}" placeholder="Product name" />
          <input type="text" class="cat-url" value="${escAttr(e.url || '')}" placeholder="${escAttr(thirdStoreNames(' / ') + ' URL')}" />
          <span class="cat-third-tag">${meta ? esc(meta.label) : ''}${
            e.status ? ` · <span class="cat-third-warn">${esc(e.status)}</span>` : ''}</span>
        </div>
        ${catEditPcsCell(e.packs ? `${e.packs} pack` : (e.name || ''), true)}
        <button class="cat-prod-remove" title="Remove this link">✕</button>
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
      || '';
    return `<div class="cat-col">
        <div class="cat-col-h"><span class="store-chip ${chip} sm">${letter}</span> ${label}</div>
        <div class="cat-col-list" data-store="${store}">${rows}</div>
        <button class="cat-add-product${store === 'coles' ? ' cat-add-coles' : ''}" data-store="${store}">+ Add ${label} product</button>
      </div>`;
  };

  // A plain product's outside-store links are filed under its own name; a
  // category's under `__group_<key>`. Same column either way.
  const thirdEntries = (_thirdStores[thirdStoreKeyFor()] || []);
  const thirdCol = `<div class="cat-col cat-col-third">
        <div class="cat-col-h"><span class="store-chip third sm">＋</span> Other stores</div>
        <div class="cat-col-list" data-store="third">${
          thirdEntries.map(thirdRow).join('')
        }</div>
        <button class="cat-add-product cat-add-third" data-store="third">+ Add other-store product</button>
      </div>`;

  $('catEditBody').innerHTML = `
    <div class="cat-cols cat-cols3">
      ${colHTML('ww', stores.ww)}
      ${colHTML('coles', stores.coles)}
      ${thirdCol}
    </div>`;

  catEditApplyMetric(catMetricOf(cat));
  catEditApplyQuotes(pieceQuoteOf(cat), weightQuoteOf(cat));
  bindCategoryEditBody();
  document.body.style.overflow = 'hidden';
  $('categoryEditModal').classList.add('open');
}

// Reflect the chosen metric: highlight the segment, explain it, and show the pcs
// boxes only where they mean something. Kept as one function so the initial
// render and a click go through exactly the same path.
function catEditApplyMetric(metric) {
  const m = CAT_METRICS[metric] ? metric : 'kg';
  const seg = $('catEditMetric');
  if (seg) {
    seg.dataset.metric = m;
    seg.querySelectorAll('button').forEach(b => {
      const on = b.dataset.metric === m;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  const note = $('catEditMetricNote');
  if (note) note.textContent = CAT_METRICS[m].note;
  $('catEditBody')?.classList.toggle('show-pcs', m === 'piece');
  // Greyed out, not hidden, when the metric is not per-piece. Hiding it made the
  // row reflow on every metric click and left no sign the setting existed - and
  // the `hidden` attribute was being overridden by the row's own display:flex,
  // so it stayed visible on a $/kg category anyway.
  catEditRenderQuote(m);
}

// Reflect the chosen quote size. Separate from the metric so picking one does
// not disturb the other.
// ONE select for both quote kinds. Which set of options it shows is decided by
// the metric; the values for BOTH live on the element's dataset, so flipping
// Per piece -> Per kg -> Per piece never loses the piece quote you had chosen.
// Pack price gets a disabled placeholder rather than an empty slot, so the row
// is the same shape in all three states and nothing shifts under the cursor.
const QUOTE_OPTIONS = {
  piece: [[1, 'per 1'], [10, 'per 10'], [50, 'per 50'], [100, 'per 100']],
  kg:    [[1000, 'per kg'], [100, 'per 100g']],
  pack:  [['', 'per pack']],
};
const QUOTE_TITLES = {
  piece: 'How many pieces the price is quoted for. Pick roughly one pack, so the figure is a number you actually pay: 3c a wipe says nothing, $2.86 per 100 does.',
  kg:    'How much product the price is quoted for. A kilo of chocolate is four blocks nobody buys at once, so per 100g is the number in your hand; meat and produce are genuinely bought by the kilo.',
  pack:  'A pack price is already the price of one pack - there is nothing to quote it per.',
};

function catEditRenderQuote(metric) {
  const sel = $('catEditQuote');
  if (!sel) return;
  const m = QUOTE_OPTIONS[metric] ? metric : 'kg';
  sel.innerHTML = QUOTE_OPTIONS[m]
    .map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  sel.disabled = m === 'pack';
  sel.title = QUOTE_TITLES[m];
  if (m === 'piece') sel.value = String(sel.dataset.quote || PER_PIECE_QUOTE);
  else if (m === 'kg') sel.value = String(sel.dataset.gramQuote || PER_WEIGHT_QUOTE);
}

// Remember the value the user just picked, against whichever metric owns it.
function catEditQuoteChanged() {
  const sel = $('catEditQuote');
  const m = $('catEditMetric')?.dataset.metric;
  if (!sel || sel.disabled) return;
  if (m === 'piece') {
    const q = Number(sel.value);
    sel.dataset.quote = String(PIECE_QUOTES.includes(q) ? q : PER_PIECE_QUOTE);
  } else if (m === 'kg') {
    const g = Number(sel.value);
    sel.dataset.gramQuote = String(WEIGHT_QUOTES.includes(g) ? g : PER_WEIGHT_QUOTE);
  }
}

// Seed both stored values when the dialog opens.
function catEditApplyQuotes(quote, grams) {
  const sel = $('catEditQuote');
  if (!sel) return;
  sel.dataset.quote = String(PIECE_QUOTES.includes(Number(quote)) ? Number(quote) : PER_PIECE_QUOTE);
  sel.dataset.gramQuote = String(WEIGHT_QUOTES.includes(Number(grams)) ? Number(grams) : PER_WEIGHT_QUOTE);
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
    // Typing in the pcs box makes the number YOURS - drop the "auto" styling so
    // it is obvious which counts came from the name and which you set.
    const pcs = e.target.closest('.cat-pcs-in');
    if (pcs) { pcs.classList.toggle('auto', pcs.value.trim() === pcs.dataset.auto); return; }

    const urlInput = e.target.closest('.cat-url');
    if (!urlInput) return;
    const row = urlInput.closest('.cat-prod');
    if (!row) return;
    const url = urlInput.value.trim();

    // Third-store rows: echo back which shop the URL resolved to, so a typo or an
    // unsupported store is visible BEFORE saving rather than silently dropped.
    if (row.dataset.store === 'third') {
      const tag = row.querySelector('.cat-third-tag');
      const store = thirdStoreFromUrl(url);
      if (tag) {
        tag.textContent = !url ? '' : (store ? THIRD_STORES[store].label : 'Not a supported store');
        tag.classList.toggle('bad', !!url && !store);
      }
    }
    if (row.dataset.item) return;                    // existing rows keep their name
    const nameInput = row.querySelector('.cat-name');
    if (nameInput && !nameInput.value.trim()) {
      const derived = deriveNameFromUrl(url);
      if (derived) {
        nameInput.value = derived;
        // The name is what packCountOf() reads, so refresh an untouched pcs box.
        const p = row.querySelector('.cat-pcs-in');
        if (p && p.classList.contains('auto')) {
          const auto = packCountOf(derived) || '';
          p.value = auto; p.dataset.auto = auto;
        }
      }
    }
  });

  // Comparison metric.
  $('catEditQuote')?.addEventListener('change', catEditQuoteChanged);
  $('catEditMetric')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (b) catEditApplyMetric(b.dataset.metric);
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
  const plainName = _catEditPlain;

  // A plain product that is still one-product-per-store on a default metric has
  // nothing a category would add, so none is created - it saves through the same
  // url_overrides path the old Edit Item form used. Add a second product to a
  // column, or pick a different metric, and it becomes a category here, without
  // ever having asked which of the two you meant.
  if (plainName) {
    const rowsIn = (store) => [...document.querySelectorAll(
      `#catEditBody .cat-col-list[data-store="${store}"] .cat-prod`)];
    const grew = rowsIn('ww').length > 1 || rowsIn('coles').length > 1;
    const metricNow = $('catEditMetric')?.dataset.metric || 'kg';
    if (!grew && metricNow === 'kg') { savePlainProductEdit(plainName, label); return; }
    // Becoming a category: file it, then fall through and save as one. The
    // product itself is untouched - it is simply now the first member.
    saveVariantGroupOverride(key, {
      created: true, label: label || plainName,
      category: (_lastData?.items?.find(i => i.list_item === plainName) || {}).category || 'Pantry',
      add: [plainName], remove: [], sticker: false, perPack: false,
    });
    _catEditOrig = { ww: [], coles: [] };   // nothing was a member before now
  }

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
  // `remove` goes through categoryRemovals() (utils.js), NOT a bare defItems-minus-items
  // diff: a member absent from `items` only because the client's snapshot never saw it
  // (unpriced when the modal opened) must never be recorded as user-removed - see that
  // function's comment for the incident this guards against.
  // Other-stores column -> the group's own entry in third_store.json. The store is
  // taken from the URL's hostname (never asked for separately), and a row whose URL
  // resolves to no supported store is dropped rather than written as a broken entry.
  const thirdList = [];
  document.querySelectorAll('#catEditBody .cat-col-list[data-store="third"] .cat-prod').forEach(row => {
    const url = row.querySelector('.cat-url').value.trim();
    const nm = row.querySelector('.cat-name').value.trim();
    const store = thirdStoreFromUrl(url);
    if (!url || !store || !row.querySelector('.cat-incl').checked) return;
    const pcs = parseInt(row.querySelector('.cat-pcs-in')?.value, 10);
    // deriveNameFromUrl only understands WW/Coles slugs, so a Chemist Warehouse
    // link left un-named would otherwise save a blank row. Fall back to the
    // category's own label, which always reads sensibly ("Nappies size 6" at Big
    // W) - never drop the row silently just because the name box is empty.
    thirdList.push({ store, name: nm || deriveNameFromUrl(url) || label || key, url,
                     ...(pcs > 0 ? { packs: pcs } : {}) });
  });
  const thirdChanged = JSON.stringify(thirdList)
    !== JSON.stringify((_thirdStores['__group_' + key] || []).map(e => ({
         store: e.store, name: e.name, url: e.url, ...(e.packs ? { packs: e.packs } : {}) })));

  const defItems = (DEFAULT_VARIANT_GROUPS.find(d => d.key === key) || {}).items || [];
  const add = items.filter(n => !defItems.includes(n));
  const remove = categoryRemovals(defItems, [...orig.ww, ...orig.coles], items);
  // The comparison metric now lives in the override too, so it survives a reload
  // and syncs to the other device - see loadVariantGroups(), which reads these
  // override-first. Written explicitly (not omitted when false) so that turning a
  // seeded flag OFF is a real, storable choice.
  const metric = CAT_METRICS[$('catEditMetric')?.dataset.metric] || CAT_METRICS.kg;
  // Stored even when it matches the seed, same reasoning as sticker/perPack:
  // an omitted value is indistinguishable from "never chose", so a deliberate
  // change back to the seeded default would not stick.
  const quote = Number($('catEditQuote')?.dataset.quote) || PER_PIECE_QUOTE;
  const gramQuote = Number($('catEditQuote')?.dataset.gramQuote) || PER_WEIGHT_QUOTE;
  saveVariantGroupOverride(key, { label: label || undefined, add, remove, ww_order: wwItems, coles_order: coItems,
                                  sticker: metric.sticker, perPack: metric.perPack, quote, gramQuote,
                                  // Only a `created` override becomes a real category -
                                  // without it allVariantGroupSeeds() reads the entry as a
                                  // leftover patch to a seed that does not exist, and the
                                  // new product silently never appears.
                                  ...(_catEditIsNew ? { created: true } : {}) });
  savePerKgExclusions(excl);
  saveOverrides(ov);
  // Reflect the third-store edit locally straight away, so the panel updates on
  // this render rather than waiting for the next page load to re-fetch the file.
  if (thirdChanged) {
    if (thirdList.length) _thirdStores['__group_' + key] = thirdList;
    else delete _thirdStores['__group_' + key];
  }
  closeCategoryEditModal();
  if (_lastData) renderPage(_lastData);

  const s = loadSettings();
  const needRepo = newFetches.length || touchedItems.size || latestChanged || thirdChanged;
  if (needRepo && !s.token) {
    alert('Saved locally. Add your GitHub token (Auto-update Setup) so the change reaches the scraper and other devices.');
  } else if (needRepo) {
    // Exact-write the touched items so a removed URL is actually deleted from the
    // repo (merge-only writes could never drop a key). New products merge in.
    // Held so the new-product scrape below can wait on it - the run reads this
    // file, so dispatching before it lands is a race the scraper loses.
    const overridesWritten = persistUrlOverridesToRepo(s, ov, [...touchedItems])
      .catch(err => {
        showSyncError('URL overrides', err, () => persistUrlOverridesToRepo(s, ov, [...touchedItems]).catch(() => {}));
        throw err;   // a failed write must not be followed by a scrape of stale pins
      });
    if (latestChanged) {
      persistLatestJson(_lastData, `edit: ${key} - removed ${removals.map(r => `${r.item} @ ${r.store}`).join(', ')}`)
        .catch(err => showSyncError('latest.json', err));
    }
    if (thirdChanged) {
      persistThirdStoreList(s, '__group_' + key, thirdList)
        .catch(err => showSyncError('other-store links', err));
    }
    // New products' URLs live in url_overrides now - fetch their prices
    // immediately, in ONE run.
    //
    // This used to fire triggerItemRefresh per product, which is one
    // workflow_dispatch each: adding a 6-member category queued six runs on the
    // single self-hosted runner and paid the browser-startup cost six times.
    // A "new" run scrapes every never-priced item in one pass instead, so the
    // batch costs the same as one product.
    //
    // Awaited on the overrides write, not fired alongside it: the run reads
    // url_overrides.json from the repo, so dispatching in parallel is a race the
    // scraper loses about half the time - it starts, sees the old file, and finds
    // nothing new to do.
    if (newFetches.length) {
      const n = newFetches.length;
      showToast(`✓ Saved. Checking ${n} new product${n > 1 ? 's' : ''}…`);
      overridesWritten
        .then(() => triggerRefresh('new'))
        .catch(() => {});   // the write already reported its own failure
    } else if (removals.length) {
      showToast(`✓ Removed ${removals.length} store listing${removals.length > 1 ? 's' : ''} - the scraper will stop checking ${removals.map(r => r.store === 'ww' ? 'WW' : 'Coles').join('/')}.`);
    }
  }
}

// A product that is still one-per-store, saved through the same url_overrides
// path the old Edit Item form used - identical semantics, read out of the
// three-column editor instead of four stacked text boxes. Clearing a store's URL
// still MEANS "remove it from that store" (the remaining link becomes a
// single-store pin), which is why it refuses to clear both.
function savePlainProductEdit(name, label) {
  const rowUrl = (store) => {
    const row = document.querySelector(`#catEditBody .cat-col-list[data-store="${store}"] .cat-prod`);
    const v = (row?.querySelector('.cat-url')?.value || '').trim();
    return v && !v.startsWith('http') ? 'https://' + v : v;
  };
  const overrides = loadOverrides();
  const prev = overrides[name] || {};
  const item = _lastData?.items?.find(i => i.list_item === name);
  const newWw = rowUrl('ww'), newCo = rowUrl('coles');
  const prevWw = prev.wwUrl    || item?.woolworths?.url || '';
  const prevCo = prev.colesUrl || item?.coles?.url      || '';
  const wwRemoved = !!prevWw && !newWw, coRemoved = !!prevCo && !newCo;
  const wwChanged = !!newWw && newWw !== prevWw, coChanged = !!newCo && newCo !== prevCo;

  if (wwRemoved && coRemoved) {
    alert('Both links removed - that would leave the product with no store at all.\nUse Archive to stop tracking it, or keep at least one link.');
    return;
  }

  // Other-stores column, same rules as the category path.
  const thirdList = [];
  document.querySelectorAll('#catEditBody .cat-col-list[data-store="third"] .cat-prod').forEach(row => {
    const url = (row.querySelector('.cat-url').value || '').trim();
    const store = thirdStoreFromUrl(url);
    if (!url || !store || !row.querySelector('.cat-incl').checked) return;
    const pcs = parseInt(row.querySelector('.cat-pcs-in')?.value, 10);
    thirdList.push({ store, name: (row.querySelector('.cat-name').value || '').trim() || label || name,
                     url, ...(pcs > 0 ? { packs: pcs } : {}) });
  });
  const prevThird = (_thirdStores[name] || []).map(e => ({
    store: e.store, name: e.name, url: e.url, ...(e.packs ? { packs: e.packs } : {}) }));
  const thirdChanged = JSON.stringify(thirdList) !== JSON.stringify(prevThird);

  overrides[name] = { ...prev,
    displayName: label && label !== name ? label : undefined,
    wwUrl: newWw || undefined, colesUrl: newCo || undefined };
  if (!overrides[name].displayName && !overrides[name].wwUrl && !overrides[name].colesUrl) delete overrides[name];
  saveOverrides(overrides);

  if ((wwRemoved || coRemoved) && item) {
    if (wwRemoved) item.woolworths = null;
    if (coRemoved) item.coles = null;
    item.cheaper_store = null; item.saving_per_item = null;
  }
  if (thirdChanged) {
    if (thirdList.length) _thirdStores[name] = thirdList; else delete _thirdStores[name];
  }
  closeCategoryEditModal();
  if (_lastData) renderPage(_lastData);

  const s = loadSettings();
  if (!(s.user && s.repo && s.token)) {
    if (wwChanged || coChanged || wwRemoved || coRemoved || thirdChanged) {
      alert('Saved locally. Add your GitHub token (Auto-update Setup) so the change reaches the scraper and other devices.');
    }
    return;
  }
  persistUrlOverridesToRepo(s, overrides, [name])
    .catch(err => showSyncError('URL overrides', err));
  if (wwRemoved || coRemoved) {
    persistLatestJson(_lastData, `edit: ${name} - removed from ${wwRemoved ? 'Woolworths' : 'Coles'}`)
      .catch(err => showSyncError('latest.json', err));
    showToast(`✓ "${name}" removed from ${wwRemoved ? 'Woolworths' : 'Coles'}.`);
  }
  if (wwChanged || coChanged) {
    triggerItemRefresh(name, null, { wwUrl: newWw, colesUrl: newCo });
    showToast(`✓ Scrape triggered for "${name}" with the new URL.`);
  }
  if (thirdChanged) {
    // Priced by the pipeline's own third_stores.py step, not a single-item
    // dispatch - so say when the price arrives rather than leaving a link that
    // looks broken until then.
    persistThirdStoreList(s, name, thirdList)
      .then(() => showToast(thirdList.length
        ? '✓ Other-store link saved - its price arrives with the next scrape.'
        : `✓ Other-store link removed from "${name}".`))
      .catch(err => showSyncError('other-store links', err));
  }
}

function closeCategoryEditModal() {
  _catEditKey = null;
  _catEditPlain = null;
  _catEditIsNew = false;
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
// ONE dispatch for the whole category, not one per member. Firing N dispatches
// queued N workflow runs on a single self-hosted runner - each re-doing checkout
// and pip install - so a 9-member category took ~10 minutes and looked like the
// button had done nothing. The scraper splits this list on "|" (see its
// single_item branch) and patches every result back into latest.json.
function refreshCategory(groupKey, btn) {
  const cat = loadVariantGroups().find(g => g.key === groupKey);
  if (!cat || !cat.items.length) return;
  triggerItemRefresh(cat.items.join('|'), btn, {});
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
  // Everything before this divider sorts; everything after it filters.
  const sep = document.createElement('span');
  sep.className = 'mc-filter-sep';
  sep.setAttribute('aria-hidden', 'true');
  chipsWrap.appendChild(sep);
  chipsWrap.appendChild(watchChip);

  // Store filter, immediately after the eye: off -> W -> C -> off. One button
  // rather than three, because on a phone this is a thing you tap while walking
  // round a shop, and it only ever has one answer at a time.
  const storeChip = document.createElement('button');
  storeChip.className = 'mc-sort-chip mc-store-chip' + (_storeFilter ? ' active' : '');
  storeChip.innerHTML = _storeFilter === 'woolworths'
    ? '<span class="store-chip ww sm">W</span>'
    : _storeFilter === 'coles'
    ? '<span class="store-chip coles sm">C</span>'
    : '<span class="mc-store-off">W/C</span>';
  storeChip.title = _storeFilter
    ? `Showing only items cheaper at ${_storeFilter === 'woolworths' ? 'Woolworths' : 'Coles'} - tap to change`
    : 'Show only items cheaper at one store';
  storeChip.setAttribute('aria-label', 'Cheaper-store filter');
  storeChip.onclick = () => { cycleStoreFilter(); };
  chipsWrap.appendChild(storeChip);

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
    const cheaper = rowCheaperStore(item);  // multi-buy-aware, same verdict as the desktop table
    const ov      = overrides[item.list_item] || {};
    const displayName = ov.displayName || shortName(item.list_item);
    const priority = getPriority(item.list_item);
    const hotDeal  = isHotDeal(item, exclusions);
    const isWatchedMC = isWatchedItem(item.list_item);

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
    const _trendSeriesMC = getTrendSeries(item, getUnits(item.list_item));
    const barHtml = _trendSeriesMC.prices.length
      ? buildPriceBar(item.list_item, _trendSeriesMC.past.map(p => ({price: p})), _trendSeriesMC.current)
      : '';

    const { ww: wwP100, coles: coP100 } = per100Pair(ww, co);
    const wwUnit = wwP100.value != null ? `$${wwP100.value.toFixed(2)}/${wwP100.label}` : '';
    const coUnit = coP100.value != null ? `$${coP100.value.toFixed(2)}/${coP100.label}` : '';

    const prioLabels = { weekly: 'Weekly', monthly: 'Monthly', rare: 'Rare' };
    const prioHtml = prioLabels[priority]
      ? `<span class="mc-priority ${priority}">${prioLabels[priority]}</span>` : '';

    // Both stores need a price before either can "win" - see the desktop
    // table's identical guard for why this matters for single-store items.
    const wwCheaper = !!(ww && co) && cheaper === 'woolworths';
    const coCheaper = !!(ww && co) && cheaper === 'coles';
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
  // Desktop store filter: label carries the state, so the pill says what it is
  // doing rather than relying on a colour alone.
  const sfPill = $('storeFilterPill');
  if (sfPill) {
    sfPill.classList.toggle('active', !!_storeFilter);
    sfPill.innerHTML = _storeFilter === 'woolworths'
      ? '<span class="store-chip ww sm">W</span> Cheaper at WW'
      : _storeFilter === 'coles'
      ? '<span class="store-chip coles sm">C</span> Cheaper at Coles'
      : 'W/C';
    sfPill.title = _storeFilter
      ? `Showing only items cheaper at ${_storeFilter === 'woolworths' ? 'Woolworths' : 'Coles'} - click to change`
      : 'Show only items that are cheaper at one store';
  }

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
          ? `Starting price update…`
          : `Updating prices… ${prog.done} of ${prog.total}`;
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
  syncRefreshIdleTooltip();

  const _uiPriorities = loadPriorities();
  const _renderExclusions = loadExclusions();
  const isUiArchived = (i) => i.archived || _uiPriorities[i.list_item] === 'archive';
  const totalNonArchived = (data.items || []).filter(i => !isUiArchived(i)).length;
  const pricedBoth = (data.items || []).filter(i => !isUiArchived(i) && i.woolworths?.price != null && i.coles?.price != null).length;
  const missingCount = totalNonArchived - pricedBoth;
  const coverageText = missingCount > 0
    ? `${pricedBoth}/${totalNonArchived} priced · ${missingCount} missing`
    : `${totalNonArchived} items`;
  // The "🔥 N deals" link that used to sit here is gone by request. Hot Deals has
  // its own 🔥 in the header nav, so the count was a second entry point to the
  // same page on a line whose job is describing the DATA (how fresh, how
  // complete). Removing it also drops a getHotDealItems() pass over every item on
  // every render - it was the most expensive thing on this line by a wide margin.
  $('lastUpdated').innerHTML = `<span>Updated ${formatDate(data.last_updated)}</span><span>${coverageText}</span>`;
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
  // render inline as normal-looking rows (treated as Weekly).
  //
  // A member is NEVER a loose row - not even in the Archive view, which used to
  // be exempt "so the raw items remain individually reachable". That exemption
  // showed the same product twice: once nested in its category everywhere else,
  // and again loose under Archived. There is only ever ONE data entry per product
  // (the group is a live aggregate over its members, and an archived member still
  // feeds its group's price and history), so the second row was pure duplication.
  // Members are now managed through the group's ✎ edit dialog instead.
  {
    const memberNames = new Set(loadVariantGroups().flatMap(g => g.items));
    const byName = new Map(allDisplayItems.map(i => [i.list_item, i]));
    const groups = buildVariantGroups(byName).map(withGroupCounts);
    if (groups.length || memberNames.size) {
      allDisplayItems = allDisplayItems.filter(i => !memberNames.has(i.list_item));
      // Group rows themselves are Weekly, so they belong in every view EXCEPT
      // the archive one (where a Weekly row would be out of place).
      if (_activePriority !== 'archive') allDisplayItems.push(...groups);
    }
  }

  const categoryTabItems = _activePriority === 'archive'
    ? allDisplayItems.filter(i => i.archived || priorities[i.list_item] === 'archive')
    : _activePriority === 'watchlist'
      ? allDisplayItems.filter(i => isWatchedItem(i.list_item))
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
    const _trendSeriesPage = getTrendSeries(item, getUnits(item.list_item));
    // No `past.length` guard: buildPriceBar decides for itself whether it can
    // draw a trend, and now returns the History button alone when it can't. The
    // guard here meant a product scraped for the first time yesterday got a
    // completely empty Trend cell - no bar (fair, one price is not a trend) and
    // no way into its history either (not fair, that's where you'd go to look).
    const bar = buildPriceBar(item.list_item, _trendSeriesPage.past.map(p => ({price: p})), _trendSeriesPage.current);

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
          <div class="item-title-row">${esc(displayName)}${editBtn}${thirdChipHTML(item.list_item, thirdEntriesFor(item.list_item), ww, co)}</div>
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
      // shelfPrice, not ww.price: a by-weight item stores a $/kg RATE there. The
      // multi-buy branch keeps ww.price because a promo is priced off the pack,
      // and the two never coexist (WW multi-buys are on packaged goods, never on
      // loose produce).
      const wwShown = wwActive ? multiBuyCost(units, ww.price, ww.multi_buy) / units : shelfPrice(ww);
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
      const coShown = coActive ? multiBuyCost(units, co.price, co.multi_buy) / units : shelfPrice(co);
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

    const isWatched = isWatchedItem(item.list_item);
    const watchBtn  = `<button class="item-watch-btn${isWatched ? ' active' : ''}" data-item="${safeKey}" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}">👁</button>`;
    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;
    const unarchiveBtn = _activePriority === 'archive'
      ? `<button class="item-unarchive-btn" data-item="${safeKey}" title="Unarchive this item">↩ Unarchive</button>`
      : '';

    // Both stores need a price before either can "win" - matches the badge
    // column's own N/A guard a few lines up (`!ww || !co`). Without this a
    // single-store item's cheaper_store (the scraper reports the one store it
    // DOES have, not null) tinted that price green and stamped a checkmark on
    // it, which read as "cheaper than Coles" when Coles was never priced.
    const wwClass  = (ww && co && cheaper === 'woolworths') ? 'cell-ww' : '';
    const coClass  = (ww && co && cheaper === 'coles')      ? 'cell-coles' : '';

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
    // +2 check cell and actions cell, so the panel spans the whole row.
    const pThird = thirdEntriesFor(item.list_item);
    if (pThird.length && isThirdOpen(item.list_item, thirdBeats(pThird, ww?.price, co?.price))) {
      tbody.insertAdjacentHTML('beforeend', thirdPanelRowHTML(item.list_item, pThird, ww, co, getVisibleCols().length + 2));
    }

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

  // Sync check-all tri-state (updateBulkBar does it too, but a re-render can
  // change which rows exist without the selection itself changing).
  syncCheckAllState();
  updateBulkBar();

  // Signal sticky header to re-sync next scroll
  _stickyNeedsSync = true;
  onStickyScroll(); // update immediately if already scrolled past thead

  updateValidateNavBadge(pendingValidationCount(data?.pending_validation, data?.last_updated));
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

  // Built here rather than shipped as a file: SheetJS is already loaded for
  // reading uploads, so the template can't drift from what processUploadFile
  // actually parses - sheet named "Data", an "Item" header, one item per row.
  $('uploadTemplateBtn')?.addEventListener('click', () => {
    if (!window.XLSX) { alert('SheetJS not loaded - please reload the page.'); return; }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Item'],
      ['Woolworths Full Cream Milk 2L'],
      ['Helga\'s Traditional Wholemeal 750g'],
      ['Cavendish Bananas 1kg'],
    ]);
    ws['!cols'] = [{ wch: 44 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    XLSX.writeFile(wb, 'pricewatch-import-template.xlsx');
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
  cheaper: 'Cheaper at', pct: 'Difference', saving: 'Savings', units: 'Qty', trips: 'Times bought',
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

// ── Options menu (the dropdown itself, its toggle and the theme switcher are
//    owned by header.js so they work identically on every page; the category
//    trend range is wired HERE because only this page draws category rows) ───

function initTrendRangeToggle() {
  const seg = $('trendRangeSeg');
  if (!seg) return;
  const sync = () => seg.querySelectorAll('.opt-seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.trendRange === loadTrendRangeMode()));
  sync();
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('.opt-seg-btn');
    if (!b || b.dataset.trendRange === loadTrendRangeMode()) return;
    saveTrendRangeMode(b.dataset.trendRange);
    sync();
    // Full re-render, not just the bars: the trend SORT reads the same series,
    // so a table sorted by trend has to reorder too or the picture and the
    // order disagree.
    if (_lastData) renderPage(_lastData);
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  initSettingsModal();
  initEditModal();
  initHistoryModal({
    getItems: () => _lastData?.items || [],
    // The main page owns group history and the exclusion write path.
    buildGroup: (key) => {
      const byName = new Map((_lastData?.items || []).map(i => [i.list_item, i]));
      const g = buildVariantGroups(byName).find(x => x._groupKey === key.replace('__group_', ''));
      return g ? buildGroupHistoryItem(withGroupCounts(g)) : null;
    },
    onSaved: () => { if (_lastData) renderPage(_lastData); },
    // Removing a price point is a destructive edit to shared data, so it is
    // OWNER-ONLY like every other one. This was `true` unconditionally: a
    // visitor's exclusions never reached the repo (no token, so the settings
    // sync no-ops), but they silently rewrote the trend bars and $/kg ranges in
    // that visitor's own browser, permanently and with no way back - the app
    // showed them numbers it had quietly let them corrupt.
    editable: !isViewerMode(),
  });
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
  initTrendRangeToggle();
  updateImportBadge();

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
      // Qty stepper - the table's handler is bound to <tbody>, so card view needs
      // its own. Both call stepUnits(), which is the single writer of pw_units_v1.
      const stepBtn = e.target.closest('.units-inc, .units-dec');
      if (stepBtn) { stepUnits(stepBtn.dataset.item, stepBtn.classList.contains('units-inc')); return; }
      const cardWatch = e.target.closest('.item-watch-btn');
      if (cardWatch) { toggleWatchlist(cardWatch.dataset.item); return; }
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
        // Desktop gets the same three-column editor for a plain product as for a
        // category - that IS the design. The narrow form stays on phones, where
        // three drag-and-drop columns do not fit.
        if (window.innerWidth > 700) { openProductEditor(key); return; }
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
  await Promise.all([loadItemAnalysis(), initWatchlist(), initUserSettings(), mergeArchivedFromRepo(), loadRepoUrlOverrides(), loadRemovedItems(), initThirdStores()]);
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

        // Units increment/decrement (shared with card view - see stepUnits).
        const incBtn = e.target.closest('.units-inc, .units-dec');
        if (incBtn) { stepUnits(incBtn.dataset.item, incBtn.classList.contains('units-inc')); return; }

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

        // Third-store panel: the chip, or ANYWHERE on the row - a per-kg category
        // row expands on a click anywhere, and a row with third-store prices
        // should not behave differently. Guarded so the row's own controls
        // (checkbox, links, ✎, qty, price bar) still do their own job.
        const thirdBtn = e.target.closest('.third-chip, .third-rail, .third-fold');
        const thirdRow = thirdBtn ? null : e.target.closest('tr[data-item]');
        const rowKey = thirdRow && !e.target.closest('a, button, input, select, .price-bar, .units-ctrl')
          ? thirdRow.dataset.item : null;
        const key = thirdBtn ? thirdBtn.dataset.third
                  : (rowKey && thirdEntriesFor(rowKey).length ? rowKey : null);
        if (key) {
          // The control carries whether a third store currently wins, so the
          // toggle resolves against the SAME default this render drew. Clicking
          // the row rather than the chip has to read it off that row's own chip,
          // or the first click on an already-default-open row would no-op.
          const thirdCtl = thirdBtn || thirdRow?.querySelector('.third-chip');
          toggleThird(key, thirdCtl?.dataset.thirdBeats === '1');
          // A category's third column lives INSIDE its own panel (see
          // appendGroupRowDesktop), not a separate one - so opening it here has
          // to also open the category itself, or the toggle would flip with
          // nothing visible to show for it.
          const thirdGroupKey = thirdBtn?.closest('.vg-group-row')?.dataset.group;
          if (thirdGroupKey) _expandedGroups.add(thirdGroupKey);
          if (_lastData) renderPage(_lastData);
          return;
        }

        const unarchiveBtn = e.target.closest('.item-unarchive-btn');
        if (unarchiveBtn) { unarchiveItem(unarchiveBtn.dataset.item); return; }

        const editBtn = e.target.closest('.item-edit-btn');
        if (editBtn && _lastData) {
          const itemName = editBtn.dataset.editItem;
          if (itemName.startsWith('__group_')) { openCategoryEditModal(itemName.replace('__group_', '')); return; }
          if (window.innerWidth > 700) { openProductEditor(itemName); return; }
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
      // Outside-stores toggle. The chip sits on the COLLAPSED card face, so it
      // has to open the card too - otherwise it would flip a section that isn't
      // on screen (same reasoning as the desktop chip opening its category).
      const mThird = e.target.closest('.third-chip, .vgm-third-h, .third-fold');
      if (mThird) {
        toggleThird(mThird.dataset.third, mThird.dataset.thirdBeats === '1');
        const gk = mThird.closest('.vg-mobile-card')?.dataset.group;
        if (gk) _expandedGroups.add(gk);
        if (_lastData) renderPage(_lastData);
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
