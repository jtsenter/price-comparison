// Self-check for the Hot Deals signal: percentile, cheapest-ever, staleness gate.
// Run: node scripts/deal_signal_selfcheck.js
//
// The bug this guards against was silent and cost the page its meaning: the
// scrape writes today's price into the history that today's price is compared
// against, so "cheapest ever" fired whenever today merely TIED the old minimum.
// On the real data that was 112 of 252 items. Every assertion here is about
// keeping the comparison honest.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
function extractConst(name) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*[^;]+;'));
  assert(m, `const ${name} not found`);
  return m[0].replace(/^const\s+/, 'globalThis.');
}

global.loadExclusions = () => ({});
// eslint-disable-next-line no-eval
eval([
  extractConst('DEAL_MIN_SPREAD'), extractConst('DEAL_MIN_DROP'),
  extractConst('HD_STALE_MONTHS'), extractConst('DEAL_TUNE_DEFAULTS'),
  extractConst('BWS_SIZE_TOL'),
  extract('_median'), extract('exclPriceSet'), extract('mbUnitPrice'),
  extract('promoUnitPrice'), extract('clientPer100'), extract('per100Pair'),
  extract('sameQtyCost'), extract('bwsComparable'),
  extract('getDealQuality'), extract('dealPassesTune'),
].join('\n'));

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// price series -> item. Prices land in ww_price_history; today's scrape is BOTH
// the live woolworths price and the newest history row, exactly as the real
// pipeline writes it.
function mk(series, current) {
  return {
    list_item: 'X',
    woolworths: { price: current, name: 'X' },
    coles: null,
    price_history: [],
    ww_price_history: series.map(([d, p]) => ({ date: d, price: p })),
    coles_price_history: [],
  };
}

// 1. A price that has never moved is NOT "cheapest ever", however many times we
//    have written it down. This is the exact 112-item bug.
const flat = mk([[daysAgo(300), 5], [daysAgo(200), 5], [daysAgo(100), 5], [TODAY, 5]], 5);
const dFlat = getDealQuality(flat, {});
assert.strictEqual(dFlat.isAllTimeLow, false, 'a never-moving price must not be "cheapest ever"');

// 2. Today's price is excluded from its own comparison. Tying the old minimum is
//    not a new low; beating it is.
const tie = mk([[daysAgo(200), 4], [daysAgo(100), 6], [TODAY, 4]], 4);
assert.strictEqual(getDealQuality(tie, {}).isAllTimeLow, false, 'tying the old low is not a new low');
const beat = mk([[daysAgo(200), 4], [daysAgo(100), 6], [TODAY, 3.5]], 3.5);
assert.strictEqual(getDealQuality(beat, {}).isAllTimeLow, true, 'beating the old low IS a new low');

// 3. Percentile ranks today against the past, and never counts today itself.
const ranked = mk([[daysAgo(50), 10], [daysAgo(40), 9], [daysAgo(30), 8], [daysAgo(20), 7], [TODAY, 6]], 6);
const dR = getDealQuality(ranked, {});
assert.strictEqual(dR.pricePercentile, 1, 'cheaper than all 4 past prices -> 1.0');
const mid = mk([[daysAgo(50), 10], [daysAgo(40), 4], [daysAgo(30), 8], [daysAgo(20), 2], [TODAY, 6]], 6);
assert.strictEqual(getDealQuality(mid, {}).pricePercentile, 0.5, '2 of 4 past prices dearer -> 0.5');

// 4. monthsSinceChange measures the last CHANGE, not the last check. An item
//    checked daily but frozen for a year must read as a year, or the staleness
//    gate would never fire on precisely the items it exists for.
const frozen = mk([[daysAgo(400), 3], [daysAgo(200), 3], [daysAgo(2), 3], [TODAY, 3]], 3);
assert.strictEqual(getDealQuality(frozen, {}).monthsSinceChange, Infinity,
  'a price that never changed across all history is infinitely stale');
const moved = mk([[daysAgo(400), 3], [daysAgo(20), 4], [TODAY, 4]], 4);
const mo = getDealQuality(moved, {}).monthsSinceChange;
assert(mo > 0.4 && mo < 1.2, `changed ~20 days ago should be ~0.7 months, got ${mo}`);

