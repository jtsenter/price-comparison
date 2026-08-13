// ── Price history modal (shared) ────────────────────────────────────────────
// Extracted from app.js so hot-deals.html can open the SAME modal instead of
// growing a second copy - the duplicate price-bar this page used to carry is
// exactly the drift this avoids. The markup is injected from here too, so there
// is one definition of it rather than one per page.
//
// Pages configure it with initHistoryModal({ getItems, buildGroup, onSaved,
// editable }). `editable` gates the exclusion Save/Reset controls: a page that
// does not own the write path (hot-deals) opens the modal read-only, reusing the
// same `simplified` layout the mobile view already uses.

let _hmCfg = {
  getItems: () => [],
  buildGroup: null,
  onSaved: () => {},
  editable: false,
  delegate: false,
};

const HISTORY_MODAL_HTML = `
<div class="modal-overlay" id="priceHistoryModal">
  <div class="modal modal-wide modal-scrollable">
    <div class="modal-header">
      <h2 id="priceHistoryTitle">Price History</h2>
      <div style="flex:1"></div>
      <button class="modal-close" id="priceHistoryClose">✕</button>
    </div>
    <div id="priceHistChartWrap" style="height:200px;margin-bottom:16px;display:none;">
      <canvas id="priceHistChart"></canvas>
    </div>
    <div id="priceHistoryList" class="price-history-list"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost price-history-edit-actions" id="priceHistoryReset">Reset exclusions</button>
      <div style="flex:1"></div>
      <button class="btn btn-ghost" id="priceHistoryClose2">Cancel</button>
      <button class="btn btn-primary price-history-edit-actions" id="priceHistorySave">Save</button>
    </div>
  </div>
</div>`;

function initHistoryModal(cfg = {}) {
  _hmCfg = { ..._hmCfg, ...cfg };
  if (!document.getElementById('priceHistoryModal')) {
    document.body.insertAdjacentHTML('beforeend', HISTORY_MODAL_HTML);
  }
  initPriceHistoryModal();
  // Opt-in delegated listener for pages with no click routing of their own.
  // app.js already routes [data-manage-item] through its own row handlers, so
  // adding one here too would open the modal twice per click.
  if (_hmCfg.delegate) {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-manage-item]');
      if (btn) openHistoryFromManageBtn(btn.dataset.manageItem);
    });
  }
}

// ── Price History / Range Manager modal ─────────────────────────────────────

let _historyItem = null;
let _priceHistChart = null;
let _pendingExcl = null; // staged exclusions (Set), null when modal is closed

