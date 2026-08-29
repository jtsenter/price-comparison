// Guards ONE invariant of the price-history modal for category rows:
//
//   the plotted SERIES and the "today" row must be in the SAME unit.
//
// buildGroupHistoryItem() builds the series by scaling each member's stored PACK
// price, but takes today's row straight from metricShown() - which quotes a
// weighed category per its `gramQuote` (100 or 1000 g) and a per-piece one per
// its piece quote. If the series scaling and metricShown() disagree, the newest
// point lands on a different scale from every older one and the chart reads as a
// huge overnight jump for a price that never moved.
//
// This has now bitten TWICE, in the two halves of the same expression:
//   - per-piece categories (fixed earlier; baby wipes showed $0.03 vs $10.00)
//   - weighed categories quoted per 100g (Aero Peppermint: today $4.24, every
//     earlier date $42.40 - a 10x phantom jump, and the modal titled "$/kg"
//     while plotting /100g numbers)
// $/kg is the default quote, so the weighed half stayed invisible until a
// category overrode it. Hence a check rather than a third fix.
//
// No framework, no deps. Run: node scripts/group_history_units_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');

function extract(src, name, where) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in ${where}`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// Real implementations of the scaling rules under test.
// buildGroupHistoryItem + exclSetsFor moved to utils.js so hot-deals.html can
// build a category's history too - its History button on a category row was
// dead without them.
const realUtils = ['weightQuoteOf', 'weightQuoteSuffix', 'isWeighedGroup', 'pieceQuoteOf',
                   'metricRound', 'metricShown', 'loadTrendRangeMode',
                   'exclSetsFor', 'buildGroupHistoryItem']
  .map(n => extract(utilsSrc, n, 'utils.js')).join('\n');
const realBuild = ['memberRawHistory', 'memberPerKgPrices',
                   'memberStoreFlags', 'groupPastPrices', 'groupBestPastShown',
                   'groupTrendPosition']
  .map(n => extract(appSrc, n, 'app.js')).join('\n');

// Taken from the source, not restated here: a stubbed cache would keep
// groupBestPastShown working in this harness after the real declaration was
// deleted, i.e. the check would pass for code that throws in the browser.
const cacheDecl = (appSrc.match(/const _groupBestSeriesCache\s*=\s*[^;]+;/) || [])[0];
assert(cacheDecl, '_groupBestSeriesCache declaration not found in app.js');

// Stubs for everything buildGroupHistoryItem touches that isn't the scaling rule.
const stubs = `
  const WEIGHT_QUOTES = [1000, 100];
  const PER_WEIGHT_QUOTE = 1000;
  const PIECE_QUOTES = [1, 10, 50, 100];
  const PER_PIECE_QUOTE = 1;
  const UNIT_METRIC_3DP_BELOW = 0.20;
  const _prefs = {};
  const localStorage = {
    getItem: k => (k in _prefs ? _prefs[k] : null),
    setItem: (k, v) => { _prefs[k] = String(v); },
  };
  function loadPerKgExclusions() { return new Set(); }
  // exclSetsFor is the REAL one now (it moved to utils.js with
  // buildGroupHistoryItem); it only needs the page-supplied store behind it.
  function loadExclusions() { return {}; }
  function packCountOf(n) { return (String(n).match(/(\\d+)\\s*pk/i) || [])[1] * 1 || 0; }
  function qtyPiecesPer(g) { return g && g._perPack ? pieceQuoteOf(g) : 1; }
  // price -> $/kg, i.e. exactly what clientPerKg/price gives for a real product.
  function perKgRatio(res) { return res && res.price && res._perKg ? res._perKg / res.price : null; }
  // Only reached with histOnly=false, which nothing under test uses.
  function clientPerKg() { return null; }