// 5. The staleness gate outranks the cheapest-ever escape hatch. A frozen price
//    is not news at ANY threshold - that is the whole point of the gate, and
//    letting ATL through would have re-admitted the rows we just removed.
const stale = { ...globalThis.DEAL_TUNE_DEFAULTS, stale: 6 };
assert.strictEqual(
  dealPassesTune({ typical: 5, spread: 0.5, notAboveRecent: true, dropPct: 0.9,
                   savingPct: 0.9, pricePercentile: 1, isAllTimeLow: true,
                   monthsSinceChange: 24 }, stale),
  false, 'staleness gate must beat the cheapest-ever escape hatch');
// ...and 0 disables the gate entirely.
assert.strictEqual(
  dealPassesTune({ typical: 5, spread: 0.5, notAboveRecent: true, dropPct: 0.9,
                   savingPct: 0.9, pricePercentile: 1, isAllTimeLow: true,
                   monthsSinceChange: 24 }, { ...stale, stale: 0 }),
  true, 'stale:0 must disable the gate');

// 6. An item that swings on a cycle stays eligible while it sits between swings.
//    This is the case the user called out: an 8-week cycle is not "stale".
const cyclic = mk([[daysAgo(300), 9], [daysAgo(240), 6], [daysAgo(180), 9],
                   [daysAgo(120), 6], [daysAgo(60), 9], [TODAY, 9]], 9);
const dC = getDealQuality(cyclic, {});
assert(dC.monthsSinceChange < 3, `a 2-month cycle must read as fresh, got ${dC.monthsSinceChange}`);
assert.strictEqual(dealPassesTune({ ...dC, dropPct: 0.9, savingPct: 0.9, pricePercentile: 1 }, stale),
  true, 'a cyclic item must survive the staleness gate');

// 7. Saved tunes from before these fields fall back to the DEFAULTS, not to 0 -
//    otherwise every existing device silently keeps the old broken behaviour.
const D = globalThis.DEAL_TUNE_DEFAULTS;
assert(D.stale > 0, 'default staleness gate must be on');
assert(D.rank > 0, 'default percentile floor must be on');
//    Cheapest-ever is no longer a checkbox: it always shows, at ANY slider
//    setting, because it is the strongest reason a row belongs on this page.
//    Tightening every slider to its maximum must not hide a genuine new low.
assert(!('atl' in D), 'the atl toggle is gone - it should not reappear in the defaults');
const strictest = { drop: 100, diff: 100, rank: 100, stale: globalThis.HD_STALE_MONTHS, mode: 'and' };
assert.strictEqual(
  dealPassesTune({ typical: 5, spread: 0.5, notAboveRecent: true, dropPct: 0.05,
                   savingPct: 0, pricePercentile: 0.1, isAllTimeLow: true,
                   monthsSinceChange: 1, comparable: true }, strictest),
  true, 'a genuine new low must show even with every slider maxed');

// 8. The salmon trap. Woolworths sells a $38/kg fillet, Coles a $10 portion;
//    min(38, 10) reads as "cheapest ever, save $24" and it is a lie - restated
//    at the same quantity Coles is $50/kg, i.e. dearer. This is the table and
//    the 🔥 badge, not just the Buy/Wait panel: dealPassesTune must refuse it
//    even though it would otherwise pass every slider AND the ATL hatch.
const salmon = {
  list_item: 'Salmon Fillets', category: 'Meat & Seafood',
  woolworths: { price: 38, name: 'Salmon Fillets', unit_price: 38, unit: '1KG' },
  coles:      { price: 10, name: 'Salmon Portion Skin On 200g' },
  price_history: [], coles_price_history: [],
  ww_price_history: [[120, 34], [90, 36], [60, 34], [30, 34], [10, 36], [0, 38]]
    .map(([d, p]) => ({ date: daysAgo(d), price: p })),
};
const dSalmon = getDealQuality(salmon, {});
assert.strictEqual(dSalmon.comparable, false, 'a $10 portion against a $38 kilo is not comparable');
assert.strictEqual(dealPassesTune(dSalmon, { ...D, drop: 0, diff: 0, rank: 0 }), false,
  'a size mismatch must be refused even at the loosest tune, and cheapest-ever must not rescue it');
