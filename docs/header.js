/* ─────────────────────────────────────────────────────────────────────────
 * Shared site header — SINGLE SOURCE OF TRUTH for the top nav on every page.
 *
 * Each page carries only:   <header data-page="index"></header>
 *                           <script src="header.js?v=1"></script>
 * and this file fills it in. Edit the header HERE and all pages update — no
 * more per-page drift.
 *
 * The common chrome (brand + Hot/Basket/Alerts nav cluster + notification bell)
 * is identical everywhere. Only the trailing action button legitimately differs
 * per page (index → Update Prices + table controls; basket → Print; alerts /
 * scrape-log → Refresh; validate → none), so those live in per-page templates
 * right below each other — impossible to update one and forget the rest.
 * ─────────────────────────────────────────────────────────────────────────*/
(function () {
  var host = document.querySelector('header[data-page]');
  if (!host) return;
  var page = host.getAttribute('data-page');

  /* ── SVG icons (kept as consts so the templates stay readable) ── */
  var SVG_HOT   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>';
  var SVG_CART  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
  var SVG_TAG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
  var SVG_BELL  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  var SVG_REF   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  var SVG_SEARCH= '<svg class="header-search-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  var SVG_GEAR  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var SVG_GRID  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var SVG_COLS  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';

  /* Brand block (left). Standardised on .store-chip everywhere. */
  var BRAND =
    '<a href="index.html" class="brand">' +
      '<span class="store-chip ww">W</span>' +
      '<span class="store-chip coles">C</span>' +
      '<span class="brand-name">PriceWatch</span>' +
    '</a>';

  /* Hot / Basket / Alerts nav cluster. `active` gets the .here highlight. */
  function navCluster(active) {
    function a(cls, href, title, svg, id) {
      var here = (cls === active) ? ' here' : '';
      return '<a class="btn btn-ghost btn-icon nav-icon-btn nav-' + cls + here + '"' +
             (id ? ' id="' + id + '"' : '') +
             ' href="' + href + '" title="' + title + '">' + svg + '</a>';
    }
    // basketNavLink id is load-bearing: app.js intercepts it on index so the
    // basket opens with the selected items (or everything currently visible)
    // instead of whatever stale list the basket page last had.
    return a('hot', 'hot-deals.html', 'Hot Deals', SVG_HOT) +
           a('basket', 'shopping-list.html', 'Basket', SVG_CART, 'basketNavLink') +
           a('alerts', 'alerts.html', 'Price Alerts', SVG_TAG);
  }

  /* Notification bell (hidden until app.js finds name changes). */
  var NOTIF =
    '<span class="header-div"></span>' +
    '<button class="btn btn-ghost btn-icon" id="notifBtn" aria-label="Notifications" title="Notifications" style="display:none">' +
      SVG_BELL + '<span class="notif-badge" id="notifBadge"></span>' +
    '</button>';

  /* Validate link — a subtle nav link shown (by app.js) when flagged prices exist.
     On index it is a ghost pill in the right cluster; elsewhere a left-nav link. */
  var VALIDATE_NAV = '<nav id="mainNav"><a href="validate.html" id="validateNavLink"' +
    (page === 'validate' ? ' class="active"' : ' style="display:none"') + '>⚠️ Validate</a></nav>';

  /* Scrape progress strip (only where a scrape can be triggered). */
  var STRIP =
    '<div id="scrapeStrip" class="scrape-strip" style="display:none">' +
      '<span id="scrapeStripLabel" class="scrape-strip-label">Scraping…</span>' +
      '<div class="scrape-strip-track"><div class="scrape-strip-fill" id="scrapeStripFill" style="width:0%"></div></div>' +
      '<span id="scrapeStripPct" class="scrape-strip-pct">0%</span>' +
      '<button id="scrapeStripRetry" class="scrape-strip-retry" style="display:none" title="Trigger a new scrape run">↺ Retry</button>' +
      '<button id="scrapeStripDismiss" class="scrape-strip-dismiss" title="Dismiss">✕</button>' +
    '</div>';

  /* Index-only options dropdown + table controls (view toggle, columns). */
  var INDEX_CONTROLS =
    '<div class="col-chooser-wrap" id="optionsWrap">' +
      '<button class="btn btn-ghost btn-icon" id="optionsBtn" title="Options">' + SVG_GEAR + '</button>' +
      '<div id="optionsDropdown" class="col-chooser-dropdown more-dropdown options-dropdown" style="display:none">' +
        '<div class="options-group"><div class="options-group-label">Theme</div>' +
          '<div class="options-seg" id="themeSeg">' +
            '<button class="opt-seg-btn" data-theme-opt="light">Light</button>' +
            '<button class="opt-seg-btn" data-theme-opt="dark">Dark</button>' +
            '<button class="opt-seg-btn" data-theme-opt="auto">Auto</button>' +
          '</div></div>' +
        '<div class="options-group"><div class="options-group-label">Row density</div>' +
          '<div class="options-seg" id="densitySeg">' +
            '<button class="opt-seg-btn" data-density-opt="comfortable">Comfortable</button>' +
            '<button class="opt-seg-btn" data-density-opt="compact">Compact</button>' +
          '</div></div>' +
        '<div class="options-divider"></div>' +
        '<button class="more-dropdown-item" id="importBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Import Items</button>' +
        '<button class="more-dropdown-item" id="settingsBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Auto-update Setup</button>' +
        '<a class="more-dropdown-item" href="alerts.html"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>Price Alerts</a>' +
        '<a class="more-dropdown-item" href="scrape-log.html"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Scrape Log</a>' +
      '</div>' +
    '</div>' +
    '<button class="btn btn-ghost btn-icon view-toggle-btn" id="viewToggleBtn" title="Switch to card view">' + SVG_GRID + '</button>' +
    '<div class="col-chooser-wrap">' +
      '<button class="btn btn-ghost btn-icon" id="colChooserBtn" title="Columns">' + SVG_COLS + '</button>' +
      '<div id="colChooserDropdown" class="col-chooser-dropdown" style="display:none"></div>' +
    '</div>';

  /* ── Per-page inner markup ─────────────────────────────────────────────── */
  var inner;
  if (page === 'index') {
    inner =
      '<div class="header-inner">' +
        '<div class="header-left">' + BRAND + '</div>' +
        '<div class="search-wrap header-search" id="searchWrap" style="display:none">' +
          SVG_SEARCH +
          '<input type="search" id="searchInput" placeholder="Search items…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" readonly onfocus="this.removeAttribute(\'readonly\')">' +
          '<button class="search-clear" id="searchClear" style="display:none" title="Clear search">✕</button>' +
        '</div>' +
        '<div class="header-right">' +
          '<a href="validate.html" id="validateNavLink" class="validate-pill" style="display:none">⚠️ Validate</a>' +
          navCluster(null) + NOTIF + INDEX_CONTROLS +
          '<button class="btn btn-primary btn-icon" id="refreshBtn" title="Update prices">' + SVG_REF + '</button>' +
        '</div>' +
      '</div>' + STRIP;
  } else {
    // Trailing action button varies per page.
    var trail =
      page === 'hot-deals'     ? '<button class="btn btn-primary" id="refreshBtn">' + SVG_REF + ' Update Prices</button>' :
      page === 'shopping-list' ? '<button class="btn btn-primary" onclick="window.print()">🖨 Print</button>' :
      page === 'alerts'        ? '<button class="btn btn-ghost" id="alRefreshBtn" title="Reload alerts">' + SVG_REF + ' Refresh</button>' :
      page === 'scrape-log'    ? '<button class="btn btn-ghost" id="slRefreshBtn" title="Reload log">' + SVG_REF + ' Refresh</button>' :
      '';
    var active =
      page === 'hot-deals' ? 'hot' :
      page === 'shopping-list' ? 'basket' :
      page === 'alerts' ? 'alerts' : null;
    inner =
      '<div class="header-inner">' +
        '<div class="header-left">' + BRAND + VALIDATE_NAV + '</div>' +
        '<div class="header-right">' + navCluster(active) + NOTIF + trail + '</div>' +
      '</div>' +
      (page === 'hot-deals' ? STRIP : '');
  }

  host.innerHTML = inner;
})();