`;

const sandbox = new Function(`${stubs}\n${cacheDecl}\n${realUtils}\n${realBuild}
  return { buildGroupHistoryItem, metricShown, weightQuoteOf, weightQuoteSuffix,
           groupPastPrices, groupBestPastShown, groupTrendPosition,
           setTrendMode: m => localStorage.setItem('pw_trend_range_v1', m) };`)();
const { buildGroupHistoryItem, metricShown, groupPastPrices, groupBestPastShown,
        groupTrendPosition, setTrendMode } = sandbox;

// One member: a 118g block at $5.00 -> $42.37/kg.
function member(name, wwPrice, wwPerKg, coPrice, coPerKg, hist) {
  return {
    list_item: name,
    woolworths: wwPrice == null ? null : { price: wwPrice, _perKg: wwPerKg },
    coles: coPrice == null ? null : { price: coPrice, _perKg: coPerKg },
    price_history: [],
    ww_price_history: (hist || []).map(([date, price]) => ({ date, price })),
    coles_price_history: (hist || []).map(([date, price]) => ({ date, price })),
  };
}

function groupFor(gramQuote, opts) {
  const m = member('Choc Block 118g', 5.0, 42.4, 5.0, 42.4, [['2026-08-14', 5.0]]);
  return Object.assign({
    _groupKey: 'g', _groupLabel: 'G', _members: [m],
    _sticker: false, _perPack: false, gramQuote,
    _wwPerKg: 42.4, _coPerKg: 42.4,
    _wwBest: { result: {} }, _coBest: { result: {} },
  }, opts || {});
}

function check(label, cond, detail) {
  assert(cond, `${label}${detail ? '\n  ' + detail : ''}`);
  console.log('  ok  ' + label);
}

console.log('group history units:');

// THE regression. Per 100g: today and history must agree.
{
  const h = buildGroupHistoryItem(groupFor(100));
  const today = h.woolworths.price;
  const past = h.ww_price_history[0].price;
  check('per-100g category: today and history are the same scale',
    Math.abs(today - past) < 0.02,
    `today=${today} history=${past} (ratio ${(past / today).toFixed(2)}x)`);
  check('per-100g category: value really is per 100g, not per kg',
    Math.abs(past - 4.24) < 0.02, `got ${past}, expected ~4.24`);
  check('per-100g category is labelled $/100g, not $/kg',
    h._unitLabel === '$/100g', `got ${h._unitLabel}`);
}

// The default quote must be untouched by the fix.
{
  const h = buildGroupHistoryItem(groupFor(1000));
  const today = h.woolworths.price;
  const past = h.ww_price_history[0].price;
  check('per-kg category: today and history are the same scale',
    Math.abs(today - past) < 0.02, `today=${today} history=${past}`);
  check('per-kg category: value is per kg',
    Math.abs(past - 42.4) < 0.05, `got ${past}, expected ~42.4`);
  check('per-kg category is labelled $/kg', h._unitLabel === '$/kg', `got ${h._unitLabel}`);
}

// An unusable per-kg rate must DROP the point, never plot it at $0.00 - the
// reason the ratio is null-guarded instead of being multiplied inline.
{
  const m = member('No rate', 5.0, null, null, null, [['2026-08-14', 5.0]]);
  const g = groupFor(100, { _members: [m] });
  const h = buildGroupHistoryItem(g);
  check('member with no per-kg rate is dropped, not plotted at $0',
    !(h.ww_price_history || []).some(e => e.price === 0),
    JSON.stringify(h.ww_price_history));
}

// Sticker groups compare raw pack prices - the gram quote must not touch them.
{
  const h = buildGroupHistoryItem(groupFor(100, { _sticker: true }));
  check('sticker category still compares raw pack prices',
    Math.abs(h.ww_price_history[0].price - 5.0) < 0.001,
    `got ${h.ww_price_history[0].price}, expected 5.00`);
  check('sticker category has no unit label', h._unitLabel === null, `got ${h._unitLabel}`);
}

// ── Trend range: 'best' (cheapest per store per date) vs 'all' ──────────────
// The reported case, with its real numbers. A per-100-tablet category holding a
// 60pk that works out to $12.00/100 and a 100pk at $30.90/100 drew its bar from
// $12.00 to $30.90 - so a $19 pack sat mid-range and read as decent value,
// against a ceiling set by the one product the user never buys.
function tabletMember(name, wwHist) {
  return {
    list_item: name,
    woolworths: { price: wwHist[wwHist.length - 1][1] },
    coles: null,
    price_history: [],
    ww_price_history: wwHist.map(([date, price]) => ({ date, price })),
    coles_price_history: [],
  };
}

function tabletGroup() {
  const cheap = tabletMember('Shine Tablets 60 pk', [['2026-08-01', 7.20], ['2026-08-08', 7.20]]);
  const dear  = tabletMember('Finish Tablets 100 pk', [['2026-08-01', 30.90], ['2026-08-08', 30.90]]);
  return {
    _groupKey: 'dishwashing_tablets', _groupLabel: 'Dishwashing tablets',
    _members: [cheap, dear], _perPack: true, _sticker: false, _quote: 100,
    // per ONE piece: $7.20 / 60
    _wwPerKg: 0.12, _coPerKg: null,
    _wwBest: { perkg: 0.12, result: {} }, _coBest: null,
  };
}

{
  const g = tabletGroup();

  setTrendMode('all');
  const all = groupPastPrices(g).map(p => metricShown(g, p));
  check("'all' range still spans every member - $12.00 to $30.90",
    Math.abs(Math.min(...all) - 12) < 0.01 && Math.abs(Math.max(...all) - 30.9) < 0.01,
    `got ${Math.min(...all).toFixed(2)}..${Math.max(...all).toFixed(2)}`);

  setTrendMode('best');
  const best = groupBestPastShown(g);
  check("'best' range excludes the member nobody buys - no $30.90 ceiling",
    Math.abs(Math.max(...best) - 12) < 0.01,
    `got max ${Math.max(...best).toFixed(2)}, expected 12.00`);
  check("'best' keeps at most one point per store per date",
    best.length <= 2 * new Set(g._members.flatMap(m => m.ww_price_history.map(e => e.date))).size,
    `got ${best.length} points across 2 dates`);
  check("'best' is in the SAME units as metricShown('all') - per 100, not per 1",
    Math.abs(Math.min(...best) - Math.min(...all)) < 0.01,
    `best min ${Math.min(...best)} vs all min ${Math.min(...all)} - a 100x gap means metricShown was applied twice or not at all`);
}

// The weighed shape has its own scaling path (gramQuote, not pieceQuote), and it
// is the one that produced the original 10x phantom jump - so it gets the same
// same-units assertion rather than trusting the per-piece one to cover it.
{
  const g = groupFor(100, { _wwBest: { perkg: 42.4, result: {} }, _coBest: null, _coPerKg: null });
  setTrendMode('all');
  const all = groupPastPrices(g).map(p => metricShown(g, p));
  setTrendMode('best');
  const best = groupBestPastShown(g);
  check('weighed /100g category: both modes agree on scale',
    all.length && best.length && Math.abs(Math.min(...best) - Math.min(...all)) < 0.02,
    `best ${Math.min(...best)} vs all ${Math.min(...all)}`);
}

// The bar and the trend SORT read the same series, so a category sitting at its
// own low must sort ahead of one sitting mid-range - in EITHER mode. This is
// what breaks if `cur` is left in $/kg while the series is in $/100g: the
// position stays right (a ratio cancels the scale) but the flat-range epsilons
// below do not, so a flat category is graded against the wrong absolute number.
{
  const flat = tabletGroup();
  flat._members = [tabletMember('Shine Tablets 60 pk', [['2026-08-01', 7.20], ['2026-08-08', 7.20]])];
  for (const mode of ['best', 'all']) {
    setTrendMode(mode);
    check(`trend sort (${mode}): a category exactly at its flat all-time price grades 0.5`,
      Math.abs(groupTrendPosition(flat) - 0.5) < 1e-9,
      `got ${groupTrendPosition(flat)}`);
  }
  // Now the same category, but today it is CHEAPER than it has ever been.
  const low = tabletGroup();
  low._members = [tabletMember('Shine Tablets 60 pk', [['2026-08-01', 7.20], ['2026-08-08', 7.20]])];
  low._wwBest = { perkg: 0.10, result: {} };
  low._wwPerKg = 0.10;
  for (const mode of ['best', 'all']) {
    setTrendMode(mode);
    check(`trend sort (${mode}): below its own flat low sorts ahead of everything`,
      groupTrendPosition(low) === -1, `got ${groupTrendPosition(low)}`);
  }
}
setTrendMode('best');

// The two CALL SITES, checked on the source. The sandbox above proves
// groupBestPastShown returns display units; it cannot prove the bar remembers
// that, and "put it through metricShown as well" is the same 10x mistake this
// file already exists to catch - just one function further out.
{
  const cell = extract(appSrc, 'groupTrendCellHTML', 'app.js');
  const pos  = extract(appSrc, 'groupTrendPosition', 'app.js');
  for (const [label, src] of [['bar', cell], ['sort', pos]]) {
    check(`trend ${label} honours the range setting`, src.includes('loadTrendRangeMode()'));
    check(`trend ${label} reads the cheapest-per-store series`, src.includes('groupBestPastShown('));
  }
  // Both must switch on the SAME flag, or the bar and the order it sorts in can
  // show different pasts - the failure mode the "ONE series" comment in
  // groupTrendCellHTML was written for.
  check('the bar scales metricShown only on the non-best path',
    /bestOnly \? p : metricShown\(group, p\)/.test(cell),
    'the best-mode series is already display-scaled - scaling it again is a 10x/100x jump');
  // `cur` is ALWAYS metricShown now, in both modes. The flat-range epsilons in
  // groupTrendPosition are absolute money, so a raw `cur` measured against a
  // display-scaled series compared two different units - and, once metricShown
  // started rounding, a raw `cur` also lost to its own rounded series by a float
  // hair, drawing a category BELOW the all-time low it was sitting exactly on.
  check('the sort measures current price in the same display space as the series',
    /const cur = metricShown\(group, best\.perkg\);/.test(pos),
    'both modes must grade against metricShown, not a raw per-kg/per-piece figure');
  check('the non-best sort series is display-scaled to match',
    /groupPastPrices\(group\)\.map\(p => metricShown\(group, p\)\)/.test(pos));
}

// ── One price, one number, whichever route reaches it ───────────────────────
// Nappies, reported: a 40-pack at $11.50 quoted per 50. The two routes to that
// figure disagree in the last bit of a double -
//
//   history series:  11.50 * (50/40)  = 14.375              -> "$14.38"
//   live row:        (11.50/40) * 50  = 14.374999999999998  -> "$14.37"
//
// so the row said $14.37 while its own history said $14.38, a one-cent "price
// change" appeared out of nothing, and the trend graded 14.374999999999998
// against a flat 14.38 series, decided `cur < lo - 0.005` by two femtocents,
// and drew the marker BELOW a low it was sitting exactly on.
{
  const nappy = (name, pack, price, dates) => ({
    list_item: `${name} ${pack}pk`,
    woolworths: { price },
    coles: null,
    price_history: [],
    ww_price_history: dates.map(d => ({ date: d, price })),
    coles_price_history: [],
  });
  const g = {
    _groupKey: 'nappies_size6', _groupLabel: 'Diapers size 6',
    _members: [nappy("Little One's Ultra Dry Nappies Size 6", 40, 11.5,
                     ['2026-08-05', '2026-08-12', '2026-08-19', '2026-08-26'])],
    _sticker: true, _perPack: true, _quote: 50,
    _wwPerKg: 11.5 / 40, _coPerKg: null,
    _wwBest: { perkg: 11.5 / 40, result: {} }, _coBest: null,
  };

  check('the two float routes to one price agree',
    metricShown(g, 11.5 / 40) === +(11.5 * (50 / 40)).toFixed(2),
    `live ${metricShown(g, 11.5 / 40)} vs history ${+(11.5 * (50 / 40)).toFixed(2)}`);
  check('and that agreed value is $14.38, not $14.37',
    metricShown(g, 11.5 / 40) === 14.38, `got ${metricShown(g, 11.5 / 40)}`);

  const h = buildGroupHistoryItem(g);
  check('the row and its own history hold the identical number',
    h.woolworths.price === h.ww_price_history[0].price,
    `row ${h.woolworths.price} vs history ${h.ww_price_history[0].price}`);

  setTrendMode('best');
  check('a flat category sitting exactly on its all-time price grades 0.5, not below it',
    groupTrendPosition(g) === 0.5, `got ${groupTrendPosition(g)}`);

  setTrendMode('all');
  const floor = Math.min(...groupPastPrices(g).map(p => metricShown(g, p)));
  check("the 'all' range floor is the real price, not a truncation of it",
    floor === 14.38,
    `got ${floor} - rounding per-ONE-piece (0.2875 -> 0.287) put the floor at $14.35`);
  setTrendMode('best');
}

// The rounding must not flatten the sub-20c metrics fmtUnitMetric shows at 3dp:
// baby wipes run 2.9c to 14.2c each and three different winners printed as
// "$0.03" is the bug UNIT_METRIC_3DP_BELOW exists to prevent.
{
  const wipes = {
    _groupKey: 'w', _groupLabel: 'W', _members: [],
    _sticker: true, _perPack: true, _quote: 1,
    _wwPerKg: 0.0286, _coPerKg: 0.0312,
  };
  check('a sub-20c metric keeps its third decimal',
    metricShown(wipes, 0.0286) === 0.029 && metricShown(wipes, 0.0312) === 0.031,
    `got ${metricShown(wipes, 0.0286)} and ${metricShown(wipes, 0.0312)}`);
  check('two different sub-20c metrics stay different',
    metricShown(wipes, 0.0286) !== metricShown(wipes, 0.0312));
}

// ── Every page that renders a category History button must resolve it ───────
// The modal does not know how to turn "__group_maggi_2_minute_noodles_chicken"
// back into a group - it asks the host page via cfg.buildGroup and, given no
// resolver, returns null and opens NOTHING. No error, no feedback: hot-deals
// rendered the button on category rows and the click was simply dead, while
// every plain product on the same page worked.
{
  const hd = fs.readFileSync(path.join(__dirname, '..', 'docs', 'hot-deals.html'), 'utf8');
  const modalSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'history-modal.js'), 'utf8');

  check('the modal still delegates group resolution to the host page',
    /_hmCfg\.buildGroup \? _hmCfg\.buildGroup\(itemName\) : null/.test(modalSrc),
    'if this changes, the reasoning below no longer applies');

  for (const [page, src] of [['hot-deals.html', hd], ['app.js', appSrc]]) {
    // A page that can emit a "__group_" manage button must be able to build one.
    const emits = /__group_/.test(src);
    if (!emits) continue;
    check(`${page} supplies buildGroup for its category History buttons`,
      /buildGroup:/.test(src),
      'renders a category row but cannot resolve its own group key - the button is dead');
  }

  check('hot-deals builds the group from the shared utils.js builder',
    /buildGroupHistoryItem\(g\)/.test(hd) && /buildVariantGroups\(byName\)/.test(hd),
    're-implementing the builder here is how two copies drift apart');
}

console.log('\nAll group-history unit self-checks passed.');

// ── One outside shop is named; several are summarised as ＋ ─────────────────
// A per-product badge that shows one shop's coloured letter is a claim that the
// product is sold THERE. That is true while there is exactly one outside shop,
// and false the moment there are two - the chip, the history column and the
// chart line are then summaries of all of them (cheapest per date), so they
// carry the generic ＋ the "other stores" column already uses. The winning shop
// is still named in the tooltip, and still leads the panel when it opens.
{
  const modal = fs.readFileSync(path.join(__dirname, '..', 'docs', 'history-modal.js'), 'utf8');

  check('the row chip counts DISTINCT shops, not entries',
    /new Set\(entries\.map\(e => e\.store\)\)\.size === 1/.test(appSrc),
    'two entries at the same shop are still one shop');
  check('the row chip drops the shop letter when there are several',
    /third-chip-many/.test(appSrc) && /oneShop\s*\?/.test(appSrc));

  check('the history column names a shop only when there is exactly one',
    /thTblShops\.size === 1/.test(modal));
  check('the chart line names a shop only when there is exactly one',
    /thShops\.size === 1/.test(modal));
  check('with several shops the series is the CHEAPEST per date',
    /if \(!thMap\.has\(h\.date\) \|\| v < thMap\.get\(h\.date\)\)/.test(modal)
    && /if \(!thTblMap\.has\(h\.date\) \|\| h\.price < thTblMap\.get\(h\.date\)\)/.test(modal),
    'a single line labelled "other stores" is only honest if it is the best of them');
  check('every shop contributes its dates, not just the cheapest one',
    /for \(const e of thirdEntries\)/.test(modal) && /for \(const e of thirdRows\)/.test(modal),
    'a price checked on a day only one shop was visited must still get a row');
}