function _closePriceHistoryModal() {
  const modal = document.getElementById('priceHistoryModal');
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
  const modal = document.getElementById('priceHistoryModal');
  if (!modal) return;

  document.getElementById('priceHistoryClose').addEventListener('click', _closePriceHistoryModal);
  document.getElementById('priceHistoryClose2').addEventListener('click', _closePriceHistoryModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) _closePriceHistoryModal(); });

  // A read-only host (hot-deals) has no saveExclusions/undo-toast of its own, so
  // these controls are never wired there - and `simplified` below hides them.
  if (!_hmCfg.editable) return;

  document.getElementById('priceHistoryReset').addEventListener('click', () => {
    if (!_historyItem) return;
    _pendingExcl = new Set();
    openPriceHistoryModal(_historyItem);
  });

  document.getElementById('priceHistorySave').addEventListener('click', () => {
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
    _hmCfg.onSaved();
    _closePriceHistoryModal();

    // Only offer Undo when something actually changed.
    const changed = JSON.stringify(prevForItem) !== JSON.stringify(newForItem);
    if (changed) {
      showUndoToast(`Saved price exclusions for ${stripWW(itemName)}`, () => {
        const cur = loadExclusions();
        if (prevForItem) cur[itemName] = prevForItem;
        else delete cur[itemName];
        saveExclusions(cur);
        _hmCfg.onSaved();
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
  // promoUnitPrice, not the shelf price: a live multi-buy is the price you'd pay
  // today, and the stored history records it the same way - so the chart's last
  // point and tomorrow's history entry agree instead of jumping.
  const _wwToday = promoUnitPrice(item.woolworths), _coToday = promoUnitPrice(item.coles);
  if (_wwToday > 0 && !wwRaw.some(e => e.date === liveDate)) wwRaw.push({ date: liveDate, price: _wwToday });
  if (_coToday > 0 && !coRaw.some(e => e.date === liveDate)) coRaw.push({ date: liveDate, price: _coToday });
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
  if (!itemName) return;
  if (itemName.startsWith('__group_')) {
    const g = _hmCfg.buildGroup ? _hmCfg.buildGroup(itemName) : null;
    if (g) openPriceHistoryModal(g);
    return;
  }
  const item = _hmCfg.getItems().find(i => i.list_item === itemName);
  if (item) openPriceHistoryModal(item);
}

// opts.packPrices forces the pack-price view even for a per-kg group member.
// The Buy/Wait cards quote what you hand over at the till ($18 for the steak
// pack); opening them into the group's $/kg view showed $45.00 and $42.22 for
// the same product and read as two different items. A card and the chart it
// opens have to be in the same currency.
function openPriceHistoryModal(item, opts) {
  _historyItem = item;
  const kgR = (opts && opts.packPrices)
    ? { perKg: false, ww: 1, coles: 1, groupLabel: null }
    : histKgRatios(item);
  // Group members show a "GroupLabel - Product name" title so it's clear this is one
  // variant's history within the per-kg comparison, not the whole group's - a group can
  // mix WW-only and Coles-only products (e.g. "Lamb Mince"), so a single member's history
  // can legitimately show nothing for the store the group's headline price came from.
  const titleName = kgR.groupLabel ? `${kgR.groupLabel} - ${stripWW(item.list_item)}` : stripWW(item.list_item);
  // A group's history carries its own unit label (per 100 pcs, $/kg, or none for
  // a pack-price category); fall back to the $/kg flag for a member's history.
  const unitLbl = item._unitLabel || (kgR.perKg ? '$/kg' : '');
  document.getElementById('priceHistoryTitle').textContent =
    `Price History - ${titleName}${unitLbl ? ` (${unitLbl})` : ''}`;

  // Simplified view: no per-row exclude/"different item" editing, no Save/Reset -
  // just the read-only chart + list. Always on for a group's merged history (points
  // come from whichever member was cheapest that day, so there's no single item's
  // exclusion list to edit); on mobile it's a deliberate simplification the narrow
  // screen doesn't have room for.
  const simplified = !_hmCfg.editable || !!item._isGroupHistory || innerWidth <= 700;
  document.querySelectorAll('.price-history-edit-actions').forEach(el => el.style.display = simplified ? 'none' : '');
  const closeOnlyBtn = document.getElementById('priceHistoryClose2');
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
  // Days when a multi-buy beat the ticket price. The stored `price` IS the promo
  // rate (a real price the item sold at, so it counts toward the range and the
  // trend); `shelf` is what the ticket said, surfaced in the row's "?".
  const wwMb = new Map((item.ww_price_history    || []).filter(e => e.mb).map(e => [e.date, e]));
  const coMb = new Map((item.coles_price_history || []).filter(e => e.mb).map(e => [e.date, e]));
  const scrapeDates = new Set([...wwMap.keys(), ...coMap.keys()]);
  const scrapeEntries = [...scrapeDates].map(d => ({
    date: d, ww: wwMap.get(d) ?? null, coles: coMap.get(d) ?? null, source: 'scrape',
  }));

  // If the current live price isn't already the top history entry, inject it so it's always visible
  const wwLive = promoUnitPrice(item.woolworths);
  const coLive = promoUnitPrice(item.coles);
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
  // Live row: a deal running right now, shaped like a stored entry.
  const liveMb = (res) => {
    const mb = res?.multi_buy;
    if (!mb?.qty || mb.total == null || res.price == null) return null;
    const per = mb.total / mb.qty;
    return per < res.price ? { mb, shelf: res.price } : null;
  };
  const wwLiveMb = liveMb(item.woolworths), coLiveMb = liveMb(item.coles);
  if (wwLiveMb) wwMb.set(liveDate, wwLiveMb);
  if (coLiveMb) coMb.set(liveDate, coLiveMb);

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

  const listEl = document.getElementById('priceHistoryList');
  listEl.innerHTML = '';

  if (!allEntries.length) {
    listEl.innerHTML = '<div style="padding:16px;color:var(--text-soft);font-size:13px;">No price history available.</div>';
    document.body.style.overflow = 'hidden';
    document.getElementById('priceHistoryModal').classList.add('open');
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
    // "?" = the price shown is a multi-buy rate; the ticket price was higher.
    // Uses a native title tooltip on purpose: the history list is a scroll
    // container (overflow-y:auto), which clipped a CSS-positioned bubble.
    const mbNote = (store) => {
      const rec = (store === 'ww' ? wwMb : coMb).get(entry.date);
      const mb = rec?.mb;
      if (!mb?.qty || mb.total == null || rec.shelf == null) return '';
      return `<span class="price-hist-mb" tabindex="0" role="note" title="${escAttr(
        `Shelf $${Number(rec.shelf).toFixed(2)} · ${mb.qty} for $${mb.total.toFixed(2)}`
      )}">?</span>`;
    };
    const wwHtml = entry.ww != null
      ? `<span class="price-history-store-cell price-history-store-ww">
           <span class="price-history-price">${fmt(entry.ww * kgR.ww)}</span>${mbNote('ww')}${wwEditBtns}
         </span>`
      : `<span style="color:var(--text-soft)">-</span>`;

    const coHtml = entry.coles != null
      ? `<span class="price-history-store-cell price-history-store-coles">
           <span class="price-history-price" style="color:var(--coles)">${fmt(entry.coles * kgR.coles)}</span>${mbNote('coles')}${coEditBtns}
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
        _hmCfg.onSaved();
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
  document.getElementById('priceHistoryModal').classList.add('open');
}
