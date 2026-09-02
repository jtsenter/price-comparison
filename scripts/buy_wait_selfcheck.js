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
  // The shop is named by the chip beside the price, not repeated in the note.
  assert(!/Priceline/.test(c.headline), `the note must not re-name the shop, got "${c.headline}"`);

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

// ── The section carries the banner, not every card ──────────────────────────
// STOCK UP / BUY / ELSEWHERE on each card restated what the section already
// says - these ARE the picks - and cost a row of height apiece to do it. The
// card keeps a coloured left edge (supermarket vs outside shop) and the store
// chip beside the price, so nothing that lived ONLY in the tag is gone.
{
  // Line endings normalised because assertions below match literal "\n" against
  // this text. The repo stores LF, but core.autocrlf=true checks out CRLF on
  // Windows, so those matches silently found nothing there - the block-boundary
  // assertion compared an index against -1 and passed or failed on which
  // line ending the working tree happened to hold, not on the CSS.
  const hd = fs.readFileSync(path.join(__dirname, '..', 'docs', 'hot-deals.html'), 'utf8')
    .replace(/\r\n/g, '\n');
  assert(!/class="bws-tag"/.test(hd), 'per-card verdict tags must be gone');
  assert(!/BWS_TAG\[/.test(hd), 'nothing may still look up a per-card tag label');
  // One line on a phone. "⭐ What to do this week" wrapped to two.
  const title = hd.match(/<span class="bws-title">([^<]*)<\/span>/);
  assert(title, 'section title not found');
  assert(title[1].length <= 18, `section title too long for one phone line: "${title[1]}"`);

  // The tuner is a settings card; open by default it pushed the first price
  // below the fold on desktop.
  assert(/\.hd-tune-toggle \{\s*\n?\s*display: flex;/.test(hd)
      || /display: flex; align-items: center; gap: 7px; width: 100%;/.test(hd),
    'the tuner handle must show at every width, not only on a phone');
  assert(!/@media[^{]*\{[^}]*\.hd-tune-toggle \{ display: flex; \}/.test(hd),
    'the handle must not be re-hidden inside a media query');
  assert(/localStorage\.setItem\(KEY, collapsed \? '0' : '1'\)/.test(hd),
    'the open/closed choice must be remembered');
  assert(!/if \(!mobile\(\)\) apply\(false\)/.test(hd),
    'desktop must not force the tuner open');

  // The cards slid off the right edge of a phone. .bws-top is a GRID item, so it
  // defaults to min-width:auto - "never narrower than my min-content" - and its
  // min-content is the whole product name, because .bws-name is nowrap. That
  // measured 337px against a 320px track, so the ellipsis could never engage and
  // the track itself grew to 364px. Desktop hid it: minmax(215px, 1fr) gives an
  // explicit minimum, so only mobile's bare 1fr (= minmax(auto, 1fr)) exposed it.
  assert(/\.bws-top \{[^}]*min-width: 0/.test(hd),
    '.bws-top needs min-width:0 or long names push the card off a phone screen');
  // Whatever truncates must still be allowed to truncate.
  assert(/\.bws-name \{[^}]*text-overflow: ellipsis[^}]*\}/s.test(hd),
    'the name on the price line must ellipsis rather than wrap');

  // Three cards on a phone, five everywhere else. The phone cap is CSS because
  // the cards are already sorted best-first - hiding the tail needs no JS.
  assert(/\.bws-card:nth-child\(n \+ 4\) \{ display: none; \}/.test(hd),
    'a phone must show at most three cards');
  const mobileBlock = hd.slice(hd.indexOf('@media (max-width: 700px)'));
  assert(mobileBlock.indexOf('nth-child(n + 4)') < mobileBlock.indexOf('}\n    @media'),
    'the three-card cap must live inside the phone media query, not apply everywhere');

  // The panel must never spill onto a second row. Capping the COUNT at five does
  // not achieve that by itself - a card has a readable floor, so how many fit is
  // a function of the window, and five wrapped at 1009 / 885 / 760px. The
  // breakpoints that hide the overflow are therefore arithmetic, not taste, and
  // they are derived here from the grid's OWN minmax and gap so that changing
  // the card width without moving them fails loudly instead of silently
  // reintroducing the second row.
  const min = Number(/minmax\((\d+)px, 1fr\)/.exec(hd)[1]);
  const gap = Number(/\.bws-grid \{[^}]*gap: (\d+)px/s.exec(hd)[1]);
  // These must be CONTAINER queries. A media query measures the viewport with
  // the scrollbar included while the grid is laid out without it, and that
  // off-by-one really happened: five cards over two rows in a 1211px window.
  assert(/\.bws \{ container-type: inline-size; \}/.test(hd),
    'the panel must be a query container for the caps below to measure the grid');
  assert(!/@media[^{]*\{ \.bws-card:nth-child/.test(hd),
    'a media query would measure the window, scrollbar and all - use @container');
  // n columns need n*min + (n-1)*gap of GRID width, which is what the container
  // reports; hide card n just below that.
  const needs = (n) => n * min + (n - 1) * gap;
  for (const [n, re] of [[5, /@container \(max-width: +(\d+)px\) \{ \.bws-card:nth-child\(n \+ 5\)/],
                         [4, /@container \(max-width: +(\d+)px\) \{ \.bws-card:nth-child\(n \+ 4\)/],
                         [3, /and \(max-width: (\d+)px\) \{\s*\n?\s*\.bws-card:nth-child\(n \+ 3\)/]]) {
    const m = re.exec(hd);
    assert(m, `no @container rule hides card ${n}, so it can start a second row`);
    assert.strictEqual(Number(m[1]), needs(n) - 1,
      `a row of ${n} needs ${needs(n)}px of grid, so card ${n} must hide below `
      + `that (expected max-width ${needs(n) - 1}px, found ${m[1]}px)`);
  }
  // The two-across rule must not reach the phone, where one column means the cap
  // is three. Its floor has to clear the widest phone grid.
  const floor2 = Number(/@container \(min-width: (\d+)px\) and \(max-width: 664px\)/.exec(hd)[1]);
  assert(floor2 >= 440 && floor2 < needs(3),
    `the two-across band must start above a phone grid and below a three-across one, got ${floor2}px`);
  // And the widest cap must agree with the JS cap - hiding a card the panel
  // never produces is dead CSS, producing one the CSS always hides is dead JS.
  assert.strictEqual(globalThis.BWS_MAX_CARDS, 5,
    'the five-across row is what BWS_MAX_CARDS is sized for');
}

// ── Two members per supermarket, the rest folded ────────────────────────────
{
  const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
  assert(/const VARIANTS_PER_STORE = 2;/.test(app), 'the per-supermarket cap must exist');
  assert(/variantRows\.slice\(0, VARIANTS_PER_STORE\)/.test(app)
      && /variantRows\.slice\(VARIANTS_PER_STORE\)/.test(app),
    'the cap must split the rows, not just count them');
  assert(/more at \$\{store === 'woolworths' \? 'Woolworths' : 'Coles'\}/.test(app),
    'the fold must name the store it is hiding rows for');
  // One renderer feeds BOTH the desktop panel and the mobile card, which is why
  // the cap lands on mobile "as well" without a second code path.
  const uses = (app.match(/groupStoreVariantsHTML\(group, '(woolworths|coles)'/g) || []).length;
  assert(uses >= 4, `expected the desktop panel AND the mobile card to use it, saw ${uses}`);
}
console.log('buy_wait_selfcheck: hot-deals chrome + per-store cap OK');

// ── "Cheapest ever" means the all-time floor, not a streak ──────────────────
// Cook Chicken dropped to $12 - lower than anything in three years of records -
// and HELD there. lastAsCheap then found the $12 from three days ago and the
// card read "Cheapest in 3 days", describing a record as a short streak. The
// earlier $12 is the same ongoing low, not a previous occasion.
{
  // A long, boring history at 16-18 and then a drop to $12 that has HELD for
  // three days. The length is load-bearing: pricePercentile counts today's $12
  // and the $12 from three days ago as two separate observations, so a short
  // series never clears BWS_STOCK_RANK no matter how deep the drop.
  const weekly = Array.from({ length: 20 }, (_, k) => [140 - k * 7, k % 2 ? 16 : 18]);
  const held = mk('Roasting Portions', 'Meat & Seafood',
    [...weekly, [3, 12], [0, 12]], 12);
  const c = card(held);
  assert(c, 'an item at its all-time low must still produce a card');
  assert.strictEqual(c.headline, 'Cheapest ever',
    `a price sitting on its own floor is cheapest EVER, got "${c.headline}"`);

  // The other half must not regress: genuinely cheaper before, so the streak
  // wording is the honest one.
  const dearer = mk('Sometime Cheaper', 'Pantry',
    [[120, 10], [90, 6], [60, 11], [30, 11], [10, 11], [0, 8]], 8);
  const d = card(dearer);
  if (d) assert(/^(Cheapest in|Last this cheap)/.test(d.headline),
    `a price above its own floor must say when, got "${d.headline}"`);
}

// ── The outside-shop note says something the card does not already show ─────
// It read "$2.75 at Priceline", then "Cheapest ever at Priceline" - both name
// the shop a second time, after the chip beside the price already does.
// Whether it is an all-time low is the thing the card knows and the reader
// does not; the shop is not.
{
  const dep = (ww, co, third, hist) => ({
    list_item: 'Rexona Sport', category: 'Personal Care', trip_count: 2,
    woolworths: { price: ww }, coles: co == null ? null : { price: co },
    price_history: [], ww_price_history: (hist || []).map(([d, p]) => ({ date: d, price: p })),
    coles_price_history: [], _third: third,
  });
  const one = (it) => thirdStoreCards([it], { 'Rexona Sport': it._third }, {})[0];

  const low = one(dep(4.90, 5.50, [{ store: 'priceline', price: 2.75 }],
                      [['2026-08-01', 4.90], ['2026-08-08', 5.50]]));
  assert.strictEqual(low.headline, 'Cheapest ever',
    `below everything ever recorded, got "${low.headline}"`);

  // Cheaper than the supermarkets TODAY, but the product has been cheaper
  // before - so no record claim, and still no shop name.
  const notLow = one(dep(4.90, 5.50, [{ store: 'priceline', price: 2.75 }],
                         [['2026-08-01', 1.50]]));
  assert.strictEqual(notLow.headline, 'Cheapest',
    `not an all-time low, got "${notLow.headline}"`);

  assert(!/\$|Priceline/.test(low.headline) && !/\$|Priceline/.test(notLow.headline),
    'the note must not print the price a third time or re-name the shop');
}
console.log('buy_wait_selfcheck: all-time-low wording OK');

// ── Colour names the STORE, and words give way to chips ─────────────────────
{
  const hd = fs.readFileSync(path.join(__dirname, '..', 'docs', 'hot-deals.html'), 'utf8')
    .replace(/\r\n/g, '\n');
  const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  // A top-pick card's left edge is the SHOP, not the verdict. Both verdicts were
  // greens (--green for STOCK UP, --ww for BUY), so every Coles win wore a green
  // edge next to its own red C chip - and the edge is what the eye takes first.
  assert(/const edge = c\.verdict === 'else' \? 'e-third'/.test(hd),
    'the card edge must be chosen from the store, not the verdict');
  assert(/c\.store === 'coles' \? 'e-co' : 'e-ww'/.test(hd),
    'a Coles win must take the Coles edge');
  assert(/\.bws-card\.e-co\s*\{ border-left-color: var\(--coles\); \}/.test(hd),
    'the Coles edge must be the Coles colour');
  assert(/\.bws-card\.e-ww\s*\{ border-left-color: var\(--ww\); \}/.test(hd),
    'the Woolworths edge must be the Woolworths colour');
  // The verdict must no longer paint anything, or a Coles card keeps a green
  // percentage beside its red edge.
  assert(!/\.bws-card\.(stock|buy)\b/.test(hd),
    'no rule may still colour a card by its verdict');
  // A tie has no winner, so it picks no store colour - same reason it gets no chip.
  assert(/c\.tied \? 'e-tie'/.test(hd), 'a tie must not be painted as a store win');

  // An outside-shop card offers no basket button: the basket prices every line
  // at Woolworths or Coles, so a Priceline item would be billed at the very
  // supermarket price the card exists to beat.
  assert(/\$\{c\.verdict === 'else' \? '' : `<button type="button" class="bws-add/.test(hd),
    'an outside-shop card must not render an add-to-basket button');

  // The mobile deal card: the sentence is gone, and with it the second telling
  // of the badge's own number. Scoped to renderDealsMobile - the DESKTOP table
  // keeps its "Save vs usual" column, which has a header to explain itself and
  // a whole row of width to say it in.
  // Comments stripped: these assert on what the function RENDERS, and the
  // comment explaining why the old sentence went quotes the old sentence.
  // Without this, documenting the fix is what breaks the check.
  const _dm = hd.slice(hd.indexOf('function renderDealsMobile'));
  const dm = _dm.slice(0, _dm.indexOf('\nfunction ')).replace(/^\s*\/\/.*$/gm, '');
  assert(dm.length > 500, 'renderDealsMobile not found - the checks below would pass vacuously');
  assert(!/vs usual/.test(dm), 'the "Save $X vs usual $Y" sentence must be gone');
  // Matched as markup and as a rule, not as the bare word - the CSS comment that
  // records what .dm-vs used to do is allowed to name it.
  assert(!/class="dm-vs"|\.dm-vs\b\s*(s\s*)?\{/.test(hd),
    'the wordy vs-line and its styling must be gone');
  assert(!/at \$\{isW \? 'Coles' : 'WW'\}/.test(dm),
    'the store name must come from the chip, not be spelled out');
  assert(/dm-badge pct[^`]*>−\$\{Math\.round\(deal\.dropPct \* 100\)\}%/.test(dm),
    'the badge must be a bare percentage, not "N% below usual"');
  // Struck-out digits at 12px were the thing that could not be read.
  assert(!/<s>/.test(dm), 'the alternative price must not be struck through');
  assert(/class="dm-alt"><span class="store-chip \$\{isW \? 'coles' : 'ww'\}/.test(dm),
    'the alternative must be shown as the OTHER store\'s chip plus its price');

  // Winner in its store's colour, alternative in plain text - the rule the
  // prices page already uses. This card painted every winner green and every
  // loser Coles-red whichever store each actually was.
  assert(!/\.dm-price \{[^}]*color: var\(--green\)/.test(hd),
    'the winning price must not be green regardless of store');
  assert(/\.dm-card\.ww \.dm-price \{ color: var\(--ww\); \}/.test(hd)
      && /\.dm-card\.co \.dm-price \{ color: var\(--coles\); \}/.test(hd),
    'the winning price must wear its own store colour');
  assert(/\.dm-alt \{[^}]*color: var\(--text\)/.test(hd),
    'the alternative price must be plain text, like the prices page loser');
  // The watch button lost its flex:1 spacer when .dm-vs went.
  assert(/\.dm-watch \{ margin-left: auto/.test(hd),
    'the watch button must still be pushed to the right edge');

  // The prices page mobile card: no "Save $X" line under the winner. Both
  // prices sit side by side with the cheaper one coloured, so the saving is the
  // difference between two numbers already on screen.
  assert(!/mc-save-line|mc-saving/.test(app), 'the mobile save line must be gone from the card');
  const css = fs.readFileSync(path.join(__dirname, '..', 'docs', 'style.css'), 'utf8');
  assert(!/mc-save-line|mc-saving/.test(css), 'its styling must go with it');
}
console.log('buy_wait_selfcheck: store colours + wordless deal card OK');
