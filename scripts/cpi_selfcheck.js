// Self-check for the personal basket index.
// Run: node scripts/cpi_selfcheck.js
//
// A price index is the easiest thing in this repo to get subtly, confidently
// wrong: every failure mode produces a smooth plausible line. The assertions
// here are the four classic ones - a changing sample masquerading as inflation,
// a thin month driving the whole series, one broken listing counted as a price
// rise, and weights that ignore how much you actually buy.
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
  extractConst('CPI_MIN_COVERAGE'), extractConst('CPI_MAX_MOVE'),
  extractConst('CPI_MIN_POINTS'), extractConst('CPI_MOVERS'),
  extract('_median'), extract('exclPriceSet'), extract('bwsSeries'),
  extract('cpiMonthlyPrices'), extract('personalCpi'),
].join('\n'));

// An item priced on the 15th of each named month. `prices` maps month -> price;
// a null means "not recorded that month", which is the case the whole design is
// about. Two dated entries per month so the median has something to chew on.
function mk(name, trips, prices) {
  const hist = [];
  for (const [m, p] of Object.entries(prices)) {
    if (p == null) continue;
    hist.push({ date: m + '-08', price: p }, { date: m + '-22', price: p });
  }
  return {
    list_item: name, trip_count: trips, category: 'Pantry',
    woolworths: { price: 1, name }, coles: null,
    price_history: [], coles_price_history: [], ww_price_history: hist,
  };
}
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04'];
const flat = (name, trips, p) => mk(name, trips, Object.fromEntries(MONTHS.map(m => [m, p])));

// 1. Prices that never move produce a flat index at exactly 100.
{
  const cpi = personalCpi([flat('A', 5, 4), flat('B', 5, 10), flat('C', 5, 2), flat('D', 5, 6), flat('E', 5, 8)]);
  assert(cpi, 'five stable items across four months must produce an index');
  assert.strictEqual(cpi.points.length, 4, 'four months in, four points out');
  for (const p of cpi.points) assert(Math.abs(p.index - 100) < 1e-9, `flat prices drifted to ${p.index}`);
  assert.strictEqual(cpi.changePct, 0, 'no change means no change');
}

// 2. A uniform 10% rise reads as exactly +10%, not +9.7% or +10.3%. Chaining
//    compounds, so a small per-link bias would be invisible here and obvious a
//    year later.
{
  const rise = (name, trips, p0) => mk(name, trips, { '2026-01': p0, '2026-02': p0 * 1.1, '2026-03': p0 * 1.21, '2026-04': p0 * 1.331 });
  const cpi = personalCpi([rise('A', 5, 4), rise('B', 5, 10), rise('C', 5, 2), rise('D', 5, 6), rise('E', 5, 8)]);
  assert(Math.abs(cpi.points[1].index - 110) < 1e-6, `one link of +10% gave ${cpi.points[1].index}`);
  assert(Math.abs(cpi.points[3].index - 133.1) < 1e-6, `three links of +10% gave ${cpi.points[3].index}`);
}

// 3. THE trap: a cheap item joining the sample must not read as deflation.
//    A fixed-basket-over-whatever-is-present index would report the basket
//    getting cheaper here purely because a $1 item started being recorded.
//    Chaining on the overlap alone must report zero change.
{
  // Weight kept at 10 against the incumbents' 25: heavy enough that a naive
  // "mean of whatever is present" index would read -26% when it arrives, light
  // enough that the earlier links still clear CPI_MIN_COVERAGE (a heavier
  // newcomer truncates the series instead, which is case 5).
  const joiner = mk('Newcomer', 10, { '2026-01': null, '2026-02': null, '2026-03': 1, '2026-04': 1 });
  const cpi = personalCpi([flat('A', 5, 10), flat('B', 5, 10), flat('C', 5, 10), flat('D', 5, 10), flat('E', 5, 10), joiner]);
  assert(cpi && cpi.points.length === 4, 'the newcomer must not truncate the series at this weight');
  for (const p of cpi.points) {
    assert(Math.abs(p.index - 100) < 1e-9,
      `a newly-recorded cheap item moved the index to ${p.index.toFixed(2)} - the sample changed, the prices did not`);
  }
}

// 4. One item's listing changing must not become inflation. A $4 line replaced
//    by a $40 one is a different product; without the trim it would swamp
//    everything around it.
{
  const broken = mk('Relisted', 5, { '2026-01': 4, '2026-02': 4, '2026-03': 40, '2026-04': 40 });
  const cpi = personalCpi([flat('A', 5, 10), flat('B', 5, 10), flat('C', 5, 10), flat('D', 5, 10), flat('E', 5, 10), broken]);
  for (const p of cpi.points) {
    assert(Math.abs(p.index - 100) < 1e-9, `a 10x relisting moved the index to ${p.index.toFixed(2)}`);
  }
  assert(!cpi.up.some(m => m.item.list_item === 'Relisted'),
    'an item excluded from the index must not headline the movers list');
}

