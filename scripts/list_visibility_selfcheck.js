// A list hidden on the Lists page gives up its main-screen filter pill and
// nothing else.
//
// The narrowness IS the feature, so it is what this pins down: hiding must not
// touch membership, must not remove the list, and must leave every OTHER list
// surface (the bulk "Add to list" menu, the Lists page itself) showing it. A
// "hide" that quietly stopped a product counting as filed would be a data loss
// wearing a display-preference costume.
//
// Also guards the stale-option trap: the pill row and the mobile <select> are
// two renderings of one list of keys, and the <select> half used to be skipped
// by an early return - so the last list's option outlived its pill and stayed
// selectable, filtering the table with nothing on screen saying so.
//
// No framework, no deps. Run: node scripts/list_visibility_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
const listsSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'lists.html'), 'utf8');

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

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

// `const` declared inside eval() does not escape it, so the key is read out of
// the source for the seed helper to use directly rather than relied on as a
// binding. (Same trap SCRAPE_MODE_DESC hit in scrape_mode_selfcheck.)
const LISTS_KEY_SRC = utilsSrc.match(/const LISTS_KEY\s*=\s*'([^']+)'/);
assert(LISTS_KEY_SRC, 'LISTS_KEY not found in utils.js');
const LISTS_KEY = LISTS_KEY_SRC[1];
eval([LISTS_KEY_SRC[0] + ';',
      extract(utilsSrc, 'loadLists', 'utils.js'),
      extract(utilsSrc, 'saveLists', 'utils.js'),
      extract(utilsSrc, 'listShownOnMain', 'utils.js'),
      extract(utilsSrc, 'setListHidden', 'utils.js'),
      extract(utilsSrc, 'setListMembership', 'utils.js'),
      extract(utilsSrc, 'listsForItem', 'utils.js')].join('\n'));

let n = 0;
const check = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };

console.log('list visibility:');

const seed = () => {
  store[LISTS_KEY] = JSON.stringify({
    bbq:   { label: 'BBQ',   items: ['Beef Sausages 1kg', 'Bread Rolls 6pk'] },
    baby:  { label: 'Baby',  items: ['Nappies Size 6'] },
  });
};

// ── The default: nothing to migrate ─────────────────────────────────────────
seed();
check('a list with no flag is shown - lists made before this existed stay visible', () => {
  assert.strictEqual(listShownOnMain(loadLists().bbq), true);
});
check('a missing list is not treated as shown', () => {
  assert.strictEqual(listShownOnMain(undefined), true, 'no list at all is a caller bug, not a hidden list');
});

// ── Hiding is display-only ──────────────────────────────────────────────────
setListHidden('bbq', true);
check('hiding sets the flag', () => {
  assert.strictEqual(listShownOnMain(loadLists().bbq), false);
});
check('hiding keeps the list itself', () => {
  assert.ok(loadLists().bbq, 'the list must still exist');
  assert.strictEqual(loadLists().bbq.label, 'BBQ');
});
check('hiding keeps every product in it', () => {
  assert.deepStrictEqual(loadLists().bbq.items, ['Beef Sausages 1kg', 'Bread Rolls 6pk']);
});
check('a product in a hidden list still counts as filed there', () => {
  assert.deepStrictEqual(listsForItem('Beef Sausages 1kg'), ['bbq']);
});
check('hiding one list leaves its siblings alone', () => {
  assert.strictEqual(listShownOnMain(loadLists().baby), true);
});
check('a hidden list still accepts new products', () => {
  setListMembership('Charcoal 4kg', 'bbq', true);
  assert.ok(loadLists().bbq.items.includes('Charcoal 4kg'));
  assert.strictEqual(listShownOnMain(loadLists().bbq), false, 'and stays hidden');
});

// ── Unhiding, and the stored shape ──────────────────────────────────────────
setListHidden('bbq', false);
check('unhiding restores the pill', () => {
  assert.strictEqual(listShownOnMain(loadLists().bbq), true);
});
check("unhiding CLEARS the key rather than storing false", () => {
  assert.ok(!('hidden' in loadLists().bbq),
    'absent means shown; a lingering hidden:false reads as if it meant something');
});
check('toggling is idempotent - hide, hide, show lands on shown', () => {
  setListHidden('bbq', true); setListHidden('bbq', true); setListHidden('bbq', false);
  assert.strictEqual(listShownOnMain(loadLists().bbq), true);
});
check('setting the flag on a list that does not exist creates nothing', () => {
  const before = Object.keys(loadLists()).sort();
  setListHidden('no-such-list', true);
  assert.deepStrictEqual(Object.keys(loadLists()).sort(), before);
});

// ── The two renderings of the same key set ──────────────────────────────────
{
  const pills = extract(appSrc, 'renderListPills', 'app.js');
  check('the pill row filters on visibility', () => {
    assert.ok(/listShownOnMain\(all\[k\]\)/.test(pills));
  });
  check('the mobile dropdown is built from the SAME filtered keys', () => {
    // Both loops read `keys`; a second, unfiltered source here is how the two
    // would drift into offering different filters.
    const dropdown = pills.slice(pills.indexOf("$('freqSelect')"));
    assert.ok(/for \(const k of keys\)/.test(dropdown), 'dropdown must iterate the filtered keys');
    assert.ok(!/Object\.keys\(all\)/.test(dropdown), 'dropdown must not re-read every list');
  });
  check('the stale-optgroup removal is NOT behind an early return', () => {
    // The removal has to run when nothing is visible - that is exactly the case
    // that leaves an orphaned option behind.
    const beforeSelect = pills.slice(0, pills.indexOf("$('freqSelect')"));
    assert.ok(!/if \(!keys\.length\) return;/.test(beforeSelect),
      'hiding every list must still clear the dropdown group');
  });
  check('a list selection is only re-asserted if its option still exists', () => {
    assert.ok(/querySelector\(`option\[value="\$\{CSS\.escape\(_activePriority\)\}"\]`\)/.test(pills),
      'assigning .value to a removed option blanks the select while the table stays filtered');
  });
}

// ── The Lists page control ──────────────────────────────────────────────────
check('the Lists page offers the toggle and labels it by what it will do', () => {
  assert.ok(/data-act="vis"/.test(listsSrc), 'no visibility button on the row');
  assert.ok(/Hide filter/.test(listsSrc) && /Show filter/.test(listsSrc),
    'the button must name the action, not the current state');
});
check('the toggle is not owner-gated', () => {
  // Walk back to the button's own opening tag rather than matching a fixed
  // window - the title text is a multi-line template expression, so any byte
  // count here would fail for the wrong reason the moment the wording changed.
  const at = listsSrc.indexOf('data-act="vis"');
  assert.notStrictEqual(at, -1, 'visibility button not found');
  const openTag = listsSrc.slice(listsSrc.lastIndexOf('<button', at), at);
  assert.ok(!/owner-only/.test(openTag),
    'hiding a filter chip changes no product data and is one click to undo');
});
check('the toggle flips relative to the CURRENT state, not a hardcoded true', () => {
  assert.ok(/setListHidden\(key, listShownOnMain\(all\[key\]\)\)/.test(listsSrc),
    'a hardcoded value makes the button one-way');
});

console.log(`\nlist_visibility_selfcheck: all ${n} assertions passed.`);
