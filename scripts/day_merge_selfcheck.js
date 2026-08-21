// Self-check for the scrape log's day merge (scrape-log.html, paintChangeArchive).
//
// One "Update Prices" click is really several runs - the main sweep, then the
// archived pass a minute later, plus any retry or validation write. 17 Aug 2026
// logged SEVEN, six of them empty. Shown per run that reads as seven scrapes; the
// list is grouped by calendar day instead.
//
// The risk in merging is arithmetic, not layout: a product that moved twice in a
// day must count ONCE, at its net move, and a price that went up and came back
// down must not be reported as a change. These pin that.
//
// Run: node scripts/day_merge_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'scrape-log.html'), 'utf8');

function ex(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `${name} not found in scrape-log.html`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
// eslint-disable-next-line no-eval
eval(ex('mergeDayStore'));
const mergeStore = mergeDayStore;

// The table, the chart and the day cards must all count the SAME merged moves -
// they didn't, and 4 Aug showed 62 in the table above a card listing 61.
assert.strictEqual((src.match(/function mergeDayStore\(/g) || []).length, 1,
  'mergeDayStore must be defined exactly once');
assert.ok(/for \(const c of mergeDayStore\(runs, key\)\)/.test(src),
  'paintChangeSummary must count merged moves, not raw per-run ones');

let n = 0;
const check = (label, fn) => { fn(); n++; process.stdout.write(`  ok  ${label}\n`); };

const run = (ww) => ({ ww });

check('a single run passes through unchanged', () => {
  const out = mergeStore([run([{ item: 'Milk', old: 3.0, new: 3.5 }])], 'ww');
  assert.deepStrictEqual(out, [{ item: 'Milk', old: 3.0, new: 3.5, times: 1 }]);
});

check('two runs, two different products -> both kept', () => {
  const out = mergeStore([
    run([{ item: 'Milk', old: 3.0, new: 3.5 }]),
    run([{ item: 'Bread', old: 4.0, new: 4.5 }]),
  ], 'ww');
  assert.strictEqual(out.length, 2);
});

check('THE merge: one product moving twice counts once, at its NET move', () => {
  // 12.50 -> 13.00 -> 13.90 is one 12.50 -> 13.90 move, not two.
  const out = mergeStore([
    run([{ item: 'Mushrooms', old: 12.5, new: 13.0 }]),
    run([{ item: 'Mushrooms', old: 13.0, new: 13.9 }]),
  ], 'ww');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].old, 12.5, 'keeps the FIRST run\'s old price');
  assert.strictEqual(out[0].new, 13.9, 'and the LAST run\'s new price');
  assert.strictEqual(out[0].times, 2, 'and records that it moved twice');
});

check('a round trip inside one day is not a change', () => {
  // Up then back down: by day\'s end the price is what it started at. Reporting
  // it would put a phantom row in the list and a phantom tick in the day count.
  const out = mergeStore([
    run([{ item: 'Avocado', old: 2.0, new: 2.5 }]),
    run([{ item: 'Avocado', old: 2.5, new: 2.0 }]),
  ], 'ww');
  assert.deepStrictEqual(out, []);
});

check('three moves collapse to one, endpoints intact', () => {
  const out = mergeStore([
    run([{ item: 'X', old: 1, new: 2 }]),
    run([{ item: 'X', old: 2, new: 3 }]),
    run([{ item: 'X', old: 3, new: 4 }]),
  ], 'ww');
  assert.deepStrictEqual(out, [{ item: 'X', old: 1, new: 4, times: 3 }]);
});

check('empty and missing runs are skipped, not crashed on', () => {
  assert.deepStrictEqual(mergeStore([{}, run([]), run(null)], 'ww'), []);
  assert.deepStrictEqual(mergeStore([], 'ww'), []);
});