// 5. Thin links are dropped, and dropping one truncates rather than bridges.
//    Here only ONE low-weight item spans Jan->Feb, so that link cannot carry
//    CPI_MIN_COVERAGE and the series must start at Feb instead.
{
  const spanner = mk('Spanner', 1, { '2026-01': 10, '2026-02': 10, '2026-03': 10, '2026-04': 10 });
  const late = (n) => mk(n, 20, { '2026-01': null, '2026-02': 10, '2026-03': 10, '2026-04': 10 });
  const cpi = personalCpi([spanner, late('L1'), late('L2'), late('L3'), late('L4'), late('L5')]);
  assert(cpi, 'three good months must still produce an index');
  assert.strictEqual(cpi.base, '2026-02', `series should start where coverage begins, got ${cpi.base}`);
  assert.strictEqual(cpi.points.length, 3, 'the thin link must be dropped, not bridged');
}

// 6. Under CPI_MIN_POINTS usable months there is no chart at all. Two points is
//    a line between two dots and reads as a trend it cannot support.
{
  const two = (n) => mk(n, 5, { '2026-01': null, '2026-02': null, '2026-03': 10, '2026-04': 11 });
  assert.strictEqual(personalCpi([two('A'), two('B'), two('C'), two('D'), two('E')]), null,
    'two points is not a trend');
}

// 7. Weighting is by trips. The same 50% rise on the thing bought 40 times must
//    dominate the thing bought once - an unweighted mean would split them.
{
  const heavy = mk('Weekly', 40, { '2026-01': 10, '2026-02': 15, '2026-03': 15, '2026-04': 15 });
  const light = mk('Yearly', 1, { '2026-01': 10, '2026-02': 5, '2026-03': 5, '2026-04': 5 });
  const cpi = personalCpi([heavy, light, flat('A', 1, 10), flat('B', 1, 10), flat('C', 1, 10)]);
  assert(cpi.points[1].index > 130,
    `the weekly item must dominate, index was ${cpi.points[1].index.toFixed(1)}`);
  assert.strictEqual(cpi.up[0].item.list_item, 'Weekly', 'movers must rank by trips x change too');
}

// 8. Movers report the per-unit change and point the right way.
{
  const up = mk('Dearer', 10, { '2026-01': 4, '2026-02': 5, '2026-03': 5, '2026-04': 5 });
  const dn = mk('Cheaper', 10, { '2026-01': 8, '2026-02': 6, '2026-03': 6, '2026-04': 6 });
  const cpi = personalCpi([up, dn, flat('A', 2, 10), flat('B', 2, 10), flat('C', 2, 10)]);
  const u = cpi.up.find(m => m.item.list_item === 'Dearer');
  const d = cpi.down.find(m => m.item.list_item === 'Cheaper');
  assert(u && Math.abs(u.diff - 1) < 1e-9, 'a $4->$5 item is +$1');
  assert(d && Math.abs(d.diff + 2) < 1e-9, 'an $8->$6 item is -$2');
  assert(cpi.up.every(m => m.diff > 0) && cpi.down.every(m => m.diff < 0),
    'the two mover lists must not leak into each other');
}

// 9. Real data: it must produce a usable series, and every guard must hold on it.
const items = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'data', 'latest.json'), 'utf8')).items;
const live = personalCpi(items);
assert(live, 'the live file must support an index');
assert(live.points.length >= globalThis.CPI_MIN_POINTS, 'live series under the minimum');
for (const p of live.points) {
  assert(p.coverage >= globalThis.CPI_MIN_COVERAGE || p.month === live.base,
    `${p.month} charted at ${(p.coverage * 100).toFixed(0)}% coverage`);
  assert(isFinite(p.index) && p.index > 0, `${p.month} has a broken index value`);
}
// A personal grocery index that moves more than 40% in three months is not
// measuring prices, it is measuring a bug.
assert(Math.abs(live.changePct) < 40, `live index moved ${live.changePct.toFixed(1)}% - implausible`);

console.log(`cpi_selfcheck: 9/9 OK  (live: ${live.base} -> ${live.latest}, `
  + `${live.points.length} points, ${live.changePct >= 0 ? '+' : ''}${live.changePct.toFixed(1)}%, `
  + `${live.itemsInWindow} items)`);
console.log('   ' + live.points.map(p => `${p.month} ${p.index.toFixed(1)}`).join('  '));
console.log('   dearest: ' + live.up.slice(0, 3).map(m =>
  `${m.item.list_item.slice(0, 24)} +$${m.diff.toFixed(2)}`).join(', '));
console.log('   cheaper: ' + live.down.slice(0, 3).map(m =>
  `${m.item.list_item.slice(0, 24)} -$${Math.abs(m.diff).toFixed(2)}`).join(', '));
