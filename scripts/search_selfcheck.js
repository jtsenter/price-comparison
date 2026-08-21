// A row must be findable by the words printed on it.
//
// The reported failure, exactly: typing f-i-s-h into the search box. "Basa Fish
// Fillets" survived "fi" and vanished at "fis" - while still reading "Fish" on
// screen - and "Barramundi Fish" survived, so the box looked like it was doing
// something clever about fish when it was doing nothing of the kind.
//
// Cause: the filter tested `override || list_item`, and for a CATEGORY row
// list_item is the internal `__group_<key>` SLUG. The slug is a snapshot of the
// label taken at creation, so it matched by luck and nothing else:
//
//   Barramundi Fish  -> __group_barramundi_fish   contains "fish"  -> found
//   Basa Fish Fillets-> __group_basa_fillets      contains "fi"    -> found at
//                                                 "fi", lost at "fis"
//   Salmon Fish      -> __group_salmon            contains neither -> never found,
//                                                 because renaming a category
//                                                 does not rewrite its slug
//
// The SORT has read the displayed label since the A-Z fix; the search was never
// brought along. These pin them together.
//
// No framework, no deps. Run: node scripts/search_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

function extract(src, name, where) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in ${where}`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

// stripWW is a const arrow, not a declaration, so it is lifted by pattern and
// injected verbatim - the real one, so a change to how the store prefix is
// stripped is caught here rather than on screen.
const STRIP_WW_SRC = utilsSrc.match(/const stripWW = [^;]+;/);
assert(STRIP_WW_SRC, 'stripWW not found in utils.js');

global.window = { PW_NAME_MAP: {} };
const sandbox = new Function(`
  ${STRIP_WW_SRC[0]}
  ${extract(appSrc, 'searchTerms', 'app.js')}
  ${extract(appSrc, 'nameMatchesSearch', 'app.js')}
  ${extract(appSrc, 'searchHaystack', 'app.js')}
  return { searchTerms, nameMatchesSearch, searchHaystack };
`)();
const { searchTerms, nameMatchesSearch, searchHaystack } = sandbox;

let n = 0;
const check = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };

// The three real categories from the report, with their real slugs.
const member = name => ({ list_item: name });
const cat = (label, key, members) => ({
  _isGroup: true, _groupLabel: label, _groupKey: key,
  list_item: '__group_' + key,
  _members: members.map(member),
});

const basa = cat('Basa Fish Fillets', 'basa_fillets',
  ['Woolworths Basa Fillets Boneless With Skin Off']);
const barra = cat('Barramundi Fish', 'barramundi_fish',
  ['Thawed Barramundi Fillets Thawed Fillets 250g', 'Barramundi Portions Skin On 230g',
   "Kb's Barramundi Fillets 1kg", 'Coles Barramundi Portions Skin On 600g']);
const salmon = cat('Salmon Fish', 'salmon',
  ['Tassal Atlantic Salmon Skin On 300g', 'Woolworths Salmon Portions Skin On',
   'Coles Tasmanian Salmon Portions Skin Off 460g']);

const finds = (row, q, ovr = {}) => nameMatchesSearch(searchHaystack(row, ovr), searchTerms(q));

console.log('search:');

// ── The reported keystrokes ─────────────────────────────────────────────────
check('typing f-i-s-h never loses a row that says "Fish"', () => {
  for (const row of [basa, barra, salmon]) {
    for (const q of ['f', 'fi', 'fis', 'fish']) {
      assert.ok(finds(row, q),
        `"${row._groupLabel}" disappeared at "${q}" - it is on screen reading Fish`);
    }
  }
});

check('a category whose slug shares no letters with its label is still found', () => {
  // __group_salmon contains neither "fis" nor "fish": this is the rename case.
  assert.ok(!salmon.list_item.includes('fis'), 'fixture must keep the slug mismatched');
  assert.ok(finds(salmon, 'fish'));
});

check('renaming a category does not have to touch its slug to work', () => {
  const renamed = { ...cat('Barramundi Fish', 'barramundi_fish', ['Barramundi Portions Skin On 230g']),
                    _groupLabel: 'Sea Bass Dinner' };
  assert.ok(finds(renamed, 'sea bass'), 'the new label must be searchable immediately');
});

// ── Categories are findable by what is IN them ──────────────────────────────
check('a category is found by a product it contains', () => {
  assert.ok(finds(salmon, 'tassal'), 'the Salmon row is the only row holding the Tassal packs');
});
check('a product search does not drag in unrelated categories', () => {
  assert.ok(!finds(salmon, 'barramundi'));
  assert.ok(!finds(barra, 'tassal'));
});

// ── Plain rows: a rename ADDS a name, it does not replace one ───────────────
const plain = { list_item: 'Woolworths Basa Fillets Boneless With Skin Off' };
check('a plain row is found by its raw name', () => {
  assert.ok(finds(plain, 'basa'));
  assert.ok(finds(plain, 'woolworths basa'));
});
check('a plain row is found by its stripped display name', () => {
  // stripWW drops the store prefix, which is what the row actually prints.
  assert.ok(finds(plain, 'fillets boneless'));
});
check('a renamed row is findable by BOTH the new name and the original', () => {
  const ovr = { 'Woolworths Basa Fillets Boneless With Skin Off': { displayName: 'Basa Fish' } };
  assert.ok(finds(plain, 'fish', ovr), 'the rename must be searchable');
  assert.ok(finds(plain, 'boneless', ovr),
    'an override is another handle on a product, not a denial of the store name');
});
check('the name map is searchable too', () => {
  global.window.PW_NAME_MAP = { 'Woolworths Basa Fillets Boneless With Skin Off': 'Basa Fish' };
  assert.ok(finds(plain, 'basa fish'));
  global.window.PW_NAME_MAP = {};
});

// ── Multi-term and negative cases ───────────────────────────────────────────
check('all terms must match, in any order', () => {
  assert.ok(finds(salmon, 'salmon fish'));
  assert.ok(finds(salmon, 'fish salmon'));
  assert.ok(!finds(salmon, 'salmon chicken'));
});
check('an empty query matches everything (the filter is skipped upstream)', () => {
  assert.ok(finds(salmon, ''));
});
check('a row is NOT found by its internal slug punctuation', () => {
  // Nobody types "__group_"; matching it would surface every category at once.
  assert.ok(!finds(salmon, '__group_'), 'the slug must not be part of the haystack');
});

// ── The two call sites must agree ───────────────────────────────────────────
check('the row filter and the no-results log share one haystack', () => {
  // They diverged before: the log only ever looked at raw products, so a search
  // that matched a category LABEL got filed as "a product you do not track"
  // while the matching row sat on screen.
  const filter = appSrc.slice(appSrc.indexOf('// Search query filter'));
  assert.ok(/nameMatchesSearch\(searchHaystack\(i, ovr\), terms\)/.test(filter),
    'the row filter must use searchHaystack');
  const log = extract(appSrc, 'maybeLogNoResults', 'app.js');
  assert.ok(/searchHaystack\(i, ovr\)/.test(log) && /searchHaystack\(g, ovr\)/.test(log),
    'the miss log must check products AND category labels through the same haystack');
});
check('nothing still filters on the bare list_item', () => {
  assert.ok(!/nameMatchesSearch\(ovr\[i\.list_item\]\?\.displayName \|\| i\.list_item, terms\)/.test(appSrc),
    'that expression is the bug: for a category it tests the internal slug');
});

console.log(`\nsearch_selfcheck: all ${n} assertions passed.`);
