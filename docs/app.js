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

// ── Price history bar ────────────────────────────────────────────────────────

function buildPriceBar(priceHistory, currentPrice) {
  if (!priceHistory?.length || currentPrice == null) return '';
  const prices = priceHistory.map(p => p.price).filter(p => p > 0);
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

  return `
    <div class="price-bar-outer">
      <div class="price-bar">
        <div class="price-marker" style="left:${pos.toFixed(1)}%"></div>
      </div>
      <div class="price-bar-labels">
        <span>${fmt(minP)}</span>
        <span>${fmt(maxP)}</span>
      </div>
      <div class="price-bar-tooltip"><pre>${tooltip}</pre></div>
    </div>`;
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

  // Table
  const tbody = $('tableBody');
  tbody.innerHTML = '';

  // Sort by trip_count descending so most-bought items appear first
  const sorted = [...data.items].sort((a, b) => (b.trip_count || 0) - (a.trip_count || 0));

  sorted.forEach((item) => {
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;

    // Product image (prefer Coles, fall back to WW)
    const imgSrc = co?.image_url || ww?.image_url || '';
    const imgHtml = imgSrc
      ? `<img class="item-img" src="${imgSrc}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : '<div class="item-img-placeholder"></div>';

    // Trip count badge
    const tripBadge = item.trip_count
      ? `<span class="trip-count">${item.trip_count}×</span>`
      : '';

    // Item name link (link to cheaper store's page)
    const wwLink = ww?.url ? `<a href="${ww.url}" target="_blank">${item.list_item}</a>` : item.list_item;
    const coLink = co?.url ? `<a href="${co.url}" target="_blank">${item.list_item}</a>` : item.list_item;
    const nameLink = cheaper === 'coles' ? coLink : wwLink;

    // Price history bar (uses Coles price as current reference if available)
    const currentRef = co?.price ?? ww?.price;
    const bar = buildPriceBar(item.price_history, currentRef);

    const itemCell = `
      <div class="item-row">
        ${imgHtml}
        <div class="item-info">
          <div class="item-title-row">${nameLink}${tripBadge}</div>
          ${bar}
        </div>
      </div>`;

    // Price cells with clickable links
    const wwPriceVal = ww?.url
      ? `<a href="${ww.url}" target="_blank" class="price-link">${fmt(ww?.price)}</a>`
      : fmt(ww?.price);
    const wwCell = ww
      ? `<div class="price-main">${wwPriceVal}</div><div class="price-unit">${fmtUnit(ww.unit_price, ww.unit)}</div>`
      : '<span class="no-data">—</span>';

    const coPriceVal = co?.url
      ? `<a href="${co.url}" target="_blank" class="price-link">${fmt(co?.price)}</a>`
      : fmt(co?.price);
    const coCell = co
      ? `<div class="price-main">${coPriceVal}</div><div class="price-unit">${fmtUnit(co.unit_price, co.unit)}</div>`
      : '<span class="no-data">—</span>';

    let badgeHtml = '';
    if (cheaper === 'woolworths') badgeHtml = '<span class="cheaper-badge ww">WW</span>';
    else if (cheaper === 'coles') badgeHtml = '<span class="cheaper-badge coles">Coles</span>';
    else if (cheaper === 'equal') badgeHtml = '<span class="cheaper-badge equal">Equal</span>';

    const savingHtml = item.saving_per_item > 0
      ? `<span class="saving-cell">${fmt(item.saving_per_item)}</span>`
      : '';

    const safeItem = item.list_item.replace(/"/g, '&quot;');
    const refreshBtn = `<button class="item-refresh-btn" data-item="${safeItem}" title="Refresh prices for this item">↻</button>`;

    const wwClass = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass = cheaper === 'coles' ? 'cell-coles' : '';

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="item-name">${itemCell}</td>
        <td class="price-cell ${wwClass}">${wwCell}</td>
        <td class="price-cell ${coClass}">${coCell}</td>
        <td class="cheaper-cell">${badgeHtml}</td>
        <td><div class="saving-row">${savingHtml}${refreshBtn}</div></td>
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
        const btn = e.target.closest('.item-refresh-btn');
        if (!btn) return;
        triggerItemRefresh(btn.dataset.item, btn);
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', boot);
