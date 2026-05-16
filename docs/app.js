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

// ── Price history bar ────────────────────────────────────────────────────────

function buildPriceBar(itemName, priceHistory, currentPrice) {
  if (!priceHistory?.length || currentPrice == null) return '';

  // Filter out excluded prices
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

  // Build price distribution map
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
    : cheaperPct === 0
      ? `Now at the highest past price ⚠`
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

    // Flip below cursor if near top of viewport
    if (top < 8) top = e.clientY + margin;
    // Keep within horizontal bounds
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

  btn.disabled = true;
  btn.classList.add('spinning');

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
      pollItemRefresh(s, btn, itemName);
    } else {
      const err = await res.json().catch(() => ({}));
      alert(`Error ${res.status}: ${err.message || 'Could not trigger refresh'}`);
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  } catch (e) {
    alert(`Network error: ${e.message}`);
    btn.disabled = false;
    btn.classList.remove('spinning');
  }
}

async function pollItemRefresh(s, btn, itemName) {
  let attempts = 0;
  const poll = async () => {
    if (++attempts > 30) {
      btn.classList.remove('spinning');
      btn.disabled = false;
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
        btn.classList.remove('spinning');
        btn.disabled = false;
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

let _editingItem = null; // stores list_item string of item being edited

function initEditModal() {
  const modal = $('editModal');
  if (!modal) return;

  const close = () => {
    modal.classList.remove('open');
    _editingItem = null;
  };

  $('editModalClose').addEventListener('click', close);
  $('editCancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  $('editSave').addEventListener('click', () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    overrides[_editingItem] = {
      displayName: $('editDisplayName').value.trim() || undefined,
      wwUrl:       $('editWwUrl').value.trim()       || undefined,
      colesUrl:    $('editColesUrl').value.trim()    || undefined,
    };
    // Remove key if all fields blank
    if (!overrides[_editingItem].displayName && !overrides[_editingItem].wwUrl && !overrides[_editingItem].colesUrl) {
      delete overrides[_editingItem];
    }
    saveOverrides(overrides);
    close();
    if (_lastData) renderPage(_lastData);
  });

  $('editReset').addEventListener('click', () => {
    if (!_editingItem) return;
    const overrides = loadOverrides();
    delete overrides[_editingItem];
    saveOverrides(overrides);
    close();
    if (_lastData) renderPage(_lastData);
  });
}

function openEditModal(item) {
  _editingItem = item.list_item;
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

  const close = () => {
    modal.classList.remove('open');
    _historyItem = null;
  };

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
        openPriceHistoryModal(item); // re-render modal
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

  const categories = ['All', ...new Set(
    items.map(i => i.category).filter(Boolean).sort()
  )];

  container.innerHTML = categories.map(cat => `
    <button class="category-tab${cat === _activeCategory ? ' active' : ''}" data-cat="${cat}">${cat}</button>
  `).join('');

  container.querySelectorAll('.category-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeCategory = btn.dataset.cat;
      if (_lastData) renderPage(_lastData);
    });
  });
}

// ── Refresh / GitHub Actions trigger ─────────────────────────────────────────

let refreshCooldown = false;

async function triggerRefresh() {
  const s = loadSettings();
  if (!s.user || !s.repo || !s.token) {
    alert('Please configure your GitHub settings first (⚙ Settings button).');
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

  // Filter by category first
  let filtered = _activeCategory === 'All'
    ? items
    : items.filter(i => i.category === _activeCategory);

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
      default:        av = a.trip_count || 0; bv = b.trip_count || 0; break;
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return  1 * mul;
    return 0;
  });
}