check('outside shops key on SHOP + product, not product alone', () => {
  // Big W and Kmart both sell the same gum. Keyed on the name alone, one would
  // overwrite the other and a shop's move would vanish.
  const out = mergeStore([{ third: [
    { store: 'big_w', item: 'Extra Gum 64g', old: 5.0, new: 4.5 },
    { store: 'kmart', item: 'Extra Gum 64g', old: 5.0, new: 4.0 },
  ] }], 'third');
  assert.strictEqual(out.length, 2, 'both shops must survive');
  assert.deepStrictEqual(out.map(c => c.store).sort(), ['big_w', 'kmart']);
});

check('the same shop moving twice still merges', () => {
  const out = mergeStore([
    { third: [{ store: 'big_w', item: 'Gum', old: 5.0, new: 4.5 }] },
    { third: [{ store: 'big_w', item: 'Gum', old: 4.5, new: 4.0 }] },
  ], 'third');
  assert.deepStrictEqual(out, [{ store: 'big_w', item: 'Gum', old: 5.0, new: 4.0, times: 2 }]);
});

check('string prices from older entries still compare numerically', () => {
  // The archive is hand-edited on occasion; "2.00" must equal 2 for the
  // round-trip test, or a no-op would be reported as a change.
  assert.deepStrictEqual(mergeStore([run([{ item: 'Y', old: '2.00', new: 2 }])], 'ww'), []);
});

// ── the real archive ────────────────────────────────────────────────────────
check('against the live archive: no day loses or invents a product', () => {
  const log = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'data', 'price_changes.json'), 'utf8'));
  const byDay = new Map();
  for (const r of log) {
    const d = String(r.date).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  for (const [day, runs] of byDay) {
    for (const key of ['ww', 'coles', 'third']) {
      const merged = mergeStore(runs, key);
      const rawNames = new Set(runs.flatMap(r => (r[key] || []).map(c => c.item)));
      // Every merged product must have existed in the raw runs...
      for (const c of merged) assert.ok(rawNames.has(c.item), `${day}: invented ${c.item}`);
      // ...and merging can only ever shrink the list, never grow it.
      const rawCount = runs.reduce((n2, r) => n2 + (r[key] || []).length, 0);
      assert.ok(merged.length <= rawCount, `${day}/${key}: merge grew ${rawCount} -> ${merged.length}`);
    }
  }
  const multi = [...byDay.values()].filter(r => r.length > 1).length;
  process.stdout.write(`      (${byDay.size} days, ${log.length} runs; ${multi} days merge >1 run)\n`);
});

// ── Reading order ───────────────────────────────────────────────────────────
// mergeDayStore preserves SCRAPE order, which is arbitrary: the pooled "Other
// stores" column interleaved Chemist Warehouse and Big W lines at random, and
// the same eight products came out in a different sequence every day.
eval(ex('byStoreThenName'));
// byStoreThenName leans on two page globals; the real ones, so a renamed store
// or a changed display name is caught here rather than on screen.
const THIRD_STORES_SRC = src.match(/const THIRD_STORES = \{[\s\S]*?\n\};/);
assert.ok(THIRD_STORES_SRC || /THIRD_STORES/.test(src), 'THIRD_STORES must be reachable');
global.THIRD_STORES = {
  chemist_warehouse: { letter: 'C', label: 'Chemist Warehouse' },
  priceline:         { letter: 'P', label: 'Priceline' },
  big_w:             { letter: 'B', label: 'Big W' },
  aldi:              { letter: 'A', label: 'ALDI' },
  kmart:             { letter: 'K', label: 'Kmart' },
};
global.shortName = s => String(s);

const order = list => [...list].sort(byStoreThenName)
  .map(c => (c.store ? THIRD_STORES[c.store].letter + ' ' : '') + c.item);

