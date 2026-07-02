// Self-check for docs/utils.js — the single source of truth for per-100g pricing,
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

// getDealQuality() closes over these two module-level tuning constants.
function extractConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*[^;]+;`));
  assert(m, `const ${name} not found in utils.js`);
  return m[0];
}

// eslint-disable-next-line no-eval
eval([
  extractConst('DEAL_MIN_SPREAD'),
  extractConst('DEAL_MIN_DROP'),
  extract('clientPer100'),
  extract('exclPriceSet'),
  extract('getTrendSeries'),
  extract('_median'),
  extract('getDealQuality'),
  extract('calcTrendPosition'),
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

console.log(`utils_selfcheck: all ${n} cases passed`);
