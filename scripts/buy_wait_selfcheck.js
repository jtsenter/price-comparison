// Self-check for the Buy / Wait / Stock up panel.
// Run: node scripts/buy_wait_selfcheck.js
//
// This panel gives instructions, not observations - "stock up", "wait" - so a
// wrong card costs real money and trust. The assertions below are all about the
// three ways it could lie: advising a stock-up on something that rots, advising
// a wait with no cheaper price to wait FOR, and letting one staple own the panel.
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

// eslint-disable-next-line no-eval
eval([
  extractConst('DEAL_MIN_SPREAD'), extractConst('DEAL_MIN_DROP'),
  extractConst('HD_STALE_MONTHS'), extractConst('DEAL_TUNE_DEFAULTS'),
  extractConst('CATEGORY_REMAP'),
  extractConst('BWS_MAX_CARDS'),
  extractConst('BWS_MIN_HISTORY'), extractConst('BWS_STOCK_RANK'),
  extractConst('BWS_MIN_STAKE'),
  extractConst('BWS_SIZE_TOL'), extractConst('BWS_MIN_RATIO'), extractConst('BWS_KEEPS'),
  extract('_median'), extract('exclPriceSet'), extract('mbUnitPrice'),
  extract('promoUnitPrice'), extract('fmt'), extract('normalizeCategory'),
  extract('clientPer100'), extract('per100Pair'), extract('sameQtyCost'),
  extract('getDealQuality'), extract('dealPassesTune'),
  extract('bwsSeries'), extract('bwsComparable'), extract('bwsAgo'),
  extractConst('BWS_ELSE_MIN_PCT'), extractConst('THIRD_STORES'),
  extract('bwsVerdict'), extract('buyWaitCards'), extract('thirdStoreCards'),
].join('\n'));

globalThis.loadDealTune = () => ({ ...globalThis.DEAL_TUNE_DEFAULTS });
const TUNE = globalThis.DEAL_TUNE_DEFAULTS;
// Must be the REAL today, not a frozen date. getDealQuality() reads the wall
// clock internally (`new Date().toISOString().slice(0,10)`) and takes no `today`
// argument, so a hardcoded date here silently drifts out of agreement with it:
// once the real date passed the frozen one, the synthetic "today's price" row
// below counted as PAST history, which moved pricePercentile from 1.0 to 0.83,
// under BWS_STOCK_RANK, and case 1 started failing on a green tree. Deriving
// every date in this file from the real today keeps the two in step for good.
const TODAY = new Date().toISOString().slice(0, 10);
const ago = (n) => new Date(Date.parse(TODAY) - n * 86400000).toISOString().slice(0, 10);

// A history of [daysAgo, price] pairs plus today's shelf price, written the way
// the real pipeline writes it (today's scrape is also the newest history row).
function mk(name, category, series, current, trips = 3) {
  return {
    list_item: name, category, trip_count: trips,
    woolworths: { price: current, name },
    coles: null,
    price_history: [],
    ww_price_history: series.map(([d, p]) => ({ date: ago(d), price: p })),
    coles_price_history: [],
  };
}
const card = (item) => buyWaitCards([item], { tune: TUNE, today: TODAY })[0] || null;

// 1. Stock up: at its floor, and it keeps.
const pantryLow = mk('Rice 1kg', 'Pantry',
  [[120, 4], [90, 4.5], [60, 4], [30, 4.5], [10, 4.2], [0, 3]], 3);
const c1 = card(pantryLow);
assert(c1 && c1.verdict === 'stock', `a pantry item at its floor is a stock-up, got ${c1 && c1.verdict}`);

// 2. The SAME price behaviour on something perishable must never say "stock up".
//    This is the assertion that keeps the panel honest: the only difference is
//    the category, and lettuce does not keep for a month.
const vegLow = mk('Lettuce', 'Fruit & Veg',
  [[120, 4], [90, 4.5], [60, 4], [30, 4.5], [10, 4.2], [0, 3]], 3);
const c2 = card(vegLow);
assert(!c2 || c2.verdict !== 'stock', 'perishables must never be a stock-up');

// 3. There is no WAIT verdict any more. This panel answers "what do I go for",
//    so a card telling you to do nothing is a slot wasted. An item that is dear
//    against its own past - the exact case that used to produce one - must now
//    produce no card at all rather than a hidden one.
const dear = mk('Coffee 500g', 'Pantry',
  [[100, 12], [80, 12], [60, 9], [40, 12], [20, 12], [0, 14]], 14);
const c3 = card(dear);
assert(!c3, `a dear item must yield no card, got ${c3 && c3.verdict}`);

// 4. Same for one that has never been cheaper: still nothing.
const alwaysDear = mk('Saffron', 'Pantry',
  [[100, 12], [80, 12.2], [60, 12], [40, 12.1], [20, 12], [0, 13]], 13);
assert(!card(alwaysDear), 'nothing to act on means no card');

// 5. Too little history = no verdict. Four prices is an anecdote.
const thin = mk('New Thing', 'Pantry', [[30, 5], [20, 5], [10, 5], [0, 3]], 3);
assert.strictEqual(card(thin), null, 'under BWS_MIN_HISTORY dates there is no verdict');

