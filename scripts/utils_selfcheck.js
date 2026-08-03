// Self-check for docs/utils.js - the single source of truth for per-100g pricing,
// trend position, and hot-deal detection shared by index.html and hot-deals.html.
// No framework, no deps: extracts the real functions straight from utils.js (so the
// logic under test is single-sourced, not a re-implementation that could drift) and
// asserts against them. Run: node scripts/utils_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

// Slice `function NAME(...) { ... }` by brace-matching from the first '{'.
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in utils.js`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// getTrendSeries() calls the global loadExclusions() (defined in app.js/hot-deals.html
// in the real app, hoisted before use there). Stub it here; tests override per-case.
let _exclStub = {};
global.loadExclusions = () => _exclStub;
// buildPriceBar formats its min/max labels with the host page's fmt() - both
// index.html and hot-deals.html define one. Same implicit dependency it had
// before moving into utils.js; stubbed here.
global.fmt = (v) => v == null ? '-' : '$' + Number(v).toFixed(2);

// getDealQuality() closes over these two module-level tuning constants.
function extractConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*[^;]+;`));
  assert(m, `const ${name} not found in utils.js`);
  return m[0];
}

// buildDealGroups() reads localStorage (per-kg membership overrides) and the
// module-level DEFAULT_VARIANT_GROUPS. Stub the former empty; inject a small
// fixture for the latter so the test exercises the LOGIC (cheapest $/kg per
// store, $/kg conversion, skip-empty) against controlled data rather than the
// real 250-name seed. Membership-override resolution is covered separately via
// variantGroupItemNames below.
// Mutable localStorage mock (pendingValidationCount reads AND prunes it).
let _lsStore = {};
global.localStorage = {
  getItem: k => (k in _lsStore ? _lsStore[k] : null),
  setItem: (k, v) => { _lsStore[k] = String(v); },
};
// variantGroupOf() caches its member->category index in two module-level lets.
// extract() pulls functions only, so declare them here - as globals, since a
// `let` inside the direct eval below would not be visible to the extracted
// function bodies.
global._vgIndex = null;
global._vgIndexKey = null;
global.GROUP_DEFAULT_CATEGORY = 'Meat & Seafood';
global.DEFAULT_VARIANT_GROUPS = [
  { key: 'basa_fillets', label: 'Basa Fillets', items: ['Woolworths Frozen Basa Fillets 1kg', 'Coles Frozen Basa Fillet'] },
  { key: 'lamb_mince',   label: 'Lamb Mince',   items: ['Some Lamb Mince 500g'] },
];

// eslint-disable-next-line no-eval
eval([
  extractConst('DEAL_MIN_SPREAD'),
  extractConst('DEAL_MIN_DROP'),
  extract('clientPer100'),
  extract('groupMetric'),
  extract('per100Pair'),
  extract('scalePer100'),      // card view restates $/100g at the multi-buy price
  extract('fmt'),              // the one money formatter for the whole site
  extract('sameQtyCost'),      // store-gap compares equal quantities, not packs
  extract('exclPriceSet'),
  extract('promoUnitPrice'),   // history + hot-deal detection price through this
  extract('mbUnitPrice'),      // getTrendSeries prices the current point through this
  extract('buildPriceBar'),    // moved here from app.js; hot-deals draws the same bar
  extract('getTrendSeries'),
  extract('_median'),
  extract('getDealQuality'),
  extract('calcTrendPosition'),
  extract('variantGroupItemNames'),
  extract('migratePerKgOverride'),
  extract('computePerKgItems'),
  extract('loadVariantGroups'),
  extract('variantGroupOf'),   // member -> its category
  extract('settingsKeyFor'),   // the key a member's settings actually live under
  extract('buildDealGroups'),
  extract('perKgEquivBundle'),
  extract('pendingValidationCount'),
  extract('multiBuyCost'),
  extract('multiBuyNudge'),
].join('\n'));

