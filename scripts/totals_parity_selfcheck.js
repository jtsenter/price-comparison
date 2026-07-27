// Guards THE invariant the main page and the basket must share: a store total is
// the sum of "the price the row shows x the quantity it shows", and for a per-kg
// category that price is the RATE ($/kg), never the whole-pack price.
//
// This used to be wrong: the basket costed categories as real whole packs, so the
// same basket totalled differently on the two pages, and a store offering the best
// $/kg only in a big bag was pushed to the top of the total purely for pack size.
//
// No framework, no deps. Run: node scripts/totals_parity_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const utils = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

// Minimal localStorage so the storage-backed helpers run under node.
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

function extract(name) {
  const at = utils.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in utils.js`);
  let depth = 0;
  for (let j = utils.indexOf('{', at); j < utils.length; j++) {
    if (utils[j] === '{') depth++;
    else if (utils[j] === '}' && --depth === 0) return utils.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-eval
eval([extract('loadUnitOverrides'), extract('groupUnits'), extract('groupStoreTotal')].join('\n'));

let n = 0;
const check = (label, fn) => { fn(); n++; process.stdout.write(`  ok  ${label}\n`); };

// The user's own worked example. Same $10/kg rate, wildly different pack sizes:
// WW sells it in 500g trays, Coles in a single 2kg bag. At 1kg planned, BOTH
// must count as $10.00 - the rate is the thing being compared.
const g = { list_item: '__group_demo', _wwPerKg: 10, _coPerKg: 10 };

check('1kg at $10/kg = $10 regardless of pack size (WW 500g trays)', () => {
  assert.strictEqual(groupStoreTotal(g, 'ww'), 10);
});
check('1kg at $10/kg = $10 regardless of pack size (Coles 2kg bag)', () => {
  assert.strictEqual(groupStoreTotal(g, 'coles'), 10);
});
check('both stores tie at an equal rate - pack size never breaks the tie', () => {
  assert.strictEqual(groupStoreTotal(g, 'ww'), groupStoreTotal(g, 'coles'));
});

// THE REGRESSION THIS FILE EXISTS FOR: the cheaper RATE must win the total, even
// when it is only sold in bulk. Coles $8/kg in a 5kg sack vs WW $12/kg in 500g
// trays -> at 1kg planned, Coles must total LESS ($8 < $12). Costing real packs
// would have made Coles $40 and handed the win to the more expensive store.
check('cheaper rate wins even when only sold in a 5kg sack', () => {
  const bulk = { list_item: '__group_bulk', _wwPerKg: 12, _coPerKg: 8 };
  assert.strictEqual(groupStoreTotal(bulk, 'ww'), 12);
  assert.strictEqual(groupStoreTotal(bulk, 'coles'), 8);
  assert.ok(groupStoreTotal(bulk, 'coles') < groupStoreTotal(bulk, 'ww'),
    'the better $/kg must produce the lower total');
});

check('quantity scales the rate linearly', () => {
  store['pw_units_v1'] = JSON.stringify({ __group_demo: 2.5 });
  assert.strictEqual(groupStoreTotal(g, 'ww'), 25);
  delete store['pw_units_v1'];
});

check('quantity defaults to 1 with no override', () => {
  assert.strictEqual(groupUnits('__group_demo'), 1);
});

check('both pages read the SAME quantity key (pw_units_v1)', () => {
  // The main page's Units column writes here; the basket stepper must too,
  // otherwise the two totals silently drift apart again.
  store['pw_units_v1'] = JSON.stringify({ __group_demo: 3 });
  assert.strictEqual(groupUnits('__group_demo'), 3);
  delete store['pw_units_v1'];
});

check('an unpriced store side totals null, not zero', () => {
  // Zero would quietly understate a total and make a store that does not stock
  // the item look cheapest.
  assert.strictEqual(groupStoreTotal({ list_item: '__group_x', _wwPerKg: null, _coPerKg: 5 }, 'ww'), null);
});

check('corrupt unit override falls back to 1 rather than NaN', () => {
  store['pw_units_v1'] = '{not json';
  assert.strictEqual(groupUnits('__group_demo'), 1);
  assert.strictEqual(groupStoreTotal(g, 'ww'), 10);
  delete store['pw_units_v1'];
});

// The single definition both pages call - if either grows its own copy again,
// the totals can diverge without any test noticing.
check('groupStoreTotal is defined exactly once in utils.js', () => {
  assert.strictEqual((utils.match(/function groupStoreTotal\(/g) || []).length, 1);
});
check('app.js delegates category totals to it instead of recomputing', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
  assert.ok(/_isGroup\) return groupStoreTotal\(/.test(app),
    'rowStoreTotal must call groupStoreTotal for category rows');
  assert.ok(!/function buildVariantGroups\(/.test(app),
    'app.js must not redefine buildVariantGroups - utils.js owns it');
});
check('the basket delegates to it too', () => {
  const sl = fs.readFileSync(path.join(__dirname, '..', 'docs', 'shopping-list.html'), 'utf8');
  assert.ok(/_isGroup\) return groupStoreTotal\(/.test(sl),
    'basket lineCost must call groupStoreTotal for category rows');
  assert.ok(/buildVariantGroups\(byName\)/.test(sl),
    'basket must build category rows with the shared builder');
});

console.log(`\ntotals parity: ${n} checks passed`);