// 6. Trivial stakes are filtered out before they reach a card.
const pennies = mk('Cheap Thing', 'Pantry',
  [[120, 1.2], [90, 1.3], [60, 1.2], [30, 1.3], [10, 1.25], [0, 1.05]], 1.05);
const c6 = card(pennies);
assert(!c6, `a 20c move is not advice, got ${c6 && c6.verdict}`);

// 7. Ranking is stake x frequency, not stake alone. The weekly 60c saving must
//    outrank the one-off $2 saving, which is the whole reason score exists.
const often = mk('Milk-ish', 'Pantry',
  [[120, 3], [90, 3], [60, 3], [30, 3], [10, 3], [0, 2.4]], 2.4, 30);
const rare  = mk('Rare Thing', 'Pantry',
  [[120, 12], [90, 12], [60, 12], [30, 12], [10, 12], [0, 10]], 10, 0);
const ranked = buyWaitCards([rare, often], { tune: TUNE, today: TODAY });
assert.strictEqual(ranked[0].item.list_item, 'Milk-ish',
  'the thing bought 30 times must outrank the thing bought never');

// 8. The cap holds, and it is a CAP not a quota: sixteen candidates must not
//    fill the panel past BWS_MAX_CARDS, and eight dear items must contribute
//    nothing at all.
const manyDear = Array.from({ length: 8 }, (_, k) =>
  mk('Dear ' + k, 'Pantry', [[100, 12], [80, 12], [60, 9], [40, 12], [20, 12], [0, 14 + k]], 14 + k));
const manyBuys = Array.from({ length: 8 }, (_, k) =>
  mk('Low ' + k, 'Pantry', [[120, 10], [90, 11], [60, 10], [30, 11], [10, 10.5], [0, 6]], 6));
const all = buyWaitCards([...manyDear, ...manyBuys], { tune: TUNE, today: TODAY });
assert(all.length <= globalThis.BWS_MAX_CARDS, `${all.length} cards exceeds the cap`);
assert(!all.some(c => c.verdict === 'wait'), 'the wait verdict is gone, not merely capped');
assert(all.every(c => c.verdict === 'stock' || c.verdict === 'buy'),
  'every card must be something to act on');
// ...and stock-ups lead the buys.
const orders = all.map(c => c.order);
assert.deepStrictEqual(orders, [...orders].sort((a, b) => a - b), 'stock-ups must sort first');

// 8b. Every card carries the size of its discount as a number, not just prose -
//     that is the thing the panel is read for.
for (const c of all) {
  assert(Number.isFinite(c.offPct) && c.offPct > 0, `card has no usable offPct: ${c.offPct}`);
  assert(c.usual > c.price, 'the struck-through "was" must be dearer than now');
}

// 9. Archived and priority-archived items never reach a card.
assert.strictEqual(
  buyWaitCards([pantryLow], { tune: TUNE, today: TODAY, archivedSet: new Set(['Rice 1kg']) }).length,
  0, 'archived items must not be advised on');
assert.strictEqual(
  buyWaitCards([pantryLow], { tune: TUNE, today: TODAY, priorities: { 'Rice 1kg': 'archive' } }).length,
  0, 'priority-archived items must not be advised on');

// 10. The salmon trap, from real data: Woolworths sells a $38/kg fillet, Coles a
//     $10 portion. min(38, 10) says "cheapest ever, save $24" and it is a lie -
//     restated at the same quantity Coles is $50/kg, i.e. DEARER. Any card here
//     would be advice to buy the expensive one.
const salmon = {
  list_item: 'Salmon Fillets', category: 'Meat & Seafood', trip_count: 7,
  woolworths: { price: 38, name: 'Salmon Fillets', unit_price: 38, unit: '1KG' },
  coles:      { price: 10, name: 'Salmon Portion Skin On 200g' },
  price_history: [], coles_price_history: [],
  ww_price_history: [[120, 34], [90, 36], [60, 34], [30, 34], [10, 36], [0, 38]]
    .map(([d, p]) => ({ date: ago(d), price: p })),
};
assert.strictEqual(bwsComparable(salmon), false,
  'a $10 portion against a $38 kilo is not a comparable pair');
assert.strictEqual(card(salmon), null, 'no card may be built on a size mismatch');
// Same product, matched sizes: the guard must NOT fire, or it would silently
// empty the panel instead of cleaning it.
const salmonOk = { ...salmon, coles: { price: 34, name: 'Salmon Fillets', unit_price: 34, unit: '1KG' } };
assert.strictEqual(bwsComparable(salmonOk), true, 'like-for-like pairs must stay eligible');

// 11. The grapes trap: history says $5.50, today says $18.91, because the 900g
//     bag listing became a per-kg one. Telling someone to wait for a price that
//     belongs to a different product is worse than saying nothing.
const grapes = mk('Grapes', 'Fruit & Veg',
  [[120, 5.4], [100, 5.5], [80, 5.5], [60, 6], [40, 6.9], [0, 18.91]], 18.91);
