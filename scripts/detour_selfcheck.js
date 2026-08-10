// Self-check for detourAdvice - the "worth a second stop?" rule.
// Run: node scripts/detour_selfcheck.js
//
// The whole value of this prompt is that it stays quiet. A banner that appears
// every week is wallpaper, and wallpaper that says "you are losing money" is
// worse than nothing. Every assertion here is about it shutting up.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
function ex(n) {
  const at = src.indexOf('function ' + n + '(');
  assert(at !== -1, 'missing ' + n);
  let i = src.indexOf('{', at), d = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(at, j + 1);
  }
}
function exc(n) {
  return src.match(new RegExp('const\\s+' + n + '\\s*=\\s*[^;]+;'))[0].replace(/^const\s+/, 'globalThis.');
}
// eslint-disable-next-line no-eval
eval([exc('DETOUR_MAX_ITEMS'), exc('DETOUR_MIN_TOTAL'), exc('DETOUR_MIN_SHARE'),
      ex('detourAdvice')].join('\n'));

const row = (name, saving) => ({ name, saving });

// 1. Concentrated saving -> advise. This is the real case: one salmon carries it.
const conc = detourAdvice([row('Salmon', 28), row('Tea', 11.5), row('Quiche', 8.5),
  ...Array.from({ length: 21 }, (_, i) => row('x' + i, 0.4))]);
assert(conc, 'a concentrated saving should produce advice');
assert.strictEqual(conc.items.length, 3);
assert.strictEqual(conc.topTotal, 48);
assert.strictEqual(conc.restCount, 21);
assert(conc.share > 0.8, 'top 3 should carry most of it');

// 2. Saving spread evenly -> SILENT. There is no "these few" story to tell, and
//    picking the arbitrary top 3 would be advice the data does not support.
const flat = Array.from({ length: 30 }, (_, i) => row('i' + i, 2));
assert.strictEqual(detourAdvice(flat), null, 'evenly spread saving must stay silent');

// 3. Below the money floor -> silent, however concentrated. A $6 detour is not
//    worth a second shop no matter what share of the total it is.
assert.strictEqual(detourAdvice([row('a', 4), row('b', 1), row('c', 0.5)]), null,
  'a trivial total must stay silent');

// 4. Nothing to gain at all -> silent, including when the other store is dearer
//    (negative savings must never be presented as a saving).
assert.strictEqual(detourAdvice([]), null);
assert.strictEqual(detourAdvice(null), null);
assert.strictEqual(detourAdvice([row('a', -12), row('b', -3)]), null,
  'a dearer other store is not a detour');
// Losses must not be netted off against the wins either.
const mixed = detourAdvice([row('win1', 20), row('win2', 18), row('win3', 12), row('loss', -40)]);
assert(mixed && mixed.topTotal === 50, 'negative rows must be excluded, not subtracted');

// 5. Fewer than the cap is fine - one big item is a perfectly good answer.
const one = detourAdvice([row('Salmon', 28), row('tiny', 0.2)]);
assert(one && one.items.length === 2 && one.topTotal > 28);

// 6. Never proposes more than the cap, even when many items are worth moving.
//    (A flat 40-row list is the SPREAD case and correctly returns null - that is
//    covered by test 2. Here the saving is steep, so advice is expected.)
const many = detourAdvice([row('a', 60), row('b', 50), row('c', 40),
  ...Array.from({ length: 37 }, (_, i) => row('i' + i, 0.5))]);
assert(many, 'a steep distribution should still advise');
assert(many.items.length <= globalThis.DETOUR_MAX_ITEMS, 'must not exceed the cap');
assert.strictEqual(many.restCount, 37, 'everything past the cap counts as "the rest"');

// 7. The arithmetic it prints has to add up, or the verdict line lies.
assert(Math.abs(conc.topTotal + conc.restTotal - conc.total) < 0.01,
  'top + rest must equal total');
assert.strictEqual(conc.items.length + conc.restCount,
  [row('Salmon', 28), row('Tea', 11.5), row('Quiche', 8.5)].length + 21,
  'item counts must reconcile');

// 8. Sorted biggest-first, so "move these" moves the ones that matter.
const ordered = detourAdvice([row('small', 11), row('big', 30), row('mid', 20)]);
assert.deepStrictEqual(ordered.items.map(r => r.name), ['big', 'mid', 'small']);

console.log('detour_selfcheck: 8/8 OK');
