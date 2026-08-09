// Self-check for UI-created categories + the now-editable comparison metric.
// Run: node scripts/category_create_selfcheck.js
//
// The whole point of this change is that a category can be made, and its metric
// chosen, WITHOUT editing code. Every failure mode here is silent: a created
// category that simply doesn't appear, a `sticker` choice nothing reads, or a
// helper that still iterates the seed array and so disagrees with everything
// else about what categories exist.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

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

// A tiny stand-in seed, so the assertions don't move every time a real category
// is added or renamed in utils.js.
const DEFAULT_VARIANT_GROUPS = [
  { key: 'seeded_kg', label: 'Seeded kg', category: 'Pantry', items: ['A', 'B'] },
  { key: 'seeded_stick', label: 'Seeded sticker', category: 'Household', sticker: true, items: ['C'] },
];

let _ovStore = {};
const localStorage = { getItem: () => JSON.stringify(_ovStore) };

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
function extractApp(name) {
  const at = appSrc.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in app.js`);
  let i = appSrc.indexOf('{', at), depth = 0;
  for (let j = i; j < appSrc.length; j++) {
    if (appSrc[j] === '{') depth++;
    else if (appSrc[j] === '}' && --depth === 0) return appSrc.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
// `const` inside eval() stays in eval's own scope, unlike a function declaration
// which hoists out. Rebind to globalThis so the assertions below can see it.
function extractAppConst(name) {
  const m = appSrc.match(new RegExp(`const ${name}\\s*=\\s*\\{[\\s\\S]*?\\n\\};`));
  assert(m, `const ${name} not found in app.js`);
  return m[0].replace(/^const /, 'globalThis.');
}

// eslint-disable-next-line no-eval
eval([
  extract('migratePerKgOverride'), extract('computePerKgItems'),
  extract('isCreatedCategory'), extract('categoryKeyFor'),
  extract('allVariantGroupSeeds'),
  extract('loadVariantGroups'), extract('variantGroupItemNames'),
  extract('perKgMemberNames'), extract('stickerGroups'),
  extractAppConst('CAT_METRICS'), extractApp('catMetricOf'),
].join('\n'));

const byKey = () => Object.fromEntries(loadVariantGroups().map(g => [g.key, g]));

// 1. No overrides -> exactly the seeded categories, flags straight from code.
_ovStore = {};
assert.deepStrictEqual(loadVariantGroups().map(g => g.key), ['seeded_kg', 'seeded_stick']);
assert.strictEqual(byKey().seeded_stick.sticker, true);
assert.strictEqual(byKey().seeded_kg.sticker, false);

// 2. A created category appears, keyed by its own key, seeded members empty so
//    `add` IS the membership.
_ovStore = { my_cat: { v: 2, created: true, label: 'Dishwasher tabs', category: 'Household', perPack: true, add: ['X', 'Y'], remove: [] } };
const created = byKey().my_cat;
assert(created, 'created category did not appear in loadVariantGroups()');
assert.strictEqual(created.label, 'Dishwasher tabs');
assert.strictEqual(created.category, 'Household');
assert.strictEqual(created.perPack, true);
assert.deepStrictEqual(created.items, ['X', 'Y']);
// ...and it must not disturb the seeded ones or their order.
assert.deepStrictEqual(loadVariantGroups().map(g => g.key), ['seeded_kg', 'seeded_stick', 'my_cat']);

// 3. An override key WITHOUT `created` is a patch to a seeded category, never a
//    new one - otherwise every stale key from an old build becomes a phantom.
_ovStore = { ghost_key: { v: 2, add: ['Z'], remove: [] } };
assert.strictEqual(byKey().ghost_key, undefined, 'a non-created override key materialised as a category');

// 4. The metric is editable in BOTH directions on a seeded category. `|| g.sticker`
//    would pass the turn-on case and silently fail the turn-off one.
_ovStore = { seeded_kg: { v: 2, sticker: true, add: [], remove: [] } };
assert.strictEqual(byKey().seeded_kg.sticker, true, 'could not turn sticker ON');
_ovStore = { seeded_stick: { v: 2, sticker: false, add: [], remove: [] } };
assert.strictEqual(byKey().seeded_stick.sticker, false, 'could not turn sticker OFF');
_ovStore = { seeded_kg: { v: 2, perPack: true, add: [], remove: [] } };
assert.strictEqual(byKey().seeded_kg.perPack, true, 'could not turn perPack ON');

// 5. stickerGroups() tracks the override, not the seed. This is the one that
//    would have desynced the basket from the table with nothing thrown.
_ovStore = { seeded_kg: { v: 2, sticker: true, add: [], remove: [] } };
assert(stickerGroups().has('seeded_kg'), 'stickerGroups() ignored an override that turned sticker on');
_ovStore = { seeded_stick: { v: 2, sticker: false, add: [], remove: [] } };
assert(!stickerGroups().has('seeded_stick'), 'stickerGroups() ignored an override that turned sticker off');
_ovStore = { my_cat: { v: 2, created: true, sticker: true, add: ['X'], remove: [] } };
assert(stickerGroups().has('my_cat'), 'stickerGroups() cannot see a created category');

// 6. A created category's members count as per-kg members everywhere - if they
//    don't, the basket's "whole list" view double-counts them alongside the row.
_ovStore = { my_cat: { v: 2, created: true, add: ['X', 'Y'], remove: [] } };
const names = perKgMemberNames();
assert(names.has('X') && names.has('Y'), 'created category members missing from perKgMemberNames()');
assert(names.has('A') && names.has('C'), 'seeded members lost from perKgMemberNames()');

// 7. Removing a seeded member still works alongside a created category.
_ovStore = {
  seeded_kg: { v: 2, add: [], remove: ['A'] },
  my_cat: { v: 2, created: true, add: ['X'], remove: [] },
};
assert.deepStrictEqual(byKey().seeded_kg.items, ['B']);
assert.deepStrictEqual(byKey().my_cat.items, ['X']);

// 8. Junk in the override map must not throw or invent categories.
for (const junk of [null, 0, 'str', [], { created: true }]) {
  _ovStore = { weird: junk };
  assert.doesNotThrow(() => loadVariantGroups(), `threw on override value ${JSON.stringify(junk)}`);
}

// 9. The metric control must round-trip. catMetricOf(applied flags) has to give
//    back the button that was clicked, or reopening the dialog shows the wrong
//    one selected and the next save silently rewrites the category's metric.
for (const m of ['pack', 'kg', 'piece']) {
  const flags = CAT_METRICS[m];
  assert.strictEqual(catMetricOf(flags), m, `metric ${m} did not round-trip`);
}
// "Per piece" MUST set perPack - groupMetric() checks perPack before sticker, so
// a piece metric that only set sticker would quietly compare pack prices.
assert.strictEqual(CAT_METRICS.piece.perPack, true);
assert.strictEqual(CAT_METRICS.kg.sticker, false);
assert.strictEqual(CAT_METRICS.kg.perPack, false);
// Matches the seeded nappies shape (sticker + perPack) that already ships.
assert.strictEqual(catMetricOf({ sticker: true, perPack: true }), 'piece');
// A category with neither flag is $/kg - the historical default.
assert.strictEqual(catMetricOf({}), 'kg');
assert.strictEqual(catMetricOf(undefined), 'kg');

// 10. categoryKeyFor: safe keys only, and no key at all from an unusable name.
assert.strictEqual(categoryKeyFor('Dishwashing Tablets'), 'dishwashing_tablets');
assert.strictEqual(categoryKeyFor("Kellogg's Corn Flakes 500g"), 'kellogg_s_corn_flakes_500g');
assert.strictEqual(categoryKeyFor('  spaced  out  '), 'spaced_out');
assert.strictEqual(categoryKeyFor('!!!'), '', 'punctuation-only name must yield no key');
assert.strictEqual(categoryKeyFor(''), '');
assert.strictEqual(categoryKeyFor(null), '');
assert(!/[^a-z0-9_]/.test(categoryKeyFor('Café Crème 1kg — "special"')), 'key leaked an unsafe character');
assert(categoryKeyFor('x'.repeat(200)).length <= 48, 'key not length-capped');

// 11. A converted product becomes a one-member category that behaves like any
//     other - this is the whole "turn a normal product into a category" path.
_ovStore = {};
const convKey = categoryKeyFor('Shine Dishwashing Tablets 100pk');
_ovStore[convKey] = { v: 2, created: true, label: 'Dishwashing tablets',
                      category: 'Household', sticker: false, perPack: false,
                      add: ['Shine Dishwashing Tablets 100pk'], remove: [] };
const conv = byKey()[convKey];
assert(conv, 'converted product did not become a category');
assert.deepStrictEqual(conv.items, ['Shine Dishwashing Tablets 100pk']);
assert.strictEqual(catMetricOf(conv), 'kg', 'conversion must default to $/kg');
assert(perKgMemberNames().has('Shine Dishwashing Tablets 100pk'));

console.log('category_create_selfcheck: 11/11 OK');