function updateSortHeaders() {
  document.querySelectorAll('#tableHead th[data-col]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
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
}

// ── Weekly special detection ─────────────────────────────────────────────────

function isHotDeal(item) {
  const history = item.price_history;
  if (!history || history.length < 3) return false;
  const prices = history.map(h => h.price).filter(p => p > 0);
  if (prices.length < 3) return false;
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const current = item.coles?.price ?? item.woolworths?.price;
  if (current == null) return false;
  return current < mean * 0.9; // more than 10% below average
}

// ── Index page rendering ─────────────────────────────────────────────────────

function renderPage(data) {
  $('loading').style.display = 'none';

  if (!data?.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Refresh Now to fetch prices.';
    return;
  }

  if (daysSince(data.last_updated) > 5) $('staleBanner').classList.add('visible');

  const s = data.summary;
  const wwCard    = $('wwCard');
  const colesCard = $('colesCard');
  const wwTotalEl = $('wwTotal');

  // Reset card classes
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

  // Category tabs
  buildCategoryTabs(data.items);

  // Table
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

    // Apply URL overrides
    const wwUrl   = ov.wwUrl   || ww?.url   || null;
    const coUrl   = ov.colesUrl || co?.url  || null;

    // Display name (with override support)
    const displayName = ov.displayName || item.list_item;

    // Product image (prefer Coles, fall back to WW)
    const imgSrc = co?.image_url || ww?.image_url || '';
    const imgHtml = imgSrc
      ? `<img class="item-img" src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : '<div class="item-img-placeholder"></div>';

    // Hot deal badge
    const hotBadge = isHotDeal(item) ? `<span class="hot-badge" title="Current price is 10%+ below historical average">🔥</span>` : '';

    // Pencil edit button
    const safeKey = item.list_item.replace(/"/g, '&quot;');
    const editBtn = `<button class="item-edit-btn" data-edit-item="${safeKey}" title="Edit name/URL">✎</button>`;

    // Price history bar
    const currentRef = co?.price ?? ww?.price;
    const bar = buildPriceBar(item.list_item, item.price_history, currentRef);

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${displayName}${editBtn}${hotBadge}</div>
          ${bar}
        </div>
      </div>`;

    // WW price cell
    let wwCell;
    if (ww) {
      const wwPriceVal = wwUrl
        ? `<a href="${wwUrl}" target="_blank" class="price-link">${fmt(ww.price)}</a>`
        : fmt(ww.price);
      wwCell = `<div class="price-main">${wwPriceVal}</div><div class="price-unit">${fmtUnit(ww.unit_price, ww.unit)}</div>`;
    } else {
      const searchUrl = `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.list_item)}`;
      wwCell = `<a href="${searchUrl}" target="_blank" class="search-link">Find on WW →</a>`;
    }

    // Coles price cell
    let coCell;
    if (co) {
      const coPriceVal = coUrl
        ? `<a href="${coUrl}" target="_blank" class="price-link">${fmt(co.price)}</a>`
        : fmt(co.price);
      coCell = `<div class="price-main">${coPriceVal}</div><div class="price-unit">${fmtUnit(co.unit_price, co.unit)}</div>`;
    } else {
      const searchUrl = `https://www.coles.com.au/search?q=${encodeURIComponent(item.list_item)}`;
      coCell = `<a href="${searchUrl}" target="_blank" class="search-link">Find on Coles →</a>`;
    }

    // Best price badge
    let badgeHtml = '';
    if (cheaper === 'woolworths') badgeHtml = '<span class="cheaper-badge ww">WW</span>';
    else if (cheaper === 'coles') badgeHtml = '<span class="cheaper-badge coles">Coles</span>';
    else if (cheaper === 'equal') badgeHtml = '<span class="cheaper-badge equal">Equal</span>';

    // % Cheaper column
    let pctHtml = '';
    const wwPrice = ww?.price;
    const coPrice = co?.price;
    if (wwPrice != null && coPrice != null && wwPrice !== coPrice) {
      const pct = Math.round(Math.abs(wwPrice - coPrice) / Math.max(wwPrice, coPrice) * 100);
      const pctClass = cheaper === 'woolworths' ? 'pct-ww' : 'pct-coles';
      pctHtml = `<span class="${pctClass}">${pct}%</span>`;
    }

    // You Save
    const savingHtml = item.saving_per_item > 0
      ? `<span class="saving-cell">${fmt(item.saving_per_item)}</span>`
      : '';

    // Trips cell
    const tripsHtml = item.trip_count != null ? `<span class="trips-cell">${item.trip_count}</span>` : '';

    // Per-item refresh button
    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeKey}" title="Refresh prices for this item">↻</button>`;

    const wwClass = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass = cheaper === 'coles' ? 'cell-coles' : '';

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="item-name">${itemCell}</td>
        <td class="price-cell ${wwClass}">${wwCell}</td>
        <td class="price-cell ${coClass}">${coCell}</td>
        <td class="cheaper-cell">${badgeHtml}</td>
        <td class="pct-cell">${pctHtml}</td>
        <td><div class="saving-row">${savingHtml}${refreshBtn}</div></td>
        <td class="trips-cell">${tripsHtml}</td>
      </tr>`);
  });

  $('footWW').textContent = s.ww_data_available ? fmt(s.total_woolworths) : '—';
  $('footColes').textContent = fmt(s.total_coles);
  $('footSaving').innerHTML = s.ww_data_available
    ? `<span class="saving-cell">${fmt(s.total_saving)}</span>` : '';

  $('tableContainer').style.display = 'block';

  if (data.not_found_items?.length > 0) {
    $('notFoundList').innerHTML = data.not_found_items.map(n => `<li>${n}</li>`).join('');
    $('notFoundSection').style.display = 'block';
  }
}

// ── Alternatives page rendering ───────────────────────────────────────────────

function renderAlternatives(data) {
  $('loading').style.display = 'none';

  if (!data?.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Refresh Now to fetch prices.';
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

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  initSettingsModal();
  initEditModal();
  initPriceHistoryModal();
  initSortHeaders();
  initTooltip();

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
        // Per-item refresh
        const refreshBtn = e.target.closest('.item-refresh-btn');
        if (refreshBtn) {
          triggerItemRefresh(refreshBtn.dataset.item, refreshBtn);
          return;
        }
        // Edit name/URL
        const editBtn = e.target.closest('.item-edit-btn');
        if (editBtn && _lastData) {
          const itemName = editBtn.dataset.editItem;
          const item = _lastData.items.find(i => i.list_item === itemName);
          if (item) openEditModal(item);
          return;
        }
        // Price history / range manager
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
