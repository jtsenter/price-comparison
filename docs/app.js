// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—';
const fmtUnit = (price, unit) => price != null ? `${fmt(price)}/${unit || 'unit'}` : '';

function daysSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

// ── Overrides (edit name / URL) ──────────────────────────────────────────────

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_overrides_v1') || '{}'); } catch { return {}; }
}

function saveOverrides(obj) {
  localStorage.setItem('pw_overrides_v1', JSON.stringify(obj));
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
  'Dairy & Eggs', 'Meat & Seafood', 'Fruit', 'Vegetables',
  'Bread & Bakery', 'Pantry', 'Snacks', 'Drinks', 'Frozen', 'Household', 'Other',
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
  if ((d.trip_count || 0) > 10) return 'weekly';
  return d.priority || 'monthly';
}

function getUnits(itemName) {
  const ov = loadUnitOverrides()[itemName];
  if (ov != null) return ov;
  const qty = getAnalysisData(itemName).avg_qty;
  return qty != null ? Math.round(qty) : 1;
}

// ── Category normalisation ────────────────────────────────────────────────────

const CATEGORY_REMAP = {
  'Spices & Herbs':         'Pantry',
  'Spreads & Dips':         'Pantry',
  'Nuts & Seeds':           'Snacks',
  'Snacks & Confectionery': 'Snacks',
  'Health & Beauty':        'Household',
  'Baby':                   'Household',
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

const DEFAULT_COL_ORDER = ['name', 'priority', 'ww', 'coles', 'cheaper', 'pct', 'saving', 'units', 'trips'];

let _colOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('pw_col_order'));
    if (Array.isArray(saved) && saved.length === DEFAULT_COL_ORDER.length) return saved;
  } catch {}
  return [...DEFAULT_COL_ORDER];
})();

const DEFAULT_COL_WIDTHS = {
  name:     300,
  priority:  90,
  ww:       110,
  coles:    110,
  cheaper:   90,
  pct:       80,
  saving:    95,
  units:     80,
  trips:     65,
};

let _colWidths = (() => {
  try { return JSON.parse(localStorage.getItem('pw_col_widths')) || {}; } catch { return {}; }
})();

function saveColOrder() { localStorage.setItem('pw_col_order', JSON.stringify(_colOrder)); }
function saveColWidths() { localStorage.setItem('pw_col_widths', JSON.stringify(_colWidths)); }

// Column header HTML (function so store-chips render fresh each time)
function colHeadHtml(col) {
  const r = '.col-resize-handle';
  switch (col) {
    case 'name':    return `<th data-col="name" class="sortable">Item <span class="sort-arrow"></span><div class="${r.slice(1)}"></div></th>`;
    case 'ww':      return `<th data-col="ww" class="sortable"><span class="store-chip ww sm">W</span> WW <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'coles':   return `<th data-col="coles" class="sortable"><span class="store-chip coles sm">C</span> Coles <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'cheaper': return `<th data-col="cheaper" class="sortable center-th">Cheaper <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'pct':     return `<th data-col="pct" class="sortable center-th">% Off <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'saving':  return `<th data-col="saving" class="sortable">Savings <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'trips':    return `<th data-col="trips" class="sortable center-th">Trips <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'priority': return `<th data-col="priority" class="sortable center-th">Priority <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'units':    return `<th data-col="units" class="sortable center-th">Qty <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    default: return '';
  }
}

// ── Price history bar ────────────────────────────────────────────────────────

