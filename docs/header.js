/* ─────────────────────────────────────────────────────────────────────────
 * Shared site header — SINGLE SOURCE OF TRUTH for the top nav on every page.
 *
 * Each page carries only:   <header data-page="X"></header>
 *                           <script src="header.js?v=4"></script>
 * and this file fills it in. Edit the header HERE and all pages update — no
 * more per-page drift.
 *
 * The chrome is IDENTICAL on every page: brand, Hot/Basket/Watchlist cluster,
 * notification bell, Options (⚙) menu, scrape-progress strip. Only two things
 * legitimately differ per page: the search box (index-only — it searches the
 * main table) and the trailing primary action (index/hot-deals → Update
 * Prices; basket → Print; scrape-log → Refresh).
 *
 * This file also OWNS the behaviour of what it renders on every page: the ⚙
 * dropdown, the theme switcher, and (on pages app.js doesn't run on) the
 * scrape-strip poller. Index-only menu items (Import, Auto-update Setup, Row
 * density) are wired by app.js as before.
 * ─────────────────────────────────────────────────────────────────────────*/
(function () {
  var host = document.querySelector('header[data-page]');
  if (!host) return;
  var page = host.getAttribute('data-page');

  /* ── SVG icons (kept as consts so the templates stay readable) ── */
  var SVG_HOT   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>';
  var SVG_CART  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
  var SVG_EYE   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  var SVG_BELL  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
  var SVG_REF   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  var SVG_SEARCH= '<svg class="header-search-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  var SVG_GEAR  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  /* ── Component CSS injected here so pages that don't link style.css (the
        basket page has its own standalone stylesheet) still render the ⚙
        dropdown, validate pill and scrape strip correctly. Identical rules
        exist in style.css for the pages that do link it — duplicates are
        harmless. ── */
  var CSS =
    '.col-chooser-wrap{position:relative}' +
    '.col-chooser-dropdown{position:absolute;top:calc(100% + 6px);right:0;background:var(--card,#fff);border:1px solid var(--border,#E2E8F0);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:300;min-width:210px;padding:8px 0}' +
    '.more-dropdown{min-width:180px;padding:6px 0}' +
    '.more-dropdown-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 16px;font-size:13px;font-weight:500;color:var(--text,#1A1F2E);background:none;border:none;cursor:pointer;text-align:left;text-decoration:none;transition:background .1s}' +
    '.more-dropdown-item:hover{background:var(--bg,#F0F4F8)}' +
    '.more-dropdown-item svg{flex-shrink:0;color:var(--text-mid,#475569)}' +
    '.options-dropdown{min-width:200px;padding:10px}' +
    '.options-group+.options-group{margin-top:12px}' +
    '.options-divider{border-top:1px solid var(--border,#E2E8F0);margin:10px -10px 4px}' +
    '.options-group-label{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft,#94A3B8);margin-bottom:6px}' +
    '.options-seg{display:flex;gap:4px;background:var(--bg,#F0F4F8);border:1px solid var(--border,#E2E8F0);border-radius:8px;padding:3px}' +
    '.opt-seg-btn{flex:1;padding:6px 8px;font-size:12px;font-weight:600;color:var(--text-mid,#475569);background:none;border:none;border-radius:6px;cursor:pointer;transition:background .12s,color .12s}' +
    '.opt-seg-btn:hover{color:var(--text,#1A1F2E)}' +
    '.opt-seg-btn.active{background:var(--card,#fff);color:var(--text,#1A1F2E);box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
    '.validate-pill{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 12px;flex-shrink:0;border-radius:9px;text-decoration:none;white-space:nowrap;font-size:13px;font-weight:600;background:transparent;color:var(--text-mid,#475569);border:1px solid var(--border,#CBD5E1);transition:background .12s,color .12s,border-color .12s}' +
    '.validate-pill:hover{background:var(--bg,#F0F4F8);color:var(--text,#1A1F2E)}' +
    '.scrape-strip{display:flex;align-items:center;gap:10px;padding:5px 20px;background:var(--card,#fff);border-top:1px solid var(--border,#E2E8F0);font-size:12px;color:var(--text-mid,#475569)}' +
    '.scrape-strip-label{white-space:nowrap;font-weight:600;min-width:120px}' +
    '.scrape-strip-track{flex:1;height:5px;background:var(--bg,#F0F4F8);border-radius:3px;overflow:hidden;border:1px solid var(--border,#E2E8F0)}' +
    '.scrape-strip-fill{height:100%;background:linear-gradient(90deg,var(--ww,#00843D),#00c851);border-radius:3px;transition:width .4s ease;min-width:4px}' +
    '.scrape-strip-pct{font-size:11px;color:var(--text-soft,#94A3B8);white-space:nowrap;min-width:30px;text-align:right}' +
    '.scrape-strip-retry{background:none;border:1px solid var(--border,#E2E8F0);border-radius:6px;cursor:pointer;color:var(--text-mid,#475569);font-size:12px;font-weight:600;padding:2px 10px;white-space:nowrap}' +
    '.scrape-strip-dismiss{background:none;border:none;cursor:pointer;color:var(--text-soft,#94A3B8);font-size:14px;line-height:1;padding:0 2px;flex-shrink:0}' +
    '@media (max-width:700px){.validate-pill{display:none}}';
  var styleEl = document.createElement('style');
  styleEl.id = 'pw-header-css';
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* Brand block (left). Standardised on .store-chip everywhere. */
  var BRAND =
    '<a href="index.html" class="brand">' +
      '<span class="store-chip ww">W</span>' +
      '<span class="store-chip coles">C</span>' +
      '<span class="brand-name">PriceWatch</span>' +
    '</a>';

  /* Hot / Basket / Watchlist nav cluster. `active` gets the .here highlight. */
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
    // Watchlist: on index it's a BUTTON (mobileWatchBtn — app.js toggles the
    // watchlist filter in place); on other pages a link to index#watchlist,
    // which app.js activates on load.
    var watch = (page === 'index')
      ? '<button class="btn btn-ghost btn-icon nav-icon-btn nav-watch" id="mobileWatchBtn" type="button" title="Watchlist">' + SVG_EYE + '</button>'
      : a('watch', 'index.html#watchlist', 'Watchlist', SVG_EYE);
    return a('hot', 'hot-deals.html', 'Hot Deals', SVG_HOT) +
           a('basket', 'shopping-list.html', 'Basket', SVG_CART, 'basketNavLink') +
           watch;
  }

  /* Notification bell (hidden until page JS finds name changes). */
  var NOTIF =
    '<span class="header-div"></span>' +
    '<button class="btn btn-ghost btn-icon" id="notifBtn" aria-label="Notifications" title="Notifications" style="display:none">' +
      SVG_BELL + '<span class="notif-badge" id="notifBadge"></span>' +
    '</button>';

  /* Validate pill — shown by page JS when flagged prices exist. Identical slot
     on every page (index's app.js and the other pages' initNavBell both key
     off the id). */
  var VALIDATE =
    '<a href="validate.html" id="validateNavLink" class="validate-pill"' +
    (page === 'validate' ? '' : ' style="display:none"') + '>⚠️ Validate</a>';

  /* Scrape progress strip — on EVERY page, so a running scrape stays visible
     wherever you navigate. index/hot-deals update it from their own data
     loads; other pages use the lightweight poller below. */
  var STRIP =
    '<div id="scrapeStrip" class="scrape-strip" style="display:none">' +
      '<span id="scrapeStripLabel" class="scrape-strip-label">Scraping…</span>' +
      '<div class="scrape-strip-track"><div class="scrape-strip-fill" id="scrapeStripFill" style="width:0%"></div></div>' +
      '<span id="scrapeStripPct" class="scrape-strip-pct">0%</span>' +
      '<button id="scrapeStripRetry" class="scrape-strip-retry" style="display:none" title="Trigger a new scrape run">↺ Retry</button>' +
      '<button id="scrapeStripDismiss" class="scrape-strip-dismiss" title="Dismiss">✕</button>' +
    '</div>';

  /* Options (⚙) dropdown — identical on every page. Index-only items (Row
     density, Import, Auto-update Setup) render only there: they act on the
     main table/modals that other pages don't have. Theme + Scrape Log are
     universal and wired right here in header.js. */
  var OPTIONS =
    '<div class="col-chooser-wrap" id="optionsWrap">' +
      '<button class="btn btn-ghost btn-icon" id="optionsBtn" title="Options">' + SVG_GEAR + '</button>' +
      '<div id="optionsDropdown" class="col-chooser-dropdown more-dropdown options-dropdown" style="display:none">' +
        '<div class="options-group"><div class="options-group-label">Theme</div>' +
          '<div class="options-seg" id="themeSeg">' +
            '<button class="opt-seg-btn" data-theme-opt="light">Light</button>' +
            '<button class="opt-seg-btn" data-theme-opt="dark">Dark</button>' +
            '<button class="opt-seg-btn" data-theme-opt="auto">Auto</button>' +
          '</div></div>' +
        (page === 'index'
          ? '<div class="options-group"><div class="options-group-label">Row density</div>' +
              '<div class="options-seg" id="densitySeg">' +
                '<button class="opt-seg-btn" data-density-opt="comfortable">Comfortable</button>' +
                '<button class="opt-seg-btn" data-density-opt="compact">Compact</button>' +
              '</div></div>' +
            '<div class="options-divider"></div>' +
            '<button class="more-dropdown-item" id="importBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Import Items</button>' +
            '<button class="more-dropdown-item" id="settingsBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Auto-update Setup</button>'
          : '<div class="options-divider"></div>') +
        '<a class="more-dropdown-item" href="scrape-log.html"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Scrape Log</a>' +
      '</div>' +
    '</div>';

  /* Trailing primary action — the ONE allowed per-page difference besides
     search. */
  var TRAIL =
    page === 'index'         ? '<button class="btn btn-primary btn-icon" id="refreshBtn" title="Update prices">' + SVG_REF + '</button>' :
    page === 'hot-deals'     ? '<button class="btn btn-primary" id="refreshBtn">' + SVG_REF + ' Update Prices</button>' :
    page === 'shopping-list' ? '<button class="btn btn-primary" onclick="window.print()">🖨 Print</button>' :
    page === 'scrape-log'    ? '<button class="btn btn-ghost" id="slRefreshBtn" title="Reload log">' + SVG_REF + ' Refresh</button>' :
    '';

  var active =
    page === 'hot-deals' ? 'hot' :
    page === 'shopping-list' ? 'basket' : null;

  /* ── Assemble: one identical structure for every page. Only index gets the
        search box (it searches the main table). ── */
  var SEARCH = page === 'index'
    ? '<div class="search-wrap header-search" id="searchWrap" style="display:none">' +
        SVG_SEARCH +
        '<input type="search" id="searchInput" placeholder="Search items…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" readonly onfocus="this.removeAttribute(\'readonly\')">' +
        '<button class="search-clear" id="searchClear" style="display:none" title="Clear search">✕</button>' +
      '</div>'
    : '';

  host.innerHTML =
    '<div class="header-inner">' +
      '<div class="header-left">' + BRAND + '</div>' +
      SEARCH +
      '<div class="header-right">' + VALIDATE + navCluster(active) + NOTIF + OPTIONS + TRAIL + '</div>' +
    '</div>' + STRIP;

  /* ══ Behaviour owned by the header (runs on every page) ══════════════════ */

  /* Options dropdown toggle + outside-click close. Also closes the other
     header dropdowns (bell, columns) so only one is open at a time. */
  var optBtn = document.getElementById('optionsBtn');
  var optDd  = document.getElementById('optionsDropdown');
  if (optBtn && optDd) {
    optBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var opening = optDd.style.display === 'none';
      ['notifDropdown', 'colChooserDropdown'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
      });
      optDd.style.display = opening ? 'block' : 'none';
    });
    optDd.addEventListener('click', function (e) {
      e.stopPropagation();
      // Menu items (Import / Auto-update Setup) open a modal — close the menu behind it.
      if (e.target.closest('.more-dropdown-item')) optDd.style.display = 'none';
    });
    document.addEventListener('click', function () { optDd.style.display = 'none'; });
  }

  /* Theme switcher — universal. (Row density stays app.js-wired: index-only.) */
  function applyHeaderTheme() {
    var t = 'light';
    try { t = localStorage.getItem('pw_theme') || 'light'; } catch (e) {}
    var dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.querySelectorAll('#themeSeg .opt-seg-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.themeOpt === t);
    });
  }
  applyHeaderTheme();
  var mq = matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', applyHeaderTheme);
  var themeSeg = document.getElementById('themeSeg');
  if (themeSeg) themeSeg.addEventListener('click', function (e) {
    var b = e.target.closest('.opt-seg-btn'); if (!b) return;
    try { localStorage.setItem('pw_theme', b.dataset.themeOpt); } catch (err) {}
    applyHeaderTheme();
  });

  /* Scrape strip on pages app.js/hot-deals don't drive: check on load; while a
     scrape is running (or freshly dispatched — pw_scrape_dispatched_v1 marker,
     set by index's Update Prices), poll latest.json and mirror progress. Stops
     polling once idle so we don't refetch a large file forever. */
  if (page !== 'index' && page !== 'hot-deals') {
    var stripDismissed = false;
    var dismissBtn = document.getElementById('scrapeStripDismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', function () {
      stripDismissed = true;
      try { localStorage.removeItem('pw_scrape_dispatched_v1'); } catch (e) {}
      var s = document.getElementById('scrapeStrip');
      if (s) s.style.display = 'none';
    });

    var stripTimer = null;
    var checkStrip = function () {
      fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var strip = document.getElementById('scrapeStrip');
          if (!strip || stripDismissed) return;
          var prog = d && d.scrape_progress;
          var disp = null;
          try { disp = localStorage.getItem('pw_scrape_dispatched_v1'); } catch (e) {}
          var t = disp ? Date.parse(disp) : NaN;
          var spent = isNaN(t) || Date.now() - t > 100 * 60 * 1000 ||
                      (d && d.last_updated && Date.parse(d.last_updated) >= t);
          if (disp && spent && !prog) { try { localStorage.removeItem('pw_scrape_dispatched_v1'); } catch (e) {} }
          var activeScrape = false;
          if (prog && prog.total > 0) {
            var pct = Math.round((prog.done / prog.total) * 100);
            strip.style.display = 'flex';
            document.getElementById('scrapeStripLabel').textContent = 'Refreshing prices… ' + prog.done + ' of ' + prog.total;
            document.getElementById('scrapeStripFill').style.width = pct + '%';
            document.getElementById('scrapeStripPct').textContent = pct + '%';
            activeScrape = true;
          } else if (disp && !spent) {
            strip.style.display = 'flex';
            document.getElementById('scrapeStripLabel').textContent = '⏳ Scrape triggered — waiting for first progress…';
            document.getElementById('scrapeStripFill').style.width = '0%';
            document.getElementById('scrapeStripPct').textContent = '';
            activeScrape = true;
          } else {
            strip.style.display = 'none';
          }
          if (activeScrape && !stripTimer) stripTimer = setInterval(checkStrip, 20000);
          if (!activeScrape && stripTimer) { clearInterval(stripTimer); stripTimer = null; }
        })
        .catch(function () {});
    };
    checkStrip();
  }
})();
