// Self-check for the per-kg group override model + URL name derivation in docs/app.js.
// No framework, no deps: extracts the three pure functions straight from app.js (so the
// logic is single-sourced) and asserts. Run: node scripts/perkg_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');

// Slice `function NAME(...) { ... }` by brace-matching from the first '{'.
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in app.js`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-eval
eval([extract('migratePerKgOverride'), extract('computePerKgItems'), extract('deriveNameFromUrl')].join('\n'));

const defaults = ['A', 'B', 'C'];

// 1. No override → defaults verbatim.
assert.deepStrictEqual(computePerKgItems(defaults, undefined), ['A', 'B', 'C']);

// 2. Legacy snapshot with a user add → add preserved.
assert.deepStrictEqual(computePerKgItems(defaults, { items: ['A', 'B', 'C', 'X'] }), ['A', 'B', 'C', 'X']);

// 3. THE FIX - v2 removal of a default actually removes it (old union could not).
assert.deepStrictEqual(computePerKgItems(defaults, { v: 2, remove: ['B'] }), ['A', 'C']);

// 4. v2 add + remove together.
assert.deepStrictEqual(computePerKgItems(defaults, { v: 2, add: ['X'], remove: ['A'] }), ['B', 'C', 'X']);

// 5. Code adds a new default later → it appears even with an existing override.
assert.deepStrictEqual(computePerKgItems(['A', 'B', 'C', 'D'], { v: 2, add: ['X'] }), ['A', 'B', 'C', 'D', 'X']);

// 6. Code prunes a default → it's gone (authoritative), user adds still kept.
assert.deepStrictEqual(computePerKgItems(['A', 'C'], { v: 2, add: ['X'], remove: [] }), ['A', 'C', 'X']);

// 7. Migration: legacy snapshot upgrades to v2 with adds beyond current defaults.
const mig = migratePerKgOverride({ items: ['A', 'B', 'C', 'X'], ww_items: ['A'], coles_items: ['C'] }, defaults);
assert.strictEqual(mig.v, 2);
assert.deepStrictEqual(mig.add, ['X']);
assert.deepStrictEqual(mig.ww_order, ['A']);

// 8. v2 objects pass through migration untouched.
const v2 = { v: 2, add: ['X'], remove: ['A'] };
assert.strictEqual(migratePerKgOverride(v2, defaults), v2);

// 9. URL → name derivation (Woolworths, Coles, junk).
assert.strictEqual(
  deriveNameFromUrl('https://www.woolworths.com.au/shop/productdetails/340853/woolworths-rspca-approved-chicken-breast-fillets-skinless-small'),
  'Woolworths RSPCA Approved Chicken Breast Fillets Skinless Small');
assert.strictEqual(
  deriveNameFromUrl('https://www.coles.com.au/product/coles-rspca-approved-chicken-breast-fillets-large-pack-approx.-1.4kg-2263179'),
  'Coles RSPCA Approved Chicken Breast Fillets Large Pack Approx. 1.4kg');
assert.strictEqual(deriveNameFromUrl('https://example.com/nope'), '');
assert.strictEqual(deriveNameFromUrl(''), '');

console.log('perkg_selfcheck: all assertions passed');