// Same product, matched sizes: the guard must not fire, or it would silently
// empty the table instead of cleaning it.
const salmonOk = { ...salmon, coles: { price: 34, name: 'Salmon Fillets', unit_price: 34, unit: '1KG' } };
assert.strictEqual(getDealQuality(salmonOk, {}).comparable, true, 'like-for-like pairs must stay eligible');

// 9. Shelf vs promo. Top Deck is $4 at Woolworths and $8 at Coles, but Coles
//    runs "2 for $10", so its promo rate is $5. Deal detection uses the promo
//    rate (a multi-buy beating every recorded price IS a deal), but the Save
//    column sits beside two columns showing $4 and $8 - so the SHELF figures
//    must be carried separately or the row reads "$4 | $8 | save $1".
const topDeck = {
  list_item: 'Top Deck', category: 'Sweets',
  woolworths: { price: 4, name: 'Top Deck Block 180g' },
  coles:      { price: 8, name: 'Top Deck Block 180g', multi_buy: { qty: 2, total: 10 } },
  price_history: [], coles_price_history: [],
  ww_price_history: [[120, 8], [90, 8], [60, 8], [30, 8], [10, 8], [0, 4]]
    .map(([d, p]) => ({ date: daysAgo(d), price: p })),
};
const dTop = getDealQuality(topDeck, {});
assert.strictEqual(dTop.price, 4, 'the deal price is still the best promo-aware price');
assert.strictEqual(dTop.otherPrice, 5, 'the rival at its promo rate is $5');
assert.strictEqual(dTop.shelfPrice, 4, 'shelf price of the winning store');
assert.strictEqual(dTop.otherShelfPrice, 8, 'shelf price of the rival, as the column shows it');
assert.strictEqual(dTop.otherShelfPrice - dTop.shelfPrice, 4,
  'Save must be the gap between the two numbers on screen, i.e. $4');

// 10. A dead heat flies no flag. Snickers at $8 in both stores was showing a red
//     Coles chip purely because the tie-break picks Coles, which reads as a
//     claim that Coles is cheaper.
const level = {
  list_item: 'Snickers', category: 'Sweets',
  woolworths: { price: 8, name: 'Snickers Share Bag 300g' },
  coles:      { price: 8, name: 'Snickers Share Bag 300g' },
  price_history: [], coles_price_history: [],
  ww_price_history: [[120, 7.5], [90, 7], [60, 7.5], [30, 8], [10, 8], [0, 8]]
    .map(([d, p]) => ({ date: daysAgo(d), price: p })),
};
assert.strictEqual(getDealQuality(level, {}).tied, true, 'equal prices must report as tied');
assert.strictEqual(dTop.tied, false, 'unequal prices must not report as tied');

// 11. Real data: the badge must be rare. If a change ever makes it common again,
//    this fails loudly rather than quietly restoring the wallpaper.
const items = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'data', 'latest.json'), 'utf8')).items;
const scored = items.map(i => getDealQuality(i, {})).filter(d => d.typical != null);
const atl = scored.filter(d => d.isAllTimeLow).length;
const naiveAtl = scored.filter(d => d.price <= d.lo + 0.01).length;
assert(atl / scored.length < 0.10,
  `"cheapest ever" fires on ${atl}/${scored.length} - it is meant to be rare`);
assert(naiveAtl > atl * 3,
  'sanity: the naive comparison should be far looser than the fixed one');
const passing = scored.filter(d => dealPassesTune(d, D)).length;
assert(passing > 3 && passing < 60,
  `${passing} deals at default tune - should be a usable page, not 1 and not 60`);
const mismatched = scored.filter(d => d.comparable === false).length;
assert(scored.filter(d => d.comparable === false && dealPassesTune(d, D)).length === 0,
  'a size-mismatched item must never pass the tune, on real data or otherwise');

console.log(`deal_signal_selfcheck: 12/12 OK  (cheapest-ever ${atl}/${scored.length}, `
  + `was ${naiveAtl}; ${passing} deals at defaults; ${mismatched} size-mismatched pairs excluded)`);
