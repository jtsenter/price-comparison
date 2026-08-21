// A list hidden on the Lists page gives up its main-screen filter pill, keeps
// everything else, and STAYS hidden across a reload.
//
// That last clause is the one that was broken. The flag first shipped as a
// `hidden` property ON the list object, which put it inside the user_settings
// `lists` map - and the main page merges that map repo-wins, per WHOLE list, on
// boot. The repo's copy carried no flag, so it replaced the local object
// outright and the pill was back on the next load. ("Why does Birthdays keep
// appearing after refresh?") Visibility now lives in its own per-device key, so
// there is no publish to race and no Pages-CDN lag window to lose it in.
//
// The narrowness is the other half of the feature, so it is pinned too: hiding
// must not touch membership, must not remove the list, and must leave every
// other list surface (the bulk "Add to list" menu, the Lists page itself)
// showing it. A "hide" that quietly unfiled a product would be data loss
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

// `const` declared inside eval() does not escape it, so both keys are read out
// of the source for the fixtures to use directly rather than relied on as
// bindings. (Same trap SCRAPE_MODE_DESC hit in scrape_mode_selfcheck.)
const LISTS_KEY_SRC = utilsSrc.match(/const LISTS_KEY\s*=\s*'([^']+)'/);
assert(LISTS_KEY_SRC, 'LISTS_KEY not found in utils.js');
const LISTS_KEY = LISTS_KEY_SRC[1];

const HIDDEN_KEY_SRC = utilsSrc.match(/const LIST_HIDDEN_KEY\s*=\s*'([^']+)'/);
assert(HIDDEN_KEY_SRC, 'LIST_HIDDEN_KEY not found in utils.js');
const LIST_HIDDEN_KEY = HIDDEN_KEY_SRC[1];
assert.notStrictEqual(LIST_HIDDEN_KEY, LISTS_KEY,
  'visibility must not share the synced lists key - that sharing IS the bug');

// saveLists reaches for a publisher that only exists on pages loading app.js.
global.scheduleListsPublish = () => {};

eval([LISTS_KEY_SRC[0] + ';', HIDDEN_KEY_SRC[0] + ';',
      extract(utilsSrc, 'loadLists', 'utils.js'),
      extract(utilsSrc, 'saveLists', 'utils.js'),
      extract(utilsSrc, 'loadHiddenLists', 'utils.js'),
      extract(utilsSrc, 'listShownOnMain', 'utils.js'),
      extract(utilsSrc, 'setListHidden', 'utils.js'),
      extract(utilsSrc, 'forgetListVisibility', 'utils.js'),
      extract(utilsSrc, 'setListMembership', 'utils.js'),
      extract(utilsSrc, 'listsForItem', 'utils.js')].join('\n'));

let n = 0;
const check = (label, fn) => { fn(); n++; console.log(`  ok  ${label}`); };

console.log('list visibility:');

const seed = () => {
  store[LISTS_KEY] = JSON.stringify({
    bbq:  { label: 'BBQ',  items: ['Beef Sausages 1kg', 'Bread Rolls 6pk'] },
    baby: { label: 'Baby', items: ['Nappies Size 6'] },
  });
  store[LIST_HIDDEN_KEY] = '[]';
};

// ── The default: nothing to migrate ─────────────────────────────────────────
seed();
check('a list nobody has hidden is shown', () => {
  assert.strictEqual(listShownOnMain('bbq'), true);
});
check('an unknown key is shown, not hidden', () => {
  assert.strictEqual(listShownOnMain('never-seen'), true);
  assert.strictEqual(listShownOnMain(undefined), true);
});
check('a corrupt or missing hidden-set reads as "nothing hidden"', () => {
  store[LIST_HIDDEN_KEY] = '{not json';
  assert.strictEqual(listShownOnMain('bbq'), true);
  store[LIST_HIDDEN_KEY] = '{"bbq":true}';   // wrong shape, not an array
  assert.strictEqual(listShownOnMain('bbq'), true);
  seed();
});

// ── Hiding is display-only ──────────────────────────────────────────────────
setListHidden('bbq', true);
check('hiding takes the pill away', () => {
  assert.strictEqual(listShownOnMain('bbq'), false);
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
  assert.strictEqual(listShownOnMain('baby'), true);
});
check('a hidden list still accepts new products', () => {
  setListMembership('Charcoal 4kg', 'bbq', true);
  assert.ok(loadLists().bbq.items.includes('Charcoal 4kg'));
  assert.strictEqual(listShownOnMain('bbq'), false, 'and stays hidden');
});

// ── THE regression: it has to survive the sync ──────────────────────────────
check('visibility never writes into the map that syncs to the repo', () => {
  seed();
  const before = store[LISTS_KEY];
  setListHidden('bbq', true);
  setListHidden('no-such-list', true);
  assert.strictEqual(store[LISTS_KEY], before,
    'anything stored on the list object rides into user_settings.json and gets merged away');
});
check('the flag survives the repo-wins merge that used to wipe it', () => {
  seed();
  setListHidden('bbq', true);
  // The main page's owner branch, verbatim: merge(mine, theirs) = {...mine, ...theirs},
  // per WHOLE list. The repo has never heard of the flag.
  const remote = { bbq: { label: 'BBQ', items: ['Beef Sausages 1kg'] } };
  store[LISTS_KEY] = JSON.stringify({ ...loadLists(), ...remote });
  assert.strictEqual(listShownOnMain('bbq'), false,
    'hiding must not depend on the repo having heard about it');
});