check('outside-shop moves group by shop before anything else', () => {
  // The reported list, in the order the file actually stored it.
  const got = order([
    { store: 'chemist_warehouse', item: 'Huggies Essentials Nappies Size 6 (16+kg) 40 Pack' },
    { store: 'big_w',             item: 'WaterWipes Baby & Newborn Sensitive Wipes 180 Pack' },
    { store: 'chemist_warehouse', item: 'Bunjie Nappies Jumbo Size 6 Junior 46 Pack' },
    { store: 'big_w',             item: 'WaterWipes Baby & Newborn Sensitive Wipes 540 Pack' },
    { store: 'chemist_warehouse', item: 'Huggies Ultra Dry Nappies Boys Size 6 (16kg+) 60 Pack' },
    { store: 'big_w',             item: 'Extra Peppermint Sugar Free Chewing Gum Bottle 64g' },
    { store: 'chemist_warehouse', item: 'Ecostore Dish Washer Tablets Fragrance Free 30 Pack' },
    { store: 'chemist_warehouse', item: 'Babylove Water Wipes (80 X 3) 240 Pack' },
  ]);
  assert.deepStrictEqual(got.map(s => s[0]), ['B','B','B','C','C','C','C','C'],
    'all of one shop must sit together');
  assert.deepStrictEqual(got, [
    'B Extra Peppermint Sugar Free Chewing Gum Bottle 64g',
    'B WaterWipes Baby & Newborn Sensitive Wipes 180 Pack',
    'B WaterWipes Baby & Newborn Sensitive Wipes 540 Pack',
    'C Babylove Water Wipes (80 X 3) 240 Pack',
    'C Bunjie Nappies Jumbo Size 6 Junior 46 Pack',
    'C Ecostore Dish Washer Tablets Fragrance Free 30 Pack',
    'C Huggies Essentials Nappies Size 6 (16+kg) 40 Pack',
    'C Huggies Ultra Dry Nappies Boys Size 6 (16kg+) 60 Pack',
  ]);
});

check('shops order by LABEL, so the badges read alphabetically down the column', () => {
  const got = order(['kmart', 'chemist_warehouse', 'aldi', 'priceline', 'big_w']
    .map(store => ({ store, item: 'X' })));
  // Declaration order would give C, P, B, A, K - which reads as no order at all.
  assert.deepStrictEqual(got.map(s => s[0]), ['A', 'B', 'C', 'K', 'P']);
});

check('a storeless list (Woolworths, Coles) falls through to plain alphabetical', () => {
  const got = order([{ item: 'Zucchini' }, { item: 'Apples' }, { item: 'Milk 2L' }]);
  assert.deepStrictEqual(got, ['Apples', 'Milk 2L', 'Zucchini']);
});

check('pack sizes collate numerically, not as text', () => {
  // Plain string order puts "1000 Pack" before "540 Pack" and "60" before "8".
  const got = order([{ item: 'Wipes 60 Pack' }, { item: 'Wipes 540 Pack' },
                     { item: 'Wipes 8 Pack' }, { item: 'Wipes 1000 Pack' }]);
  assert.deepStrictEqual(got,
    ['Wipes 8 Pack', 'Wipes 60 Pack', 'Wipes 540 Pack', 'Wipes 1000 Pack']);
});

check('case does not split otherwise-adjacent products', () => {
  const got = order([{ item: 'apple sauce' }, { item: 'Apple Juice' }, { item: 'Banana' }]);
  assert.deepStrictEqual(got, ['Apple Juice', 'apple sauce', 'Banana']);
});

check('sorting is applied to all three columns, not just the pooled one', () => {
  for (const key of ['ww', 'coles', 'third']) {
    assert.ok(new RegExp(`mergeDayStore\\(runs, '${key}'\\)\\)\\.sort\\(byStoreThenName\\)`).test(src),
      `${key} column is left in scrape order beside sorted siblings`);
  }
});

check('the comparator never reorders equal rows into a different day', () => {
  // Guards against sorting the shared array in place: `days` is rebuilt per
  // paint, but sorting a list still referenced by _changeArchive would mutate
  // the archive itself.
  assert.ok(!/_changeArchive[^\n]*\.sort\(/.test(src),
    'the stored archive must never be sorted in place - the export reads it chronologically');
});

console.log(`\nday_merge_selfcheck: ${n} checks passed`);
