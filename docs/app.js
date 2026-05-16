// ── Utilities ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '—';
const fmtUnit = (price, unit) => price != null ? `${fmt(price)}/${unit || 'unit'}` : '';

function daysSince(isoString) {
  const ms = Date.now() - new Date(isoString).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
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
      alert(`GitHub API error ${res.status}: ${err.message || 'Unknown error'}\n\nCheck your token and repo settings.`);
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
  const maxAttempts = 40; // ~10 minutes at 15s each
  let attempts = 0;

  const poll = async () => {
    attempts++;
    if (attempts > maxAttempts) {
      btn.innerHTML = '↻ Refresh Now';
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
        if (run.conclusion === 'success') {
          btn.innerHTML = '✓ Done — reloading…';
          setTimeout(() => {
            // Bust cache on latest.json then reload
            fetch(`data/latest.json?t=${Date.now()}`)
              .then((r) => r.json())
              .then((d) => { renderPage(d); btn.innerHTML = '↻ Refresh Now'; btn.disabled = false; })
              .catch(() => { location.reload(); });
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
  } catch {
    return null;
  }
}

async function loadNameChanges() {
  try {
    const res = await fetch(`data/name_changes_detected.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Index page rendering ─────────────────────────────────────────────────────

function renderPage(data) {
  $('loading').style.display = 'none';

  if (!data || !data.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Refresh Now to fetch prices.';
    return;
  }

  // Stale check
  if (daysSince(data.last_updated) > 5) {
    $('staleBanner').classList.add('visible');
  }

  // Banner
  const s = data.summary;
  const winnerEl = $('winnerText');
  if (s.cheaper_store === 'woolworths') {
    winnerEl.textContent = `Woolworths is cheaper by ${fmt(s.total_saving)}`;
    winnerEl.className = 'banner-winner ww';
  } else if (s.cheaper_store === 'coles') {
    winnerEl.textContent = `Coles is cheaper by ${fmt(s.total_saving)}`;
    winnerEl.className = 'banner-winner coles';
  } else {
    winnerEl.textContent = 'Both stores cost the same';
    winnerEl.className = 'banner-winner equal';
  }

  $('wwTotal').textContent = fmt(s.total_woolworths);
  $('colesTotal').textContent = fmt(s.total_coles);
  $('savingAmount').textContent = fmt(s.total_saving);
  $('savingAmount').className = `amount ${s.cheaper_store === 'equal' ? '' : 'ww'}`;
  $('lastUpdated').textContent = `Last updated: ${formatDate(data.last_updated)} · ${s.items_compared} items compared`;
  $('banner').style.display = 'flex';

  // Table
  const tbody = $('tableBody');
  tbody.innerHTML = '';

  data.items.forEach((item) => {
    const ww = item.woolworths;
    const co = item.coles;
    const cheaper = item.cheaper_store;

    const wwCell = ww
      ? `<div class="price-main">${fmt(ww.price)}</div><div class="price-unit">${fmtUnit(ww.unit_price, ww.unit)}</div>`
      : '<span style="color:var(--gray-400)">Not found</span>';

    const coCell = co
      ? `<div class="price-main">${fmt(co.price)}</div><div class="price-unit">${fmtUnit(co.unit_price, co.unit)}</div>`
      : '<span style="color:var(--gray-400)">Not found</span>';

    let badgeHtml = '';
    if (cheaper === 'woolworths') badgeHtml = '<span class="cheaper-badge ww">WW</span>';
    else if (cheaper === 'coles') badgeHtml = '<span class="cheaper-badge coles">Coles</span>';
    else if (cheaper === 'equal') badgeHtml = '<span class="cheaper-badge equal">Equal</span>';

    const savingHtml = item.saving_per_item > 0
      ? `<span class="saving-cell">${fmt(item.saving_per_item)}</span>`
      : '';

    const wwLinkName = ww?.url ? `<a href="${ww.url}" target="_blank">${item.list_item}</a>` : item.list_item;
    const coLinkName = co?.url ? `<a href="${co.url}" target="_blank">${item.list_item}</a>` : item.list_item;
    const bestLink = cheaper === 'coles' ? coLinkName : wwLinkName;

    const wwClass = cheaper === 'woolworths' ? 'cell-ww' : '';
    const coClass = cheaper === 'coles' ? 'cell-coles' : '';

    tbody.insertAdjacentHTML('beforeend', `
      <tr>
        <td class="item-name">${bestLink}</td>
        <td class="price-cell ${wwClass}">${wwCell}</td>
        <td class="price-cell ${coClass}">${coCell}</td>
        <td class="cheaper-cell">${badgeHtml}</td>
        <td>${savingHtml}</td>
      </tr>
    `);
  });

  $('footWW').textContent = fmt(s.total_woolworths);
  $('footColes').textContent = fmt(s.total_coles);
  $('footSaving').innerHTML = `<span class="saving-cell">${fmt(s.total_saving)}</span>`;

  $('tableContainer').style.display = 'block';

  // Not found
  if (data.not_found_items?.length > 0) {
    const ul = $('notFoundList');
    ul.innerHTML = data.not_found_items.map((n) => `<li>${n}</li>`).join('');
    $('notFoundSection').style.display = 'block';
  }
}

// ── Alternatives page rendering ───────────────────────────────────────────────

function renderAlternatives(data) {
  $('loading').style.display = 'none';

  if (!data || !data.items) {
    $('loading').style.display = 'block';
    $('loading').textContent = 'No price data yet. Click Refresh Now to fetch prices.';
    return;
  }

  $('altSubtitle').textContent =
    `Last updated: ${formatDate(data.last_updated)} · showing cheaper per-unit alternatives for your list`;
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
    const bestPrice = bestMatch?.price;
    const bestUnit = bestMatch?.unit_price;

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
        </div>
      `;
    }).join('');

    grid.insertAdjacentHTML('beforeend', `
      <div class="alt-card">
        <div class="alt-card-header">
          <div class="your-item">Your item</div>
          <div class="item-name">${item.list_item}</div>
          <div class="item-price">${bestMatch ? `${fmt(bestPrice)} · ${fmtUnit(bestUnit, bestMatch.unit)}` : ''}</div>
        </div>
        ${rows}
      </div>
    `);
  });

  if (count === 0) {
    $('noAlts').style.display = 'block';
  }
}

// ── Name changes notice ───────────────────────────────────────────────────────

async function showNameChangesNotice() {
  const changes = await loadNameChanges();
  if (!changes || Object.keys(changes).length === 0) return;
  const notice = $('nameChangesNotice');
  if (!notice) return;
  const count = Object.keys(changes).length;
  notice.innerHTML = `ℹ️ <strong>${count} possible product name change${count > 1 ? 's' : ''} detected</strong> — some items may have been renamed. <a href="data/name_changes_detected.json" target="_blank">Review →</a>`;
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
  }
}

document.addEventListener('DOMContentLoaded', boot);
