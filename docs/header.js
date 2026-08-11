/* ─────────────────────────────────────────────────────────────────────────
 * Shared site header - SINGLE SOURCE OF TRUTH for the top nav on every page.
 *
 * Each page carries only:   <header data-page="X"></header>
 *                           <script src="header.js?v=4"></script>
 * and this file fills it in. Edit the header HERE and all pages update - no
 * more per-page drift.
 *
 * The chrome is IDENTICAL on every page: brand, Hot/Basket cluster, Options
 * (⚙) menu, scrape-progress strip - plus a standalone Home link on the left
 * everywhere except index. Only two things legitimately differ per page: the
 * search box (index-only - it searches the main table) and the trailing
 * primary action (index/hot-deals → Update Prices; basket → Print;
 * scrape-log → Refresh).
 *
 * This file also OWNS the behaviour of what it renders on every page: the ⚙
 * dropdown, the theme switcher, and (on pages app.js doesn't run on) the
 * scrape-strip poller. Index-only menu items (Import, Auto-update Setup) are
 * wired by app.js as before.
 * ─────────────────────────────────────────────────────────────────────────*/
(function () {
  var host = document.querySelector('header[data-page]');
  if (!host) return;
  var page = host.getAttribute('data-page');

  /* ── Viewer (read-only) mode ───────────────────────────────────────────────
     Anyone without a GitHub token is a VIEWER. Every repo-write path in this app
     already refuses to run without that token, so this is a UX layer over an
     existing security boundary, not the boundary itself: it hides the controls
     that could only ever fail for a visitor (Update Prices, Auto-update Setup,
     Validate, the strip's Retry) instead of letting them click into an error.
     A viewer's priorities/categories/filters stay in their own browser and are
     never published - see initUserSettings() in app.js.
     `?setup=1` forces owner mode so the owner can paste a token on a new device.
     Duplicated from utils.js isViewerMode() on purpose: header.js runs BEFORE
     utils.js on every page (same reason the CSS above is duplicated). */
  var viewer = (function () {
    try {
      if (new URLSearchParams(location.search).has('setup')) return false;
      return !(localStorage.getItem('gh_token') || '').trim();
    } catch (e) { return true; }   // storage blocked → assume viewer, the safe side
  })();
  document.documentElement.classList.toggle('pw-viewer', viewer);

  /* ── SVG icons (kept as consts so the templates stay readable) ── */
  var SVG_HOT   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>';
  var SVG_CART  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
  var SVG_WARN  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var SVG_REF   = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
  var SVG_SEARCH= '<svg class="header-search-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  var SVG_GEAR  = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  /* ── Component CSS injected here so pages that don't link style.css (the
        basket page has its own standalone stylesheet) still render the ⚙
        dropdown, validate pill and scrape strip correctly. Identical rules
        exist in style.css for the pages that do link it - duplicates are
        harmless. ── */
  var CSS =
    '.col-chooser-wrap{position:relative}' +
    '.col-chooser-dropdown{position:absolute;top:calc(100% + 6px);right:0;background:var(--card,#fff);border:1px solid var(--border,#E2E8F0);border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:300;min-width:210px;padding:8px 0}' +
    '.more-dropdown{min-width:180px;padding:6px 0}' +
    '.more-dropdown-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 16px;font-size:13px;font-weight:500;color:var(--text,#1A1F2E);background:none;border:none;cursor:pointer;text-align:left;text-decoration:none;transition:background .1s}' +
    '.more-dropdown-item:hover{background:var(--bg,#F0F4F8)}' +
    '.more-dropdown-item svg{flex-shrink:0;color:var(--text-mid,#475569)}' +
    /* One line, never wrapped onto two, and desktop-only where asked. */
    '.more-dropdown-item.nowrap-item{white-space:nowrap}' +
    '@media(max-width:640px){.more-dropdown-item.desktop-only{display:none}}' +
    '.options-dropdown{min-width:200px;padding:10px}' +
    '.options-group+.options-group{margin-top:12px}' +
    '.options-divider{border-top:1px solid var(--border,#E2E8F0);margin:10px -10px 4px}' +
    '.options-group-label{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-soft,#94A3B8);margin-bottom:6px}' +
    '.options-seg{display:flex;gap:4px;background:var(--bg,#F0F4F8);border:1px solid var(--border,#E2E8F0);border-radius:8px;padding:3px}' +
    '.opt-seg-btn{flex:1;padding:6px 8px;font-size:12px;font-weight:600;color:var(--text-mid,#475569);background:none;border:none;border-radius:6px;cursor:pointer;transition:background .12s,color .12s}' +
    '.opt-seg-btn:hover{color:var(--text,#1A1F2E)}' +
    '.opt-seg-btn.active{background:var(--card,#fff);color:var(--text,#1A1F2E);box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
    /* Icon-only now, matching every other header button - word lives in the
       title tooltip instead of on the button (was "⚠️ Validate (N)" as
       visible text, alone among the icon-only cluster). */
    '.validate-btn{position:relative}' +
    '.validate-badge{position:absolute;top:-4px;right:-4px;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#c95000;color:#fff;font-size:10px;font-weight:700;line-height:1;border:2px solid var(--card,#fff)}' +
    // Basket count - same corner-badge geometry as .validate-badge, in the
    // basket icon's own green so it reads as "how many" and not "problem".
    // Defined only here, not in style.css: shopping-list.html doesn't load
    // style.css, and this file runs on every page.
    '.basket-badge{position:absolute;top:-4px;right:-4px;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--ww,#00843D);color:#fff;font-size:10px;font-weight:700;line-height:1;border:2px solid var(--card,#fff)}' +
    '.pw-viewer-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;margin-left:8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:var(--bg,#F0F4F8);color:var(--text-soft,#94A3B8);border:1px solid var(--border,#E2E8F0);cursor:default;flex-shrink:0}' +
    /* Any control that writes to the repo can carry data-owner-only and vanish
       for visitors, without each page needing its own viewer-mode wiring. */
    '.pw-viewer [data-owner-only]{display:none!important}' +
    '.scrape-strip{display:flex;align-items:center;gap:10px;padding:5px 20px;background:var(--card,#fff);border-top:1px solid var(--border,#E2E8F0);font-size:12px;color:var(--text-mid,#475569)}' +
    '.scrape-strip-label{white-space:nowrap;font-weight:600;min-width:120px}' +
    '.scrape-strip-track{flex:1;height:5px;background:var(--bg,#F0F4F8);border-radius:3px;overflow:hidden;border:1px solid var(--border,#E2E8F0)}' +
    '.scrape-strip-fill{height:100%;background:linear-gradient(90deg,var(--ww,#00843D),#00c851);border-radius:3px;transition:width .4s ease;min-width:4px}' +
    '.scrape-strip-pct{font-size:11px;color:var(--text-soft,#94A3B8);white-space:nowrap;min-width:30px;text-align:right}' +
    '.scrape-strip-retry{background:none;border:1px solid var(--border,#E2E8F0);border-radius:6px;cursor:pointer;color:var(--text-mid,#475569);font-size:12px;font-weight:600;padding:2px 10px;white-space:nowrap}' +
    '.scrape-strip-dismiss{background:none;border:none;cursor:pointer;color:var(--text-soft,#94A3B8);font-size:14px;line-height:1;padding:0 2px;flex-shrink:0}' +
    /* Scrape strip is a web-only convenience; hidden on phones (app.js sets an
       inline display:flex, so the override needs !important to win). */
    '@media (max-width:700px){.scrape-strip{display:none!important}}' +
    /* Header icon sizing lives HERE (not per-page CSS) so the hot/basket/options
       buttons are pixel-identical on every page - basket's inline stylesheet was
       missing style.css's 38px rule, so its icons rendered 33x29 vs 38x38. */
    'header .header-right .btn-icon{height:38px;min-width:38px;justify-content:center;box-sizing:border-box}' +
    '@media (max-width:700px){.validate-btn{display:none}}';
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

  /* Hot / Basket nav cluster. `active` gets the .here highlight.
     (Watchlist is a FILTER, not a destination - it lives in the filter row on
     index and the mobile sort toolbar. The notification bell was retired: the
     validate pill already covers "data needs attention".) */
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
           a('basket', 'shopping-list.html', 'Basket', SVG_CART, 'basketNavLink');
  }

  /* No standalone home link on ANY page: the PriceWatch brand logo already
     links home, so a separate house icon was redundant clutter (it had lingered
     on validate / scrape-log after being dropped from the main three pages). */
  var HOME = '';

  /* Validate pill - shown by page JS when flagged prices exist. Identical slot
     on every page (index's app.js and the other pages' initNavBell both key
     off the id). */
  var VALIDATE = viewer ? '' :
    '<a href="validate.html" id="validateNavLink" class="btn btn-ghost btn-icon validate-btn" title="Validate"' +
    (page === 'validate' ? '' : ' style="display:none"') + '>' + SVG_WARN + '</a>';

  /* Tells a visitor WHY the owner-only controls aren't there, so "the buttons are
     missing" doesn't come back as a bug report. */
  var VIEWER_BADGE = viewer
    ? '<span class="pw-viewer-badge" title="Read-only demo. Your filters, categories and priorities are saved in this browser only - they are never sent anywhere.">Demo</span>'
    : '';

  /* Scrape progress strip - on EVERY page, so a running scrape stays visible
     wherever you navigate. index/hot-deals update it from their own data
     loads; other pages use the lightweight poller below. */
  var STRIP =
    '<div id="scrapeStrip" class="scrape-strip" style="display:none">' +
      '<span id="scrapeStripLabel" class="scrape-strip-label">Scraping…</span>' +
      '<div class="scrape-strip-track"><div class="scrape-strip-fill" id="scrapeStripFill" style="width:0%"></div></div>' +
      '<span id="scrapeStripPct" class="scrape-strip-pct">0%</span>' +
      // Retry dispatches a fresh scrape - owner only. The rest of the strip is
      // read-only status, so viewers still see a run in progress.
      (viewer ? '' : '<button id="scrapeStripRetry" class="scrape-strip-retry" style="display:none" title="Trigger a new scrape run">↺ Retry</button>') +
      '<button id="scrapeStripDismiss" class="scrape-strip-dismiss" title="Dismiss">✕</button>' +
    '</div>' +
    /* What actually changed in the last run. Sits directly under the strip and
       inherits its width. Shown ONCE per run: reloading the page clears it, so
       it reports rather than nags. The ✕ turns it off for good. */
    '<div id="priceDigest" class="price-digest" style="display:none">' +
      '<span class="pd-ic">📈</span>' +
      '<span id="priceDigestText" class="pd-text"></span>' +
      '<a href="scrape-log.html" class="pd-more">See all</a>' +
      '<button id="priceDigestOff" class="pd-x" title="Never show this again">✕</button>' +
    '</div>';

  /* Options (⚙) dropdown - identical on every page. Index-only items (Import,
     Auto-update Setup) render only there: they act on modals other pages
     don't have. Theme + Scrape Log are universal and wired right here. */
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
        (page === 'index' && !viewer
          ? '<div class="options-divider"></div>' +
            '<button class="more-dropdown-item" id="importBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Import Items</button>' +
            '<button class="more-dropdown-item" id="settingsBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Auto-update Setup</button>'
          : '<div class="options-divider"></div>') +
        // Unregisters the service worker and clears Cache Storage from inside the
        // page, for when a browser keeps serving an already-installed worker's OLD
        // files. Leaves localStorage alone - token and preferences survive.
        // Sits ABOVE Scrape Log (they were the other way round) and is
        // desktop-only - see .more-dropdown-item.desktop-only in style.css.
        '<button class="more-dropdown-item desktop-only nowrap-item" id="forceRefreshBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>Hard refresh</button>' +
        '<a class="more-dropdown-item" href="scrape-log.html"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Scrape Log</a>' +
      '</div>' +
    '</div>';

  /* Trailing primary action. Hot Deals no longer triggers scrapes from here
     (that lives on index); basket's Print moved to PRINT_LEAD (before the nav
     cluster) so the two headers read identically apart from that one button.
     index and scrape-log now render the SAME button (primary, icon-only, no
     label) - the ghost "↻ Refresh" pill on scrape-log was the one header control
     that didn't match its twin on the main page. Behaviour still differs and the
     tooltip says so: index dispatches a scrape, scrape-log re-reads the log. */
  var TRAIL =
    // Update Prices dispatches a workflow - owner only. (scrape-log's Refresh just
    // re-reads the log file, so it stays for everyone.)
    (page === 'index' && !viewer)
      ? '<div class="scrape-split">' +
          '<button class="btn btn-primary btn-icon scrape-split-main" id="refreshBtn" title="Update prices">' + SVG_REF + '</button>' +
          '<button class="btn btn-primary scrape-split-caret" id="scrapeModeBtn" title="Choose quick or full scrape" aria-haspopup="true" aria-expanded="false">▾</button>' +
          '<div class="scrape-menu" id="scrapeMenu" style="display:none">' +
            '<button class="scrape-menu-item" data-mode="quick">' +
              '<strong>Quick scrape</strong><span>Only items whose price actually moves</span></button>' +
            '<button class="scrape-menu-item" data-mode="full">' +
              '<strong>Full scrape</strong><span>Everything, including the never-movers</span></button>' +
            '<div class="scrape-menu-note" id="scrapeMenuNote"></div>' +
          '</div>' +
        '</div>' :
    page === 'scrape-log' ? '<button class="btn btn-primary btn-icon" id="slRefreshBtn" title="Reload log">' + SVG_REF + '</button>' :
    '';

  /* Basket's Print button, placed to the LEFT of the nav cluster so the basket
     and Hot Deals headers are otherwise pixel-identical. */
  var PRINT_LEAD = page === 'shopping-list'
    ? '<button class="btn btn-primary" onclick="window.print()" title="Print shopping list">🖨 Print</button>'
    : '';

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

  /* Hot Deals' own "N deals · of M with enough history" line, in the same flex
     slot SEARCH uses on index - the two pages never both need it. Empty until
     hot-deals.html's renderDeals() fills it in; on mobile the whole header-inner
     is hidden for this page (see style.css), so the count stays in the page
     body there instead - this slot is desktop-only real estate. */
  var PAGE_STAT = page === 'hot-deals'
    ? '<span class="header-page-stat" id="hdHeaderStat"></span>'
    : '';

  host.innerHTML =
    '<div class="header-inner">' +
      '<div class="header-left">' + HOME + BRAND + VIEWER_BADGE + '</div>' +
      SEARCH + PAGE_STAT +
      /* Options (⚙) sits LEFT of the Hot/Basket pair, not after it: it is chrome,
         and the two nav icons plus the page's primary action are the things you
         reach for. Set here so every page inherits the same order. */
      '<div class="header-right">' + VALIDATE + PRINT_LEAD + OPTIONS + navCluster(active) + TRAIL + '</div>' +
    '</div>' + STRIP;

  /* ══ Behaviour owned by the header (runs on every page) ══════════════════ */

  /* Basket count badge on the 🛒 nav icon. Counts DISTINCT items, not total
     units - same number the floating "🛒 (n)" cart badge shows on index and
     hot-deals, so the two can never disagree.
     Reads localStorage rather than taking a count argument, so it stays right
     no matter which page mutated the basket; the pages call it from their
     basket WRITERS (app.js writeBasket, hot-deals hdBasketSave,
     shopping-list persistBasket), never from a renderer that might run first. */
  window.pwSyncBasketBadge = function () {
    var link = document.getElementById('basketNavLink');
    if (!link) return;
    var n = 0;
    try {
      n = (JSON.parse(localStorage.getItem('pw_sl_handoff') || '{}').items || []).length;
    } catch (e) { n = 0; }   // corrupt store - show no badge rather than NaN
    var badge = link.querySelector('.basket-badge');
    if (!n) { if (badge) badge.remove(); link.title = 'Basket'; return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'basket-badge';
      link.appendChild(badge);
    }
    // 3 digits would overflow the 38px button and shove the icon off-centre.
    badge.textContent = n > 99 ? '99+' : String(n);
    link.title = 'Basket (' + n + (n === 1 ? ' item)' : ' items)');
  };
  window.pwSyncBasketBadge();

  /* Basket changed in another tab - keep the count honest without a reload. */
  window.addEventListener('storage', function (e) {
    if (e.key === 'pw_sl_handoff') window.pwSyncBasketBadge();
  });

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
      // Menu items (Import / Auto-update Setup) open a modal - close the menu behind it.
      if (e.target.closest('.more-dropdown-item')) optDd.style.display = 'none';
    });
    document.addEventListener('click', function () { optDd.style.display = 'none'; });
  }

  /* Scrape-mode menu. The caret opens it; picking an item dispatches that mode
     directly. The plain button keeps working on its own and uses whatever the
     schedule says, so the common case is still one click. */
  var modeBtn = document.getElementById('scrapeModeBtn');
  var modeMenu = document.getElementById('scrapeMenu');
  if (modeBtn && modeMenu) {
    modeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = modeMenu.style.display !== 'none';
      modeMenu.style.display = open ? 'none' : 'block';
      modeBtn.setAttribute('aria-expanded', String(!open));
      if (!open && typeof defaultScrapeMode === 'function') {
        var d = defaultScrapeMode();
        modeMenu.querySelectorAll('.scrape-menu-item').forEach(function (b) {
          b.classList.toggle('is-default', b.dataset.mode === d.mode);
        });
        var note = document.getElementById('scrapeMenuNote');
        if (note) note.textContent = d.reason + ' The plain button runs the '
          + d.mode + ' one.';
      }
    });
    modeMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      var item = e.target.closest('.scrape-menu-item');
      if (!item) return;
      modeMenu.style.display = 'none';
      modeBtn.setAttribute('aria-expanded', 'false');
      if (typeof triggerRefresh === 'function') triggerRefresh(item.dataset.mode);
    });
    document.addEventListener('click', function () {
      modeMenu.style.display = 'none';
      modeBtn.setAttribute('aria-expanded', 'false');
    });
  }

  /* Price-change digest. Reads the newest entry in price_changes.json and shows
     it ONCE - the run's date is stamped on show, so a reload finds it already
     seen and stays quiet. ✕ sets a permanent off switch. */
  (function () {
    var box = document.getElementById('priceDigest');
    if (!box) return;
    var off = document.getElementById('priceDigestOff');
    if (off) off.addEventListener('click', function () {
      try { localStorage.setItem('pw_digest_off', '1'); } catch (e) {}
      box.style.display = 'none';
    });
    try { if (localStorage.getItem('pw_digest_off') === '1') return; } catch (e) { return; }
    fetch('data/price_changes.json?t=' + Date.now()).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (log) {
      if (!log || !log.length) return;
      var run = log[log.length - 1];
      var seen = '';
      try { seen = localStorage.getItem('pw_digest_seen') || ''; } catch (e) {}
      if (seen === run.date) return;              // already reported this run
      var all = (run.ww || []).concat(run.coles || []);
      if (!all.length) return;                     // nothing changed - say nothing
      var moves = all.map(function (c) {
        var pct = c.old > 0 ? Math.round((c.new - c.old) / c.old * 100) : 0;
        return { name: c.item, pct: pct };
      }).filter(function (m) { return m.pct !== 0; })
        .sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); });
      if (!moves.length) return;
      var txt = document.getElementById('priceDigestText');
      var top = moves.slice(0, 3).map(function (m) {
        var cls = m.pct > 0 ? 'pd-up' : 'pd-down';
        var sign = m.pct > 0 ? '+' : '';
        return '<span class="pd-item">' + m.name.replace(/[<>&]/g, '') +
               ' <span class="' + cls + '">' + sign + m.pct + '%</span></span>';
      }).join(' · ');
      txt.innerHTML = '<b>' + all.length + ' change' + (all.length === 1 ? '' : 's') +
                      '.</b> ' + top;
      box.style.display = 'flex';
      try { localStorage.setItem('pw_digest_seen', run.date); } catch (e) {}
    }).catch(function () {});
  })();

  /* "Fix stuck data / force refresh": unregisters this page's service worker
     and clears its Cache Storage, then reloads. Same fix as clearing site data
     from browser settings, done from inside the page so there is no menu to
     hunt for. localStorage is untouched on purpose - the GitHub token and
     saved priorities/units/theme all survive. */
  var refreshBtn = document.getElementById('forceRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function () {
      if (!confirm('Clear this app\'s cached files and reload? Your saved settings and GitHub token are not affected.')) return;
      var done = function () { location.reload(true); };
      if (!('serviceWorker' in navigator)) { done(); return; }
      navigator.serviceWorker.getRegistrations()
        .then(function (regs) { return Promise.all(regs.map(function (r) { return r.unregister(); })); })
        .then(function () { return ('caches' in window) ? caches.keys() : []; })
        .then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); })
        .then(done)
        .catch(done);   // even if a step fails, still reload - never leave the user stuck
    });
  }

  /* Theme switcher - universal. (Row density stays app.js-wired: index-only.) */
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
     scrape is running (or freshly dispatched - pw_scrape_dispatched_v1 marker,
     set by index's Update Prices), poll latest.json and mirror progress. Stops
     polling once idle so we don't refetch a large file forever. */
  if (page !== 'index' && page !== 'hot-deals') {
    var stripDismissed = false;
    var lastProg = null;
    // Sticky progress. A single fetch can come back WITHOUT scrape_progress mid-run -
    // GitHub Pages' CDN serves several edge caches and one of them can still be
    // holding a copy from before the run started. Reacting to that immediately made
    // the strip flip to "waiting for first progress" and back on almost every poll
    // (reported as 65→waiting→70→waiting→70→75). app.js already rode these out via
    // _lastProgress; this poller had no such guard. Keep the last count until THREE
    // consecutive fetches agree the run is over.
    var stickyProg = null;
    var noProgStreak = 0;
    var sawProgress = false;
    // "Dismiss forever": a completed (done>=total) or killed run can leave
    // scrape_progress stuck in latest.json; the old in-memory flag reset on
    // refresh so ✕ never stuck. Persist the run's started_at so ✕ buries THAT
    // run for good, across reloads and pages. Shared key with app.js.
    var SCRAPE_DISMISS_KEY = 'pw_scrape_dismissed_v1';
    var scrapeRunId = function (p) { return p && (p.started_at || (p.total != null ? 'legacy_' + p.total : '')) || ''; };
    var scrapeRunDismissed = function (p) {
      var id = scrapeRunId(p); if (!id) return false;
      try { return (JSON.parse(localStorage.getItem(SCRAPE_DISMISS_KEY) || '[]') || []).indexOf(id) >= 0; } catch (e) { return false; }
    };
    var markScrapeRunDismissed = function (p) {
      var id = scrapeRunId(p); if (!id) return;
      try { var a = JSON.parse(localStorage.getItem(SCRAPE_DISMISS_KEY) || '[]') || [];
        if (a.indexOf(id) < 0) { a.push(id); localStorage.setItem(SCRAPE_DISMISS_KEY, JSON.stringify(a.slice(-20))); } } catch (e) {}
    };
    var dismissBtn = document.getElementById('scrapeStripDismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', function () {
      stripDismissed = true;
      markScrapeRunDismissed(lastProg);
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
          if (prog) lastProg = prog;
          // A run at done>=total is finished (the field just wasn't cleared) - treat
          // it as no-progress so a stuck 53-of-53 auto-hides instead of lingering.
          if (prog && prog.total > 0 && prog.done >= prog.total) prog = null;
          if (prog && scrapeRunDismissed(prog)) prog = null;
          // Ride out a single progress-less fetch (see stickyProg above).
          if (prog) { stickyProg = prog; sawProgress = true; noProgStreak = 0; }
          else if (stickyProg && ++noProgStreak >= 3) { stickyProg = null; sawProgress = false; noProgStreak = 0; }
          prog = prog || stickyProg;
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
            document.getElementById('scrapeStripLabel').textContent = 'Updating prices… ' + prog.done + ' of ' + prog.total;
            document.getElementById('scrapeStripFill').style.width = pct + '%';
            document.getElementById('scrapeStripPct').textContent = pct + '%';
            activeScrape = true;
          } else if (disp && !spent && !sawProgress) {
            // Only before the FIRST progress of this dispatch. Once a count has been
            // seen, regressing to "waiting for first progress" is simply wrong.
            strip.style.display = 'flex';
            document.getElementById('scrapeStripLabel').textContent = '⏳ Scrape triggered - waiting for first progress…';
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
    /* A page that dispatches its own scrape (scrape-log's "retry the misses")
       sets the pw_scrape_dispatched_v1 marker AFTER this poller's first pass, so
       nothing would show until the next page load. One hook, so the strip
       appears immediately instead. */
    window.pwCheckScrapeStrip = checkStrip;
  }
})();
