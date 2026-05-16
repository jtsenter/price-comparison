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

// ── Column order & widths ────────────────────────────────────────────────────

const DEFAULT_COL_ORDER = ['name', 'ww', 'coles', 'cheaper', 'pct', 'saving', 'trips'];

let _colOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('pw_col_order'));
    if (Array.isArray(saved) && saved.length === DEFAULT_COL_ORDER.length) return saved;
  } catch {}
  return [...DEFAULT_COL_ORDER];
})();

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
    case 'ww':      return `<th data-col="ww" class="sortable"><span class="store-chip ww sm">W</span> Woolworths <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'coles':   return `<th data-col="coles" class="sortable"><span class="store-chip coles sm">C</span> Coles <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'cheaper': return `<th data-col="cheaper" class="sortable center-th">Best Price <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'pct':     return `<th data-col="pct" class="sortable center-th">% Cheaper <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'saving':  return `<th data-col="saving" class="sortable">You Save <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
    case 'trips':   return `<th data-col="trips" class="sortable center-th">Trips <span class="sort-arrow"></span><div class="col-resize-handle"></div></th>`;
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

  const pos = Math.max(0, Math.min(100, ((currentPrice - minP) / (maxP - minP)) * 100));

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
        <div class="price-marker" style="left:${pos.toFixed(1)}%"></div>
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

async function triggerItemRefresh(itemName, btn) {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) {
    alert('Please configure Auto-update Setup first (button in the top-right).');
    return;
  }

  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/workflows/scrape.yml/dispatches`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { trigger: 'manual', item: itemName } }),
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

    // If a URL was added/changed and GitHub is configured, trigger a scrape
    if (urlChanged && (newWwUrl || newCoUrl)) {
      const s = loadSettings();
      if (s.user && s.repo && s.token) {
        triggerItemRefresh(item.list_item, null);
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
        <button class="price-exclude-btn" data-price="${key}">${isExcluded ? 'Include' : 'Exclude'}</button>`;
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
      listEl.appendChild(row);
    });
  }

  $('priceHistoryModal').classList.add('open');
}

// ── Category tabs ────────────────────────────────────────────────────────────

let _activeCategory = 'All';

function buildCategoryTabs(items) {
  const container = $('categoryTabs');
  if (!container) return;

  const seen = new Set();
  const cats = ['All'];
  items.forEach(i => {
    const c = (i.category || '').trim();
    if (c && !seen.has(c)) { seen.add(c); cats.push(c); }
  });
  cats.sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));

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
  thead.innerHTML = `<tr>${_colOrder.map(colHeadHtml).join('')}</tr>`;

  // Apply stored column widths
  thead.querySelectorAll('th[data-col]').forEach(th => {
    const w = _colWidths[th.dataset.col];
    if (w) { th.style.width = w + 'px'; th.style.minWidth = w + 'px'; }
  });

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

function sortItems(items) {
  const { col, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;

  // Filter by category (trim to handle whitespace edge cases)
  let filtered = _activeCategory === 'All'
    ? items
    : items.filter(i => (i.category || '').trim() === _activeCategory);

  return [...filtered].sort((a, b) => {
    let av, bv;
    switch (col) {
      case 'name':    av = a.list_item.toLowerCase(); bv = b.list_item.toLowerCase(); break;
      case 'ww':      av = a.woolworths?.price ?? Infinity; bv = b.woolworths?.price ?? Infinity; break;
      case 'coles':   av = a.coles?.price ?? Infinity; bv = b.coles?.price ?? Infinity; break;
      case 'cheaper': av = a.cheaper_store ?? 'zzz'; bv = b.cheaper_store ?? 'zzz'; break;
      case 'saving':  av = a.saving_per_item ?? -Infinity; bv = b.saving_per_item ?? -Infinity; break;
      case 'trips':   av = a.trip_count || 0; bv = b.trip_count || 0; break;
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

  const s = data.summary;
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

  buildCategoryTabs(data.items);
  renderTableHead();

  const tbody = $('tableBody');
  tbody.innerHTML = '';

  const sorted = sortItems(data.items);
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

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${displayName}${editBtn}</div>
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

    // % Cheaper
    let pctHtml = '';
    const wwPrice = ww?.price;
    const coPrice = co?.price;
    if (wwPrice != null && coPrice != null && wwPrice !== coPrice) {
      const pct = Math.round(Math.abs(wwPrice - coPrice) / Math.max(wwPrice, coPrice) * 100);
      pctHtml = `<span class="${cheaper === 'woolworths' ? 'pct-ww' : 'pct-coles'}">${pct}%</span>`;
    }

    const savingHtml = item.saving_per_item > 0
      ? `<span class="saving-cell">${fmt(item.saving_per_item)}</span>` : '';

    const tripsHtml = item.trip_count != null ? `<span class="trips-cell">${item.trip_count}</span>` : '';

    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;

    const wwClass  = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass  = cheaper === 'coles'      ? 'cell-coles' : '';

    // Build cell map keyed by col id
    const tdMap = {
      name:    `<td class="item-name">${itemCell}</td>`,
      ww:      `<td class="price-cell ${wwClass}">${wwCellContent}</td>`,
      coles:   `<td class="price-cell ${coClass}">${coCellContent}</td>`,
      cheaper: `<td class="cheaper-cell">${badgeHtml}</td>`,
      pct:     `<td class="pct-cell">${pctHtml}</td>`,
      saving:  `<td><div class="saving-row">${savingHtml}${refreshBtn}</div></td>`,
      trips:   `<td class="trips-cell">${tripsHtml}</td>`,
    };

    tbody.insertAdjacentHTML('beforeend', `<tr>${_colOrder.map(col => tdMap[col] || '').join('')}</tr>`);
  });

  // Tfoot — dynamic to match column order
  const tfootRow = document.querySelector('tfoot tr');
  if (tfootRow) {
    const footMap = {
      name:    `<td>Total basket</td>`,
      ww:      `<td id="footWW">${s.ww_data_available ? fmt(s.total_woolworths) : '—'}</td>`,
      coles:   `<td id="footColes">${fmt(s.total_coles)}</td>`,
      cheaper: `<td></td>`,
      pct:     `<td></td>`,
      saving:  `<td id="footSaving">${s.ww_data_available ? `<span class="saving-cell">${fmt(s.total_saving)}</span>` : ''}</td>`,
      trips:   `<td></td>`,
    };
    tfootRow.innerHTML = _colOrder.map(col => footMap[col] || '<td></td>').join('');
  }

  $('tableContainer').style.display = 'block';

  if (data.not_found_items?.length > 0) {
    $('notFoundList').innerHTML = data.not_found_items.map(n => `<li>${n}</li>`).join('');
    $('notFoundSection').style.display = 'block';
  }

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
  if (!changes || Object.keys(changes).length === 0) return;
  const notice = $('nameChangesNotice');
  if (!notice) return;
  const keys = Object.keys(changes);
  const chips = keys.map(k => `<span class="nc-item">${k}</span>`).join('');
  notice.innerHTML = `
    <div class="nc-header">
      <strong>⚠ ${keys.length} item name${keys.length > 1 ? 's' : ''} may have changed</strong>
      <button class="nc-dismiss" onclick="this.closest('.name-changes-notice').classList.remove('visible')">Dismiss</button>
    </div>
    <div class="nc-items">${chips}</div>`;
  notice.classList.add('visible');
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

  $('importBtn')?.addEventListener('click', () => modal.classList.add('open'));
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

    // Add 4 trips per new item (meets min_trips=4 threshold in scraper)
    for (const itemName of newItems) {
      for (let t = 0; t < 4; t++) {
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

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', triggerRefresh);

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
        const refreshBtn = e.target.closest('.item-refresh-btn');
        if (refreshBtn) {
          triggerItemRefresh(refreshBtn.dataset.item, refreshBtn);
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
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