const c11 = card(grapes);
assert(!c11, `a 3.4x listing jump is not a price move, got ${c11 && c11.verdict}`);
// ...but a genuine half-price special still gets through, which is the whole
// reason the floor is 0.4 and not 0.6.
const half = mk('Detergent', 'Household',
  [[120, 12], [90, 12], [60, 12], [30, 12], [10, 12], [0, 6]], 6);
const c11b = card(half);
assert(c11b && c11b.verdict === 'stock', `half price must survive, got ${c11b && c11b.verdict}`);

// 12. Real data: the panel must actually produce something, and must stay small.
const items = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'data', 'latest.json'), 'utf8')).items;
const live = buyWaitCards(items, { tune: TUNE });
assert(live.length <= globalThis.BWS_MAX_CARDS, 'live panel over cap');
const counts = live.reduce((m, c) => (m[c.verdict] = (m[c.verdict] || 0) + 1, m), {});
// Every live card must carry ONE short, complete note - an empty or NaN headline
// is a bug that only shows up on real data (missing typical, NaN prices). The
// second `why` sentence was retired: the percentage and the struck-through
// "was" already state the money, so a card that restates it in words is the
// clutter that made the panel skippable.
for (const c of live) {
  assert(c.headline && !/NaN|undefined/.test(c.headline),
    `broken card copy: ${c.item.list_item} - "${c.headline}"`);
  assert(c.why === undefined, `cards must carry no second sentence, got "${c.why}"`);
  assert(c.headline.length <= 34, `note too long to stay on one line: "${c.headline}"`);
  assert(c.stake >= globalThis.BWS_MIN_STAKE, `${c.item.list_item} slipped under the stake floor`);
}

console.log(`buy_wait_selfcheck: 12/12 OK  (live panel: ${live.length} cards `
  + `${JSON.stringify(counts)})`);
for (const c of live) {
  console.log(`   [${c.verdict.toUpperCase().padEnd(5)}] ${c.item.list_item.slice(0, 38).padEnd(40)}`
    + ` ${c.headline}`);
}

// ── Outside-shop cards ──────────────────────────────────────────────────────
// Chemist Warehouse / Priceline / Big W / ALDI / Kmart keep NO price history -
// only a current price and the day it was checked - so the deal engine, which
// judges everything against its own past, could never see them and they never
// reached Hot Deals at all. The question that needs no history is "how far under
// the supermarkets is it right now", and that is what these cards answer.
{
  const dep = (ww, co, third) => ({
    list_item: 'Rexona Sport', category: 'Personal Care', trip_count: 2,
    woolworths: ww == null ? null : { price: ww }, coles: co == null ? null : { price: co },
    price_history: [], ww_price_history: [], coles_price_history: [],
    _third: third,
  });
  const cards = (item) => thirdStoreCards([item], { 'Rexona Sport': item._third }, {});

  // The reported case: $2.75 at Priceline against $4.90 WW / $5.50 Coles.
  const c = cards(dep(4.90, 5.50, [{ store: 'priceline', price: 2.75, url: 'u' }]))[0];
  assert(c, 'a 44%-below-supermarket price must produce a card');
  assert.strictEqual(c.verdict, 'else');
  assert.strictEqual(c.offPct, 44, `expected 44% off, got ${c.offPct}`);
  assert.strictEqual(c.usual, 4.90, 'must be measured against the CHEAPER supermarket');
  assert(/Priceline/.test(c.headline), `the shop must be named, got "${c.headline}"`);

  // Beating only the DEARER supermarket is not a reason to go anywhere.
  assert(!cards(dep(2.80, 5.50, [{ store: 'priceline', price: 2.75, url: '' }]))[0],
    'a 5c edge over the cheaper store is not a detour');

  // Percentage gate as well as a dollar one: 15% off a cheap item is pennies.
  assert(!cards(dep(3.00, null, [{ store: 'priceline', price: 2.70, url: '' }]))[0],
    '30c is under BWS_MIN_STAKE and must not surface');

  // An item the supermarkets do not stock has nothing to be "cheaper than".
  assert(!cards(dep(null, null, [{ store: 'priceline', price: 1.00, url: '' }]))[0],
    'no supermarket price means no comparison to make');

  // The cheapest outside shop wins when several carry it.
  const many = cards(dep(6.00, 6.50, [
    { store: 'chemist_warehouse', price: 4.50, url: '' },
    { store: 'priceline', price: 3.20, url: '' },
  ]))[0];
  assert.strictEqual(many.store, 'priceline', 'must pick the cheapest outside shop');
  assert.strictEqual(many.price, 3.20);

  // Archived items stay out, exactly as they do for supermarket cards.
  const arch = thirdStoreCards([dep(4.90, 5.50, [{ store: 'priceline', price: 2.75, url: '' }])],
    { 'Rexona Sport': [{ store: 'priceline', price: 2.75 }] },
    { archivedSet: new Set(['Rexona Sport']) });
  assert.strictEqual(arch.length, 0, 'archived items must not produce outside-shop cards');
}
console.log('buy_wait_selfcheck: outside-shop cards OK');