let n = 0;
function check(label, actual, expected) {
  n++;
  assert.deepStrictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── clientPer100 ─────────────────────────────────────────────────────────────
check('kg from name', clientPer100({ price: 10, name: 'Foo 2kg' }), { value: 0.5, label: '100g' });
check('g from name', clientPer100({ price: 5, name: 'Bar 250g' }), { value: 2, label: '100g' });
check('L from name', clientPer100({ price: 3, name: 'Milk 2L' }), { value: 0.15, label: '100ml' });
check('ml from name', clientPer100({ price: 2, name: 'Juice 500ml' }), { value: 0.4, label: '100ml' });
check('cup-price fallback (loose, kg unit)',
  clientPer100({ price: 10, unit_price: 10, unit: '1kg', name: 'Loose Bananas' }),
  { value: 1, label: '100g' });
check('no price -> null', clientPer100({ price: null }), { value: null, label: '100g' });
check('no data at all -> null', clientPer100(null), { value: null, label: '100g' });

// ── per100Pair (no lone unit price when both stores are priced) ──────────────
{
  const withSize = { price: 5, name: 'Foo 500g' };     // -> $1.00/100g
  const noSize   = { price: 3, name: 'Bar' };           // -> null
  // both priced, both resolve -> both show
  let p = per100Pair(withSize, { price: 10, name: 'Baz 1kg' });
  check('per100Pair both resolve: ww shown', p.ww.value, 1);
  check('per100Pair both resolve: coles shown', p.coles.value != null, true);
  // both priced, only one resolves -> BOTH blanked
  p = per100Pair(withSize, noSize);
  check('per100Pair asymmetric: ww blanked', p.ww.value, null);
  check('per100Pair asymmetric: coles blanked', p.coles.value, null);
  check('per100Pair asymmetric: blanked flag set', p.ww.blanked && p.coles.blanked, true);
  // only one store priced -> its value still shows (nothing to compare against)
  p = per100Pair(withSize, null);
  check('per100Pair single store: value kept', p.ww.value, 1);
  check('per100Pair single store: not blanked', !p.ww.blanked, true);
}

// ── exclPriceSet ─────────────────────────────────────────────────────────────
check('mixed key formats',
  [...exclPriceSet(['ww:2.00', 'coles:3.5', 4, '5.1'])].sort(),
  ['2.00', '3.50', '4.00', '5.10']);
check('empty/undefined -> empty set', [...exclPriceSet(undefined)], []);

// ── _median ──────────────────────────────────────────────────────────────────
check('median odd', _median([1, 3, 2]), 2);
check('median even', _median([1, 2, 3, 4]), 2.5);
check('median empty -> null', _median([]), null);

// ── getTrendSeries (exclusion-aware) ─────────────────────────────────────────
{
  const item = {
    list_item: 'X',
    price_history: [{ date: '2026-01-01', price: 2.00 }],
    ww_price_history: [{ date: '2026-02-01', price: 4.00 }],
    coles_price_history: [{ date: '2026-03-01', price: 3.00 }],
    woolworths: { price: 4.00 },
    coles: { price: 3.00 },
  };
  _exclStub = {};
  const noExcl = getTrendSeries(item);
  check('getTrendSeries no exclusions: current', noExcl.current, 3.00);
  check('getTrendSeries no exclusions: prices sorted', [...noExcl.prices].sort((a, b) => a - b), [2, 3, 3, 4, 4]);

  _exclStub = { X: ['ww:2.00'] };
  const withExcl = getTrendSeries(item);
  check('getTrendSeries excludes the $2 history point', withExcl.prices.includes(2), false);
  _exclStub = {};
}

// ── getDealQuality (exclusion must actually disqualify a fake deal) ──────────
{
  const item = {
    list_item: 'TEST',
    price_history: [
      { date: '2026-01-01', price: 2.00 },
      { date: '2026-02-01', price: 4.00 },
      { date: '2026-03-01', price: 4.00 },
    ],
    woolworths: { price: 2.00 },
    coles: null,
  };
  check('all-time-low deal qualifies', getDealQuality(item, {}).qualifies, true);
  check('excluding the low price disqualifies it',
    getDealQuality(item, { TEST: ['ww:2.00'] }).qualifies, false);
  check('archived item never qualifies',
    getDealQuality({ ...item, archived: true }, {}).qualifies, false);
}

// ── calcTrendPosition ─────────────────────────────────────────────────────────
{
  const flat = { price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-01-02', price: 5 }], woolworths: { price: 5 } };
  check('flat history -> 0.5', calcTrendPosition(flat), 0.5);
  const atLow = { price_history: [{ date: '2026-01-01', price: 1 }, { date: '2026-01-02', price: 5 }], woolworths: { price: 1 } };
  check('at all-time low -> 0', calcTrendPosition(atLow), 0);
  const noHist = { price_history: [], woolworths: { price: 5 } };
  check('insufficient history -> 999 (sorts last)', calcTrendPosition(noHist), 999);
}

// ── variantGroupItemNames (per-kg membership override resolution) ────────────
{
  const g = { key: 'k', items: ['A', 'B', 'C'] };
  check('no override -> seed verbatim', variantGroupItemNames(g, {}), ['A', 'B', 'C']);
  check('legacy v1 items = pure adds', variantGroupItemNames(g, { k: { items: ['A', 'B', 'C', 'X'] } }), ['A', 'B', 'C', 'X']);
  check('v2 remove drops a seed member', variantGroupItemNames(g, { k: { v: 2, remove: ['B'] } }), ['A', 'C']);
  check('v2 add + remove together', variantGroupItemNames(g, { k: { v: 2, add: ['X'], remove: ['A'] } }), ['B', 'C', 'X']);
}

// ── variantGroupOf / settingsKeyFor ─────────────────────────────────────────
// A product added to a category belongs to it in every sense, so its frequency,
// category and watchlist state resolve against the CATEGORY key, not its own
// name. These two functions are what every such lookup goes through, and the
// index they cache has to notice a membership change - that cache is the part
// most likely to break silently.
{
  const MEMBER = 'Woolworths Frozen Basa Fillets 1kg';   // seed member of basa_fillets
  const LOOSE  = 'Some Unrelated Product 500g';

  _lsStore = {};   // no membership overrides
  check('seed member resolves to its category', variantGroupOf(MEMBER).key, 'basa_fillets');
  check('non-member resolves to null',          variantGroupOf(LOOSE), null);
  check('member settings key = category key',   settingsKeyFor(MEMBER), '__group_basa_fillets');
  check('loose item keeps its own key',         settingsKeyFor(LOOSE), LOOSE);
  // A category key passed back in must not be re-resolved into another category.
  check('category key is not a member',    variantGroupOf('__group_basa_fillets'), null);
  check('category key maps to itself',     settingsKeyFor('__group_basa_fillets'), '__group_basa_fillets');
  check('empty name is safe',              variantGroupOf(''), null);

  // Adding a product to a category through Edit category must take effect at
  // once - the cached index is keyed on the override string for exactly this.
  _lsStore['pw_perkg_cats_v1'] = JSON.stringify({ basa_fillets: { v: 2, add: [LOOSE] } });
  check('added member resolves immediately', variantGroupOf(LOOSE).key, 'basa_fillets');
  check('added member inherits the key',     settingsKeyFor(LOOSE), '__group_basa_fillets');

  // ...and removing it must too, rather than serving a stale index.
  _lsStore['pw_perkg_cats_v1'] = JSON.stringify({ basa_fillets: { v: 2, remove: [MEMBER] } });
  check('removed member drops out at once',  variantGroupOf(MEMBER), null);
  check('removed member gets its own key',   settingsKeyFor(MEMBER), MEMBER);
  check('the add is gone with its override', variantGroupOf(LOOSE), null);

  _lsStore = {};
  check('clearing overrides restores seed',  variantGroupOf(MEMBER).key, 'basa_fillets');
}

// ── buildDealGroups (cheapest $/kg per store, other groups skipped) ──────────
{
  // Two real basa_fillets seed members, priced so WW is cheaper per kg.
  const items = [
    { list_item: 'Woolworths Frozen Basa Fillets 1kg', woolworths: { price: 7.20, name: 'WW Basa 1kg', url: 'u1' }, coles: null, price_history: [], ww_price_history: [{ date: '2026-01-01', price: 9.00 }], coles_price_history: [] },
    { list_item: 'Coles Frozen Basa Fillet',           woolworths: null, coles: { price: 10.00, name: 'Coles Basa 1kg', url: 'u2' }, price_history: [], ww_price_history: [], coles_price_history: [{ date: '2026-01-01', price: 12.00 }] },
  ];
  const groups = buildDealGroups(items);
  const basa = groups.find(g => g.list_item === '__group_basa_fillets');
  check('one basa group built', !!basa, true);
  check('basa marked as group', basa._isGroup, true);
  check('basa WW = cheapest member $/kg', basa.woolworths.price, 7.20);   // 7.20 / 1kg
  check('basa Coles = cheapest member $/kg', basa.coles.price, 10.00);    // 10.00 / 1kg
  check('WW history converted to $/kg', basa.ww_price_history.map(p => p.price), [9.00]);
  check('groups with no priced members are skipped', groups.some(g => g.list_item === '__group_lamb_mince'), false);
}

// ── perKgEquivBundle (equivalent-quantity bundling for unit-based groups) ────
{
  // 1kg @ $4.20/kg vs 2kg @ $4.20/kg: 2 × WW 1kg matches 1 × Coles 2kg, equal.
  const yog = perKgEquivBundle({ price: 4.20, perKg: 4.20 }, { price: 8.40, perKg: 4.20 });
  check('yoghurt WW scaled to 2 packs', yog.ww.packs, 2);
  check('yoghurt WW total = 2×4.20', yog.ww.total, 8.40);
  check('yoghurt Coles stays 1 pack', yog.coles.packs, 1);
  check('yoghurt Coles total unchanged', yog.coles.total, 8.40);
  check('equal total -> equal', yog.cheaper, 'equal');

  // Same sizes (1kg each): no scaling, cheaper by real price.
  const same = perKgEquivBundle({ price: 4.20, perKg: 4.20 }, { price: 4.50, perKg: 4.50 });
  check('same-size no scaling ww', same.ww.packs, 1);
  check('same-size no scaling coles', same.coles.packs, 1);
  check('same-size cheaper = ww', same.cheaper, 'woolworths');

  // 4kg vs 1kg: Coles buys 4 packs to reach 4kg. WW $4/kg beats Coles $5/kg.
  const potato = perKgEquivBundle({ price: 16.00, perKg: 4.00 }, { price: 5.00, perKg: 5.00 });
  check('potato Coles scaled to 4 packs', potato.coles.packs, 4);
  check('potato Coles total = 4×5', potato.coles.total, 20.00);
  check('potato WW stays 1 pack', potato.ww.packs, 1);
  check('potato cheaper = ww', potato.cheaper, 'woolworths');

  // Off-multiple (0.75kg vs 1kg): can't align in whole packs -> 1:1, no scaling.
  const odd = perKgEquivBundle({ price: 6.00, perKg: 8.00 }, { price: 7.00, perKg: 7.00 });
  check('off-multiple ww no scaling', odd.ww.packs, 1);
  check('off-multiple coles no scaling', odd.coles.packs, 1);

  // Single store: returned as-is, that store is "cheaper".
  const solo = perKgEquivBundle({ price: 5.00, perKg: 5.00 }, null);
  check('single store packs = 1', solo.ww.packs, 1);
  check('single store coles null', solo.coles, null);
  check('single store cheaper = ww', solo.cheaper, 'woolworths');
}

// ── groupMetric (sticker groups compare by pack price, else $/kg) ────────────
check('groupMetric $/kg default', groupMetric({}, { price: 5, name: 'Foo 500g' }), 10); // $5/500g = $10/kg
check('groupMetric sticker = pack price', groupMetric({ sticker: true }, { price: 4.6, name: 'Dolmio 500g' }), 4.6);
check('groupMetric null result', groupMetric({ sticker: true }, null), null);

// ── pendingValidationCount (Validate pill, resolved-suppression + self-prune) ─
{
  const pending = [{ item: 'A' }, { item: 'B' }, { item: 'C' }];
  _lsStore = {};
  check('no resolved -> full count', pendingValidationCount(pending), 3);
  _lsStore = { pw_pv_resolved_v1: JSON.stringify(['B']) };
  check('one resolved (still lagging) suppressed', pendingValidationCount(pending), 2);
  // B still present so it stays tracked
  check('resolved kept while still pending', JSON.parse(_lsStore.pw_pv_resolved_v1), ['B']);
  // Pages caught up: B gone from pending -> pruned from the set, count unaffected
  _lsStore = { pw_pv_resolved_v1: JSON.stringify(['B']) };
  check('pruned when fresh data drops it', pendingValidationCount([{ item: 'A' }, { item: 'C' }]), 2);
  check('resolved set self-pruned', JSON.parse(_lsStore.pw_pv_resolved_v1), []);
  check('empty pending -> 0', pendingValidationCount(undefined), 0);
}

// ── multiBuyCost / multiBuyNudge ────────────────────────────────────────────
// Mirrors scripts/multibuy_selfcheck.py - the same numbers must come out of the
// Python (scraper) and JS (basket) sides or a basket total silently disagrees
// with what the register charges.
{
  const DIPS = { qty: 2, total: 7 };   // WW Chris' Dips: 2 for $7, shelf $4.50
  check('mb: below threshold pays shelf', multiBuyCost(1, 4.5, DIPS), 4.5);
  check('mb: exactly one block',          multiBuyCost(2, 4.5, DIPS), 7);
  check('mb: block + remainder',          multiBuyCost(3, 4.5, DIPS), 11.5);
  check('mb: two whole blocks',           multiBuyCost(4, 4.5, DIPS), 14);
  check('mb: no promo multiplies',        multiBuyCost(3, 4.5, null), 13.5);
  check('mb: zero qty',                   multiBuyCost(0, 4.5, DIPS), 0);
  // A dearer-than-shelf "deal" is still what the store charges - report reality.
  check('mb: worse promo still applied',  multiBuyCost(2, 5, { qty: 2, total: 12 }), 12);

  check('nudge: 1 short of the deal', multiBuyNudge(1, 4.5, DIPS), { need: 1, saving: 2 });
  check('nudge: already on a block',  multiBuyNudge(2, 4.5, DIPS), null);
  check('nudge: 3 -> 1 more',         multiBuyNudge(3, 4.5, DIPS), { need: 1, saving: 2 });
  check('nudge: no promo',            multiBuyNudge(1, 4.5, null), null);
  // A promo that saves nothing must not nag the shopper.
  check('nudge: pointless promo stays quiet', multiBuyNudge(1, 3, { qty: 2, total: 6 }), null);
}

// ── Trend: a multi-buy must be able to beat the all-time low ────────────────
// Two separate faults made the "below everything ever seen" marker unreachable:
// the current point was the SHELF price (so a promo never counted), and the
// series the bar was drawn against already contained that current price (so it
// could never fall outside its own range). Both are pinned here.
{
  check('mbUnitPrice: no promo -> shelf price', mbUnitPrice({ price: 4.5 }), 4.5);
  check('mbUnitPrice: live promo rate wins', mbUnitPrice({ price: 4.5, multi_buy: { qty: 2, total: 7 } }, 2), 3.5);
  // "2 for $12" on a $5 item is dearer per unit - multiBuyCost still charges it
  // (that is what the register does), so the shelf price is not silently kept.
  check('mbUnitPrice: dearer promo still charged', mbUnitPrice({ price: 5, multi_buy: { qty: 2, total: 12 } }, 2), 6);
  check('mbUnitPrice: unpriced store -> null', mbUnitPrice({ price: null }), null);
  check('mbUnitPrice: missing store -> null',  mbUnitPrice(null), null);

  // Shelf $4.50, never seen below $4.50, but "2 for $7" = $3.50 each.
  const promoItem = {
    list_item: 'X',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: { price: 4.5, multi_buy: { qty: 2, total: 7 } },
    coles: null,
  };
  // Qty 2 = the deal quantity, so the promo is genuinely live here.
  const t = getTrendSeries(promoItem, 2);
  check('trend current follows a LIVE promo', t.current, 3.5);
  // THE REGRESSION: `past` is history only. If the current price leaks in here,
  // min(past) becomes 3.5 and the marker can never sit left of the bar.
  check('trend past excludes current', Math.min(...t.past), 4.5);
  check('trend past is history only',  t.past.length, 2);
  assert.ok(t.current < Math.min(...t.past),
    'a promo below every historical price must read as off-range');
  n += 1;

  // Without a promo the current price sits inside the historical range, so the
  // bar draws normally - the off-range marker must not fire for everyone.
  const plain = { ...promoItem, woolworths: { price: 4.8 } };
  const t2 = getTrendSeries(plain, 1);
  assert.ok(t2.current >= Math.min(...t2.past), 'a normal price is not off-range');
  n += 1;
}

// ── buildPriceBar: off-range marker + optional History button ───────────────
{
  const hist = [{ price: 4.5 }, { price: 5 }, { price: 6 }];
  // Below every historical price -> the off-range marker, NOT a clamped bar.
  const off = buildPriceBar('X', hist, 3.5);
  assert.ok(/price-marker-off-left/.test(off), 'below-history must draw the off-left marker');
  assert.ok(!/price-marker" style/.test(off), 'off-range must not also draw an in-range marker');
  n += 2;
  // Above every historical price -> the right-hand off-range marker.
  assert.ok(/price-marker-off-right/.test(buildPriceBar('X', hist, 9)),
    'above-history must draw the off-right marker');
  n += 1;
  // In range -> an ordinary positioned marker, no off-range markers.
  const mid = buildPriceBar('X', hist, 5);
  assert.ok(/price-marker" style/.test(mid) && !/off-left|off-right/.test(mid),
    'an in-range price draws a normal marker');
  n += 1;
  // The History button is opt-out for pages with no history modal - a button
  // that does nothing is worse than no button.
  assert.ok(/price-bar-manage/.test(buildPriceBar('X', hist, 5)), 'History button on by default');
  assert.ok(!/price-bar-manage/.test(buildPriceBar('X', hist, 5, 1, false)), 'History button suppressible');
  n += 2;
  // Too little history to place anything -> no bar at all.
  check('single history point -> no bar', buildPriceBar('X', [{ price: 4 }], 4), '');
}

// ── A deal you haven't qualified for is not a price you can pay ─────────────
{
  const DEAL = { price: 4.5, multi_buy: { qty: 2, total: 7 } };
  check('mbUnitPrice: below deal qty -> shelf price', mbUnitPrice(DEAL, 1), 4.5);
  check('mbUnitPrice: at deal qty -> promo rate',     mbUnitPrice(DEAL, 2), 3.5);
  // 3 units of "2 for $7" at $4.50 = $7 + $4.50 = $11.50 -> $3.83 each. Must
  // match the price column exactly, which is why it uses multiBuyCost.
  check('mbUnitPrice: partial block averages out',
        +mbUnitPrice(DEAL, 3).toFixed(2), 3.83);

  const item = {
    list_item: 'Y',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: DEAL, coles: null,
  };
  // At Qty 1 the deal is dormant: the marker must sit at the shelf price, NOT
  // claim an all-time low the shopper cannot actually buy.
  assert.ok(getTrendSeries(item, 1).current >= Math.min(...getTrendSeries(item, 1).past),
    'a dormant deal must not read as off-range');
  assert.ok(getTrendSeries(item, 2).current < Math.min(...getTrendSeries(item, 2).past),
    'a live deal below every historical price must read as off-range');
  n += 2;

  // Off-range sorts AHEAD of an item merely sitting at its own historical low.
  const atLow = {
    list_item: 'Z',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: { price: 4.5 }, coles: null,
  };
  const pOff = calcTrendPosition(item, 2);
  const pLow = calcTrendPosition(atLow, 1);
  check('at historical low scores 0', pLow, 0);
  assert.ok(pOff < 0, `off-range must score below 0 (got ${pOff})`);
  assert.ok(pOff < pLow, 'off-range must sort ahead of at-its-low');
  n += 2;

  // Dormant deal ranks the same as no deal at all.
  check('dormant deal ranks as its shelf price', calcTrendPosition(item, 1), 0);
}

// ── Off-chart sorts to the EXTREMES, both directions ────────────────────────
// Both ends were clamped, so "below everything ever seen" scored the same as
// "at its own low" (0) and "above everything" the same as "at its own high" (1).
// Trend sort therefore scattered off-chart rows among ordinary ones.
{
  const hist = [{ date: '2026-01-01', price: 4 }, { date: '2026-02-01', price: 6 }];
  const mk = (p) => ({ list_item: 'T', price_history: hist, woolworths: { price: p }, coles: null });
  const below = calcTrendPosition(mk(3));    // under the $4 low
  const atLow = calcTrendPosition(mk(4));
  const atHigh = calcTrendPosition(mk(6));
  const above = calcTrendPosition(mk(7));    // over the $6 high
  check('at historical low = 0', atLow, 0);
  check('at historical high = 1', atHigh, 1);
  assert.ok(below < atLow, 'below-everything must sort ahead of at-its-low');
  assert.ok(above > atHigh, 'above-everything must sort behind at-its-high');
  n += 2;

  // Dill Fresh / Parsley: ONE price ever recorded ($3.20), now $3.30. That is
  // off the top, not mid-range - it used to score 0.5 and land in the middle of
  // a trend sort.
  const flat = (p) => ({
    list_item: 'F',
    price_history: [{ date: '2026-01-01', price: 3.2 }, { date: '2026-02-01', price: 3.2 }],
    woolworths: { price: p }, coles: null,
  });
  assert.ok(calcTrendPosition(flat(3.3)) > 1, 'flat history, dearer now = off the top');
  assert.ok(calcTrendPosition(flat(3.0)) < 0, 'flat history, cheaper now = off the bottom');
  check('flat history, unchanged = middle', calcTrendPosition(flat(3.2)), 0.5);
  n += 2;
}

// ── Hot Deals must see multi-buy all-time lows ──────────────────────────────
{
  const base = {
    list_item: 'Nut Bar',
    price_history: [
      { date: '2026-01-01', price: 5 },
      { date: '2026-02-01', price: 5 },
      { date: '2026-03-01', price: 4.5 },
    ],
    coles: null,
  };
  // Shelf $5 is NOT a deal - it is the usual price.
  check('shelf price at its usual = no deal',
        getDealQuality({ ...base, woolworths: { price: 5 } }, {}).qualifies, false);
  // Same shelf price, but "2 for $6" = $3 each, under the $4.50 all-time low.
  // This is the case that never reached Hot Deals.
  const promo = getDealQuality(
    { ...base, woolworths: { price: 5, multi_buy: { qty: 2, total: 6 } } }, {});
  check('multi-buy all-time low qualifies', promo.qualifies, true);
  check('multi-buy low is flagged all-time-low', promo.isAllTimeLow, true);
}

// ── scalePer100: the $/100g must follow the price above it ──────────────────
// Card view shows the multi-buy price; a $/100g still figured off the shelf
// ticket sat directly under a lower headline and contradicted it.
{
  const p = { value: 1.89, label: '100g' };
  check('no deal live leaves the measure alone', scalePer100(p, 8.5, 8.5).value, 1.89);
  // "2 for $15" on an $8.50 pack = $7.50 each, so $/100g drops in the same ratio.
  check('measure follows the effective price',
        +scalePer100(p, 8.5, 7.5).value.toFixed(4), +(1.89 * 7.5 / 8.5).toFixed(4));
  check('label is preserved', scalePer100(p, 8.5, 7.5).label, '100g');
  check('input is not mutated', p.value, 1.89);
  // Pass-throughs: nothing to scale, no shelf price, or no effective price.
  check('null measure passes through', scalePer100(null, 8.5, 7.5), null);
  check('blanked measure passes through',
        scalePer100({ value: null, blanked: true }, 8.5, 7.5).blanked, true);
  check('zero shelf price cannot divide', scalePer100(p, 0, 7.5).value, 1.89);
  check('null effective price passes through', scalePer100(p, 8.5, null).value, 1.89);
}

// ── fmt: grouped thousands, everywhere ──────────────────────────────────────
{
  check('under a thousand is unchanged', fmt(66.62), '$66.62');
  check('thousands are grouped', fmt(1059.16), '$1,059.16');
  check('millions group too', fmt(1234567.5), '$1,234,567.50');
  check('always two decimals', fmt(8), '$8.00');
  check('null renders as a dash', fmt(null), '-');
  check('non-numeric renders as a dash', fmt('abc'), '-');
  check('zero is a price, not a blank', fmt(0), '$0.00');
}

// ── sameQtyCost: compare equal amounts, not equal packs ─────────────────────
// The salmon case: WW sells a $34 pack at $3.40/100g, Coles a $10 portion at
// $5.00/100g. On pack price Coles looks $24 cheaper; per quantity it is dearer.
{
  const s = sameQtyCost(34, 10, 3.4, 5.0);
  check('rival restated to the WW quantity', s.co, 50);
  check('WW side is left alone', s.ww, 34);
  check('flagged as normalised', s.normalised, true);
  check('the comparison INVERTS vs pack price', s.co > s.ww, true);
  // Equal pack sizes: normalising must be an identity, so it can run always.
  const eq = sameQtyCost(8.5, 9.0, 1.7, 1.8);
  check('equal sizes leave the rival untouched', eq.co, 9);
  // No rate at one store → fall back to pack prices and say so.
  const fb = sameQtyCost(5, 6, null, 1.2);
  check('falls back to pack price', fb.co, 6);
  check('fallback is flagged', fb.normalised, false);
  check('missing a price yields null', sameQtyCost(null, 6, 1, 1), null);
}

console.log(`utils_selfcheck: all ${n} cases passed`);
