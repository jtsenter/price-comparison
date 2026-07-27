// Self-check for the per-kg group override model + URL name derivation in docs/app.js.
// No framework, no deps: extracts the three pure functions straight from app.js (so the
// logic is single-sourced) and asserts. Run: node scripts/perkg_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// The per-kg override model moved to utils.js (the basket builds the same
// category rows from it); deriveNameFromUrl is still app.js display logic.
const src = ['utils.js', 'app.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8'))
  .join('\n');

// Slice `function NAME(...) { ... }` by brace-matching from the first '{'.
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in utils.js/app.js`);
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

// 10. WEIGHT-NAME GUARD (data-driven). For the curated per-kg groups, every
// member's per-store display name must carry a pack size. Display names resolve
// override-first (url_overrides.json ww_name/coles_name beat scraped store
// names, mirroring wwNameFor/coNameFor in app.js), which is what makes weights
// survive scrapes - a scrape rewrites latest.json names but never this file.
// This check fails in CI if someone drops those override keys or adds a new
// member without a sized name.
{
  const dataDir = path.join(__dirname, '..', 'docs', 'data');
  const ov = JSON.parse(fs.readFileSync(path.join(dataDir, 'url_overrides.json'), 'utf8'));
  const latest = JSON.parse(fs.readFileSync(path.join(dataDir, 'latest.json'), 'utf8'));
  const byName = Object.fromEntries(latest.items.map(i => [i.list_item, i]));

  // Bracket-match DEFAULT_VARIANT_GROUPS out of utils.js (a semicolon-bounded
  // regex broke on comments once - see utils_selfcheck).
  const usrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
  const gAt = usrc.indexOf('const DEFAULT_VARIANT_GROUPS = [');
  assert(gAt !== -1, 'DEFAULT_VARIANT_GROUPS not found');
  let gi = usrc.indexOf('[', gAt), depth = 0, gEnd = -1;
  for (let j = gi; j < usrc.length; j++) {
    if (usrc[j] === '[') depth++;
    else if (usrc[j] === ']' && --depth === 0) { gEnd = j; break; }
  }
  // eslint-disable-next-line no-eval
  const groups = eval(usrc.slice(gi, gEnd + 1));

  const CURATED = ['greek_yoghurt', 'washed_potatoes', 'carrots', 'brown_onions', 'red_onions', 'nutella', 'lotus_biscoff'];
  const SIZED = /\d+(\.\d+)?\s*(kg|g|ml|l)\b/i;
  // ponytail: mirrors wwNameFor/coNameFor minus the localStorage layer (no
  // browser in CI). If those functions change resolution order, update here.
  const nameFor = (m, store) =>
    (ov[m] || {})[store + '_name'] ||
    (byName[m] || {})[store === 'ww' ? 'woolworths' : 'coles']?.name || m;

  for (const g of groups.filter(g => CURATED.includes(g.key))) {
    for (const m of g.items) {
      for (const store of ['ww', 'coles']) {
        const pinned = !!(ov[m] || {})[store + '_url'];
        const hasData = !!(byName[m] || {})[store === 'ww' ? 'woolworths' : 'coles']?.name;
        if (!pinned && !hasData) continue; // store not sold/pinned - nothing renders
        const nm = nameFor(m, store);
        assert(SIZED.test(nm), `unsized ${store} name for "${m}" in ${g.key}: "${nm}"`);
      }
    }
  }
}

console.log('perkg_selfcheck: all assertions passed');