// ── Unhiding, and the stored shape ──────────────────────────────────────────
check('unhiding restores the pill', () => {
  seed();
  setListHidden('bbq', true);
  setListHidden('bbq', false);
  assert.strictEqual(listShownOnMain('bbq'), true);
});
check('unhiding DROPS the key rather than storing false', () => {
  assert.deepStrictEqual(JSON.parse(store[LIST_HIDDEN_KEY]), [],
    'absent means shown; the set must not accumulate dead entries');
});
check('toggling is idempotent - hide, hide, show lands on shown', () => {
  setListHidden('bbq', true); setListHidden('bbq', true); setListHidden('bbq', false);
  assert.strictEqual(listShownOnMain('bbq'), true);
});
check('deleting a list forgets its visibility, so a reused slug is not born hidden', () => {
  setListHidden('bbq', true);
  forgetListVisibility('bbq');
  assert.strictEqual(listShownOnMain('bbq'), true);
  seed();
});

// ── The Lists page must publish, or the edit is lost the same way ───────────
check('saveLists publishes from pages that do not load app.js', () => {
  // "other pages just write locally" was silently lossy: index.html's boot merge
  // is repo-wins per whole list, so a rename or a membership tick made on the
  // Lists page was reverted by the repo's older copy on the next visit.
  const save = extract(utilsSrc, 'saveLists', 'utils.js');
  assert.ok(/scheduleUserSettingsSync\(\); return;/.test(save),
    'index.html still owns the full settings publish');
  assert.ok(/scheduleListsPublish\(\)/.test(save),
    'every other page must publish the lists key itself');
});
check('the standalone publish touches ONLY the lists key', () => {
  const pub = extract(utilsSrc, 'publishListsToRepo', 'utils.js');
  assert.ok(/githubGetJson\(s, 'docs\/data\/user_settings\.json'\)/.test(pub),
    'must read-modify-write, not overwrite the file');
  assert.ok(/remote\.lists = /.test(pub), 'must replace only .lists');
  assert.ok(/if \(!s\.token\) return;/.test(pub),
    'a viewer has no token and must stay local, exactly as before');
  assert.ok(/REMOVED_ITEMS\.has\(n\)/.test(pub),
    'a tombstoned product must not ride back into the repo inside a membership array');
});
check('a pending publish is flushed when the page goes away', () => {
  // The very next thing you do after hiding a filter is navigate to the main
  // screen; navigation kills the debounce timer.
  assert.ok(/addEventListener\('pagehide'/.test(utilsSrc), 'no pagehide flush');
  assert.ok(/_listsPublishTimer\) publishListsToRepo\(\)/.test(utilsSrc),
    'the flush must only fire when a write is actually pending');
});

// ── The two renderings of the same key set ──────────────────────────────────
{
  const pills = extract(appSrc, 'renderListPills', 'app.js');
  check('the pill row filters on visibility, by KEY', () => {
    assert.ok(/listShownOnMain\(k\)/.test(pills));
    assert.ok(!/listShownOnMain\(all\[k\]\)/.test(pills),
      'passing the list object would silently always answer "shown"');
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
  assert.ok(/Hide the .* filter from the main screen/.test(listsSrc)
         && /Show the .* filter on the main screen/.test(listsSrc),
    'the label must name the action, not the current state');
});
check('the icon-only toggle is still readable without sight of it', () => {
  // An eye that only swaps its glyph says nothing to a screen reader, and a
  // title alone is not an accessible name on a button with no text.
  assert.ok(/aria-label="\$\{escAttr\(label\)\}"/.test(listsSrc), 'no aria-label on the eye');
  assert.ok(/aria-pressed="\$\{shown\}"/.test(listsSrc), 'toggle state must reach assistive tech');
  assert.ok(/EYE_OFF\b/.test(listsSrc) && /\$\{shown \? EYE : EYE_OFF\}/.test(listsSrc),
    'the icon must reflect the state, not stay fixed');
});
check('toggling keeps keyboard focus on the row it was pressed on', () => {
  // renderCustom() replaces the card, so without this a keyboard user is
  // dumped back to <body> after every single toggle.
  assert.ok(/\.lvis`\)\?\.focus\(\)/.test(listsSrc), 'focus is not restored after the re-render');
});
check('the frequency card holds the eye column open so the two line up', () => {
  assert.ok(/lvis-spacer/.test(listsSrc),
    'built-in rows need the same leading column or the names step sideways between cards');
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
  assert.ok(/setListHidden\(key, listShownOnMain\(key\)\)/.test(listsSrc),
    'a hardcoded value makes the button one-way');
});
check('deleting a list clears its visibility flag on the page too', () => {
  assert.ok(/forgetListVisibility\(key\)/.test(listsSrc),
    'the flag outlives the list otherwise, and listKeyFor reuses freed slugs');
});

console.log(`\nlist_visibility_selfcheck: all ${n} assertions passed.`);