function buildPriceBar(itemName, priceHistory, currentPrice) {
  if (!priceHistory?.length || currentPrice == null) return '';

  const exclusions = loadExclusions();
  const excluded = new Set((exclusions[itemName] || []).map(p => Number(p).toFixed(2)));
  const prices = priceHistory
    .map(p => p.price)
    .filter(p => p > 0 && !excluded.has(Number(p).toFixed(2)));
  if (prices.length < 2) return '';

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  if (minP === maxP) return '';

  const rawPos = ((currentPrice - minP) / (maxP - minP)) * 100;
  const pos = Math.max(0, Math.min(100, rawPos));
  const outRange = rawPos < 0 || rawPos > 100;

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

  return `
    <div class="price-bar-outer" data-tooltip="${safeTooltip}">
      <div class="price-bar">
        <div class="price-marker${outRange ? ' out-range' : ''}" style="left:${pos.toFixed(1)}%"></div>
      </div>
      <div class="price-bar-labels">
        <span>${fmt(minP)}</span>
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
  let attempts = 0;
  const poll = async () => {
    if (++attempts > 30) {
      if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
      return;
    }
    try {
      const res = await fetch(
        `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/runs?per_page=1`,
        { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
      );
      const data = await res.json();
      const run = data.workflow_runs?.[0];
      if (run?.status === 'completed') {
        if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
        if (run.conclusion === 'success') {
          const newData = await loadData();
          if (newData) renderPage(newData);
        }
        return;
      }
    } catch (_) {}
    setTimeout(poll, 10000);
  };
  setTimeout(poll, 10000);
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

  $('editSave').addEventListener('click', () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    const prevOv = overrides[_editingItem.list_item] || {};
    const newWwUrl   = $('editWwUrl').value.trim()   || undefined;
    const newCoUrl   = $('editColesUrl').value.trim() || undefined;
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

    // If a URL was added/changed and GitHub is configured, trigger a scrape using the new URLs
    if (urlChanged && (newWwUrl || newCoUrl)) {
      const s = loadSettings();
      if (s.user && s.repo && s.token) {
        triggerItemRefresh(item.list_item, null, { wwUrl: newWwUrl, colesUrl: newCoUrl });
        alert(`Scrape triggered for "${item.list_item}" with the new URL.`);
      }
    }
  });

  $('editReset').addEventListener('click', () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    delete overrides[_editingItem.list_item];
    saveOverrides(overrides);
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
  $('priceHistoryTitle').textContent = `Price History — ${item.list_item}`;

  const excl = loadExclusions();
  const excludedPrices = new Set((excl[item.list_item] || []).map(p => Number(p).toFixed(2)));
  const history = item.price_history || [];

  const listEl = $('priceHistoryList');
  listEl.innerHTML = '';

  if (!history.length) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-soft);font-size:13px;">No price history available.</div>';
  } else {
    history.forEach((entry) => {
      const key = Number(entry.price).toFixed(2);
      const isExcluded = excludedPrices.has(key);
      const row = document.createElement('div');
      row.className = `price-history-row${isExcluded ? ' excluded' : ''}`;
      row.innerHTML = `
        <span class="price-history-date">${entry.date || 'Unknown date'}</span>
        <span class="price-history-price">${fmt(entry.price)}</span>
        <button class="price-exclude-btn" data-price="${key}">${isExcluded ? 'Include' : 'Exclude'}</button>
        <button class="price-diff-btn" data-price="${key}">Different item</button>`;

      row.querySelector('.price-exclude-btn').addEventListener('click', () => {
        const ex = loadExclusions();
        const list = ex[item.list_item] || [];
        const priceNum = Number(key);
        if (isExcluded) {
          ex[item.list_item] = list.filter(p => Number(p).toFixed(2) !== key);
        } else {
          ex[item.list_item] = [...list, priceNum];
        }
        saveExclusions(ex);
        openPriceHistoryModal(item);
        if (_lastData) renderPage(_lastData);
      });

      row.querySelector('.price-diff-btn').addEventListener('click', async () => {
        const newName = window.prompt(
          `This ${fmt(entry.price)} entry belongs to a different item.\nWhat is its name?`,
          ''
        );
        if (!newName?.trim()) return;
        const trimmed = newName.trim();

        // Exclude this price from the current item
        const ex = loadExclusions();
        const list = ex[item.list_item] || [];
        const priceNum = Number(key);
        if (!list.some(p => Number(p).toFixed(2) === key)) {
          ex[item.list_item] = [...list, priceNum];
          saveExclusions(ex);
        }

        // Try to add the new item to the shopping list and trigger scrape
        const s = loadSettings();
        if (s.user && s.repo && s.token) {
          await addItemsToShoppingList([trimmed]);
        } else {
          // Save to pending list for later
          const pending = loadPending();
          pending.push({
            name: trimmed,
            price: entry.price,
            date: entry.date || new Date().toISOString(),
            from_item: item.list_item,
            added_at: new Date().toISOString(),
          });
          savePending(pending);
          updateImportBadge();
          alert(`"${trimmed}" saved to pending items. Configure GitHub settings to add it to your list.`);
        }

        openPriceHistoryModal(item);
        if (_lastData) renderPage(_lastData);
      });

      listEl.appendChild(row);
    });
  }

  $('priceHistoryModal').classList.add('open');
}

// ── Priority filter ──────────────────────────────────────────────────────────

function initPriorityFilter() {
  const container = $('priorityFilter');
  if (!container) return;

  container.querySelectorAll('.priority-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.priority;
      if (p) {
        _activePriority = p;
        _showHotOnly = false;
        container.querySelectorAll('.priority-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('hotFilterBtn')?.classList.remove('active');
        $('storeFilter').style.display = 'none';
      } else {
        // fire pill handled below
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
  });

  $('bulkArchiveBtn')?.addEventListener('click', () => {
    const pr = loadPriorities();
    _checkedItems.forEach(name => { pr[name] = 'archive'; });
    savePriorities(pr);
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
  });

  $('bulkDeselectBtn')?.addEventListener('click', () => {
    _checkedItems.clear();
    updateBulkBar();
    if (_lastData) renderPage(_lastData);
  });
}

// ── Banner stats (priority-aware) ────────────────────────────────────────────

function computeBannerStats(items) {
  const filtered = items.filter(item => {
    const p = getPriority(item.list_item);
    if (_activePriority !== 'archive' && p === 'archive') return false;
    if (_activePriority !== 'all' && _activePriority !== 'archive' && p !== _activePriority) return false;
    if (_activeCategory !== 'All' && getCategory(item) !== _activeCategory) return false;
    if (_showHotOnly && !isHotDeal(item)) return false;
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
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.col = col;
        sortState.dir = col === 'name' ? 'asc' : 'desc';
      }
      if (_lastData) renderPage(_lastData);
    });
  });

  _stickyNeedsSync = false;
}

function onStickyScroll() {
  if (!_stickyGhost) return;
  const realThead = document.querySelector('#tableHead');
  if (!realThead) { _stickyGhost.style.display = 'none'; return; }

  const rect = realThead.getBoundingClientRect();
  const HEADER_H = 60;

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
  });
}

// ── Render table head (dynamic, respects _colOrder) ─────────────────────────

function renderTableHead() {
  const thead = $('tableHead');
  if (!thead) return;
  thead.innerHTML = `<tr><th class="check-cell"><input type="checkbox" id="checkAll" title="Select all visible"></th>${_colOrder.map(colHeadHtml).join('')}</tr>`;

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

  const btn = $('refreshBtn');
  btn.disabled = true;
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
      btn.innerHTML = '✓ Triggered — polling…';
      pollForCompletion(s);
      refreshCooldown = true;
      setTimeout(() => { refreshCooldown = false; }, 10 * 60 * 1000);
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`GitHub API error ${res.status}: ${err.message || 'Unknown error'}`);
      btn.disabled = false;
      btn.innerHTML = '↻ Refresh Now';
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
    btn.disabled = false;
    btn.innerHTML = '↻ Refresh Now';
  }
}

async function pollForCompletion(s) {
  const btn = $('refreshBtn');
  let attempts = 0;

  const poll = async () => {
    if (++attempts > 40) { btn.innerHTML = '↻ Refresh Now'; btn.disabled = false; return; }
    try {
      const res = await fetch(
        `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/runs?per_page=1`,
        { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
      );
      const data = await res.json();
      const run = data.workflow_runs?.[0];
      if (run?.status === 'completed') {
        if (run.conclusion === 'success') {
          btn.innerHTML = '✓ Done — reloading…';
          setTimeout(() => {
            fetch(`data/latest.json?t=${Date.now()}`)
              .then(r => r.json())
              .then(d => { renderPage(d); btn.innerHTML = '↻ Refresh Now'; btn.disabled = false; })
              .catch(() => location.reload());
          }, 2000);
        } else {
          btn.innerHTML = '⚠ Run failed';
          setTimeout(() => { btn.innerHTML = '↻ Refresh Now'; btn.disabled = false; }, 4000);
        }
        return;
      }
    } catch (_) {}
    setTimeout(poll, 15000);
  };
  setTimeout(poll, 15000);
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const res = await fetch(`data/latest.json?t=${Date.now()}`);
    if (!res.ok) throw new Error('not found');
    return await res.json();
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

let sortState = { col: 'trips', dir: 'desc' };
let _lastData = null;

const PRIORITY_ORDER = { weekly: 0, monthly: 1, rare: 2, archive: 3 };

function sortItems(items) {
  const { col, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;

  let filtered = items.filter(item => {
    const p = getPriority(item.list_item);
    // Always hide archived items unless archive view is active
    if (_activePriority !== 'archive' && p === 'archive') return false;
    // Priority pill filter
    if (_activePriority !== 'all' && _activePriority !== 'archive' && p !== _activePriority) return false;
    // Hot deals filter
    if (_showHotOnly && !isHotDeal(item)) return false;
    // Store filter (only active when hot filter is on)
    if (_showHotOnly && _storeFilter !== 'all') {
      if (_storeFilter === 'woolworths' && item.cheaper_store !== 'woolworths') return false;
      if (_storeFilter === 'coles' && item.cheaper_store !== 'coles') return false;
    }
    // Prices-only filter
    if (_showPricesOnly && !item.woolworths?.price && !item.coles?.price) return false;
    return true;
  });

  // Category filter
  if (_activeCategory !== 'All') {
    filtered = filtered.filter(i => getCategory(i) === _activeCategory);
  }

  return [...filtered].sort((a, b) => {
    let av, bv;
    switch (col) {
      case 'name':     av = a.list_item.toLowerCase(); bv = b.list_item.toLowerCase(); break;
      case 'ww':       av = a.woolworths?.price ?? Infinity; bv = b.woolworths?.price ?? Infinity; break;
      case 'coles':    av = a.coles?.price ?? Infinity; bv = b.coles?.price ?? Infinity; break;
      case 'cheaper':  av = a.cheaper_store ?? 'zzz'; bv = b.cheaper_store ?? 'zzz'; break;
      case 'saving':   av = a.saving_per_item ?? -Infinity; bv = b.saving_per_item ?? -Infinity; break;
      case 'trips':    av = a.trip_count || 0; bv = b.trip_count || 0; break;
      case 'units':    av = getUnits(a.list_item); bv = getUnits(b.list_item); break;
      case 'priority': {
        av = PRIORITY_ORDER[getPriority(a.list_item)] ?? 99;
        bv = PRIORITY_ORDER[getPriority(b.list_item)] ?? 99;
        break;
      }
      case 'pct': {
        const wwA = a.woolworths?.price; const coA = a.coles?.price;
        av = (wwA != null && coA != null) ? Math.abs(wwA - coA) / Math.max(wwA, coA) : -Infinity;
        const wwB = b.woolworths?.price; const coB = b.coles?.price;
        bv = (wwB != null && coB != null) ? Math.abs(wwB - coB) / Math.max(wwB, coB) : -Infinity;
        break;
      }
      default: av = a.trip_count || 0; bv = b.trip_count || 0; break;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return  1 * mul;
    return 0;
  });
}

function updateSortHeaders(thead) {
  const container = thead || document.querySelector('#tableHead');
  if (!container) return;
  container.querySelectorAll('th[data-col]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.col === sortState.col) {
      th.classList.add('sort-active');
      arrow.textContent = sortState.dir === 'asc' ? ' ↑' : ' ↓';
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
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.col = col;
        sortState.dir = col === 'name' ? 'asc' : 'desc';
      }
      if (_lastData) renderPage(_lastData);
    });
  });
}

// ── Weekly special detection ─────────────────────────────────────────────────

function isHotDeal(item) {
  const history = item.price_history;
  if (!history || history.length < 3) return false;
  const prices = history.map(h => h.price).filter(p => p > 0);
  if (prices.length < 3) return false;
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  // Use cheapest available price for comparison
  const ww = item.woolworths?.price;
  const co = item.coles?.price;
  const current = item.cheaper_store === 'woolworths' ? ww : (item.cheaper_store === 'coles' ? co : (co ?? ww));
  if (current == null) return false;
  return current < mean * 0.9;
}

// ── Index page rendering ─────────────────────────────────────────────────────

function renderPage(data) {
  $('loading').style.display = 'none';

  if (!data?.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Update Prices to fetch prices.';
    return;
  }

  if (daysSince(data.last_updated) > 5) $('staleBanner').classList.add('visible');

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
    $('savingInfo').innerHTML = `<span class="saving-chip">You save ${fmt(s.total_saving)}</span>`;
  } else if (s.cheaper_store === 'coles') {
    colesCard.classList.add('winner-coles');
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('colesBadge').innerHTML = '<span class="winner-badge coles">✓ Cheaper</span>';
    $('wwBadge').innerHTML    = '';
    $('savingInfo').innerHTML = `<span class="saving-chip">You save ${fmt(s.total_saving)}</span>`;
  } else {
    wwTotalEl.textContent = fmt(s.total_woolworths);
    $('colesTotal').textContent = fmt(s.total_coles);
    $('wwBadge').innerHTML = $('colesBadge').innerHTML = '';
    $('savingInfo').textContent = 'Same price at both stores';
  }

  const prog = data.scrape_progress;
  $('lastUpdated').textContent = prog
    ? `Scraping… ${prog.done}/${prog.total} items done · refreshes every 10`
    : `Updated ${formatDate(data.last_updated)} · ${s.items_compared} items`;
  $('banner').style.display = 'block';

  _lastData = data;

  // Auto-poll progress while scraping
  if (data.scrape_progress) {
    if (!window._progressPollTimer) {
      window._progressPollTimer = setInterval(async () => {
        const fresh = await loadData();
        if (!fresh) return;
        if (!fresh.scrape_progress) {
          clearInterval(window._progressPollTimer);
          window._progressPollTimer = null;
        }
        if (fresh.scrape_progress?.done !== _lastData?.scrape_progress?.done || !fresh.scrape_progress) {
          renderPage(fresh);
        }
      }, 20000);
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
  const allDisplayItems = [...data.items, ...notFoundAsItems];

  buildCategoryTabs(allDisplayItems);

  // Prices-only toggle button
  let toggleBtn = $('pricesOnlyBtn');
  if (!toggleBtn) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'pricesOnlyBtn';
    toggleBtn.className = 'btn btn-ghost prices-only-btn';
    toggleBtn.addEventListener('click', () => {
      _showPricesOnly = !_showPricesOnly;
      toggleBtn.classList.toggle('active', _showPricesOnly);
      toggleBtn.textContent = _showPricesOnly ? 'Hiding unfound ✕' : 'Hide unfound items';
      if (_lastData) renderPage(_lastData);
    });
    const tabs = $('categoryTabs');
    tabs?.parentNode?.insertBefore(toggleBtn, tabs);
  }
  toggleBtn.textContent = _showPricesOnly ? 'Hiding unfound ✕' : 'Hide unfound items';
  toggleBtn.classList.toggle('active', _showPricesOnly);

  renderTableHead();

  const tbody = $('tableBody');
  tbody.innerHTML = '';

  const sorted = sortItems(allDisplayItems);
  updateSortHeaders();

  const overrides = loadOverrides();

  sorted.forEach((item) => {
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;
    const ov = overrides[item.list_item] || {};

    const wwUrl  = ov.wwUrl    || ww?.url  || null;
    const coUrl  = ov.colesUrl || co?.url  || null;
    const displayName = ov.displayName || item.list_item;

    const imgSrc = co?.image_url || ww?.image_url || '';
    const imgHtml = imgSrc
      ? `<img class="item-img" src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : '<div class="item-img-placeholder"></div>';

    const safeKey = item.list_item.replace(/"/g, '&quot;');
    const editBtn = `<button class="item-edit-btn" data-edit-item="${safeKey}" title="Edit name/URL">✎</button>`;

    // Price bar uses cheaper store's price as reference (or fallback)
    const currentRef = cheaper === 'woolworths' ? ww?.price : (cheaper === 'coles' ? co?.price : (co?.price ?? ww?.price));
    const bar = buildPriceBar(item.list_item, item.price_history, currentRef);

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
    const discrepancyWarning = priceDiffPct > 0.31
      ? `<span class="discrepancy-warn" title="Large price difference — double check the match is correct">⚠</span>`
      : '';

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${displayName}${discrepancyWarning}${editBtn}</div>
          ${bar}
        </div>
      </div>`;

    // Hot deal: fire goes on the cheaper store's price cell
    const hotDeal = isHotDeal(item);
    const hotBadge = `<span class="hot-badge" title="Current price is 10%+ below historical average">🔥</span>`;

    // WW price cell
    let wwCellContent;
    if (ww) {
      const wwPriceVal = wwUrl
        ? `<a href="${wwUrl}" target="_blank" class="price-link">${fmt(ww.price)}</a>`
        : fmt(ww.price);
      const wwFire = hotDeal && (cheaper === 'woolworths' || (cheaper == null && ww && !co)) ? hotBadge : '';
      wwCellContent = `<div class="price-main">${wwPriceVal}${wwFire}</div><div class="price-unit">${fmtUnit(ww.unit_price, ww.unit)}</div>`;
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
      coCellContent = `<div class="price-main">${coPriceVal}${coFire}</div><div class="price-unit">${fmtUnit(co.unit_price, co.unit)}</div>`;
    } else {
      const searchUrl = `https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}`;
      coCellContent = `<a href="${searchUrl}" target="_blank" class="search-link">Find on Coles →</a>`;
    }

    // Best Price — N/A when one store is missing
    let badgeHtml = '';
    if (!ww || !co) {
      badgeHtml = '<span class="cheaper-badge na">N/A</span>';
    } else if (cheaper === 'woolworths') {
      badgeHtml = '<span class="cheaper-badge ww">WW</span>';
    } else if (cheaper === 'coles') {
      badgeHtml = '<span class="cheaper-badge coles">Coles</span>';
    } else if (cheaper === 'equal') {
      badgeHtml = '<span class="cheaper-badge equal">Equal</span>';
    }

    // Units cell (declared before unitsSaving so it's in scope)
    const units = getUnits(item.list_item);

    const unitsSaving = item.saving_per_item > 0 ? item.saving_per_item * units : 0;
    const savingHtml = unitsSaving > 0
      ? `<span class="saving-cell">${fmt(unitsSaving)}</span>` : '';

    const tripsHtml = item.trip_count != null ? `<span class="trips-cell">${item.trip_count}</span>` : '';

    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;

    const wwClass  = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass  = cheaper === 'coles'      ? 'cell-coles' : '';

    // Priority cell (uses analysis data as fallback)
    const itemPriority = getPriority(item.list_item);
    const priorityCell = `<td class="priority-cell"><select class="priority-select" data-item="${safeKey}">
      <option value="weekly"${itemPriority === 'weekly' ? ' selected' : ''}>Weekly</option>
      <option value="monthly"${itemPriority === 'monthly' ? ' selected' : ''}>Monthly</option>
      <option value="rare"${itemPriority === 'rare' ? ' selected' : ''}>Rare</option>
      <option value="archive"${itemPriority === 'archive' ? ' selected' : ''}>Archive</option>
    </select></td>`;

    const unitsDisplay = Number.isInteger(units) ? units : units.toFixed(1);
    const unitsCell = `<td class="units-cell">
      <div class="units-ctrl">
        <button class="units-dec" data-item="${safeKey}">−</button>
        <span class="units-val">${unitsDisplay}</span>
        <button class="units-inc" data-item="${safeKey}">+</button>
      </div>
    </td>`;

    // Build cell map keyed by col id
    const tdMap = {
      name:     `<td class="item-name">${itemCell}</td>`,
      priority: priorityCell,
      units:    unitsCell,
      ww:       `<td class="price-cell ${wwClass}">${wwCellContent}</td>`,
      coles:    `<td class="price-cell ${coClass}">${coCellContent}</td>`,
      cheaper:  `<td class="cheaper-cell">${badgeHtml}</td>`,
      pct:      `<td class="pct-cell">${pctHtml}</td>`,
      saving:   `<td><div class="saving-row">${savingHtml}${refreshBtn}</div></td>`,
      trips:    `<td class="trips-cell">${tripsHtml}</td>`,
    };

    const checked = _checkedItems.has(item.list_item) ? ' checked' : '';
    tbody.insertAdjacentHTML('beforeend', `<tr><td class="check-cell"><input type="checkbox" class="row-check" data-item="${safeKey}"${checked}></td>${_colOrder.map(col => tdMap[col] || '').join('')}</tr>`);
  });

  // Tfoot — dynamic to match column order
  const tfootRow = document.querySelector('tfoot tr');
  if (tfootRow) {
    const footMap = {
      name:     `<td>Total basket</td>`,
      priority: `<td></td>`,
      units:    `<td></td>`,
      ww:       `<td id="footWW">${s.ww_data_available ? fmt(s.total_woolworths) : '—'}</td>`,
      coles:    `<td id="footColes">${fmt(s.total_coles)}</td>`,
      cheaper:  `<td></td>`,
      pct:      `<td></td>`,
      saving:   `<td id="footSaving">${s.ww_data_available ? `<span class="saving-cell">${fmt(s.total_saving)}</span>` : ''}</td>`,
      trips:    `<td></td>`,
    };
    tfootRow.innerHTML = _colOrder.map(col => footMap[col] || '<td></td>').join('');
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
}

// ── Alternatives page rendering ───────────────────────────────────────────────

function renderAlternatives(data) {
  $('loading').style.display = 'none';

  if (!data?.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Update Prices to fetch prices.';
    return;
  }

  $('altSubtitle').textContent =
    `Last updated: ${formatDate(data.last_updated)} · cheaper per-unit alternatives for your list`;
  $('altHeader').style.display = 'block';

  const grid = $('altGrid');
  grid.innerHTML = '';
  let count = 0;

  const sorted = [...data.items].sort((a, b) => {
    const savA = a.alternatives?.length ? (a.woolworths?.unit_price || a.coles?.unit_price || 0) - a.alternatives[0].unit_price : 0;
    const savB = b.alternatives?.length ? (b.woolworths?.unit_price || b.coles?.unit_price || 0) - b.alternatives[0].unit_price : 0;
    return savB - savA;
  });

  sorted.forEach((item) => {
    if (!item.alternatives?.length) return;
    count++;
    const bestMatch = item.woolworths || item.coles;

    const rows = item.alternatives.map((alt) => {
      const retailer = alt.retailer || (alt.url?.includes('woolworths') ? 'woolworths' : 'coles');
      const storeLabel = retailer === 'woolworths' ? 'Woolworths' : 'Coles';
      const storeClass = retailer === 'woolworths' ? 'ww' : 'coles';
      return `
        <div class="alt-row">
          <div class="alt-row-left">
            <div class="alt-row-name" title="${alt.name}">${alt.name}</div>
            <div class="alt-row-store ${storeClass}">${storeLabel}</div>
          </div>
          <div class="alt-row-right">
            <div class="alt-row-unit">${fmtUnit(alt.unit_price, alt.unit)}</div>
            <div class="alt-row-price">${fmt(alt.price)}</div>
            ${alt.url ? `<a class="alt-link" href="${alt.url}" target="_blank">View →</a>` : ''}
          </div>
        </div>`;
    }).join('');

    grid.insertAdjacentHTML('beforeend', `
      <div class="alt-card">
        <div class="alt-card-header">
          <div class="your-item">Your item</div>
          <div class="item-name">${item.list_item}</div>
          <div class="item-price">${bestMatch ? `${fmt(bestMatch.price)} · ${fmtUnit(bestMatch.unit_price, bestMatch.unit)}` : ''}</div>
        </div>
        ${rows}
      </div>`);
  });

  if (count === 0) $('noAlts').style.display = 'block';
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

    const wb = XLSX.read(bytes, { type: 'array' });
    const sheetName = wb.SheetNames.includes('Data') ? 'Data' : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (!data.length) throw new Error('shopping_list.xlsx has no data');

    const header = data[0];
    const itemIdx  = header.findIndex(h => String(h).toLowerCase().includes('item'));
    const dateIdx  = header.findIndex(h => String(h).toLowerCase().includes('date'));
    const priceIdx = header.findIndex(h => String(h).toLowerCase().includes('price') || String(h).toLowerCase().includes('unit'));

    const today = new Date().toISOString().split('T')[0];

    // Add 2 trips per new item (meets min_trips=2 threshold in scraper)
    for (const itemName of newItems) {
      for (let t = 0; t < 2; t++) {
        const row = Array(Math.max(header.length, 3)).fill('');
        if (itemIdx >= 0)  row[itemIdx]  = itemName;
        if (dateIdx >= 0)  row[dateIdx]  = today;
        if (priceIdx >= 0) row[priceIdx] = 0;
        data.push(row);
      }
    }

    const newWs = XLSX.utils.aoa_to_sheet(data);
    wb.Sheets[sheetName] = newWs;
    const newContent = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });

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

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  initSettingsModal();
  initEditModal();
  initPriceHistoryModal();
  initTooltip();
  initStickyHeader();
  initUploadModal();
  initPriorityFilter();
  initBulkBar();
  updateImportBadge();

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerRefresh);

  // Load analysis data first so priorities/units are ready before render
  await loadItemAnalysis();
  const data = await loadData();
  const isAlt = location.pathname.endsWith('alternatives.html');

  if (isAlt) {
    renderAlternatives(data);
  } else {
    renderPage(data);
    showNameChangesNotice();

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
        }
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
