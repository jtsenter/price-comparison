// Self-check for the category tab strip (style.css, .tabs-row .category-tabs).
//
// The report was "the New product button hides some of the category buttons".
// Nothing overlapped: .category-tabs is a flex:1 horizontal scroller and the
// buttons beside it are flex-shrink:0, so they never overlap by construction
// (measured: tabs end at 1025px, the button starts at 1033px). But the strip
// only gets the width the buttons leave, and eleven categories ran 51px past
// it at a 1265px viewport, so "Other" was clipped at the scroller's own edge -
// and since the button starts 8px later, the clip reads as the button covering
// it. The button has not moved since it was added; the category list outgrew
// the strip.
//
// The strip hides its scrollbar (scrollbar-width:none) and has no fade, so
// there was no hint the rest existed. Desktop therefore wraps instead.
//
// The risk worth pinning is SPECIFICITY: the base .category-tabs rule sets
// nowrap/auto, and it is the rule Hot Deals still needs. Desktop wrapping
// depends on `.tabs-row .category-tabs` (0,2,0) outranking `.category-tabs`
// (0,1,0). Raise the base rule's specificity, or drop the descendant, and the
// strip silently goes back to clipping.
//
// Run: node scripts/category_tabs_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const css = fs.readFileSync(path.join(__dirname, '..', 'docs', 'style.css'), 'utf8');
let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };

// Desktop: the row that carries the buttons wraps, so no chip is ever clipped.
const desktop = /\.tabs-row \.category-tabs \{[^}]*\}/.exec(css);
assert(desktop, '.tabs-row .category-tabs must exist - it is what makes desktop wrap');
assert(/flex-wrap: wrap/.test(desktop[0]),
  'the desktop strip must wrap, or a chip gets clipped at the scroller edge');
assert(/overflow-x: visible/.test(desktop[0]),
  'a wrapping strip must not also clip - overflow-x has to be released');
ok('the desktop category strip wraps instead of clipping');

// It must out-specify the base rule, which still says nowrap for Hot Deals.
const base = /(?:^|\n)\.category-tabs \{[^}]*\}/.exec(css);
assert(base && /flex-wrap: nowrap/.test(base[0]),
  'the base .category-tabs rule is still the scroller Hot Deals uses');
assert(!/\.tabs-row\.category-tabs|#\w+ \.category-tabs \{[^}]*flex-wrap: nowrap/.test(css),
  'nothing may out-specify .tabs-row .category-tabs with nowrap');
ok('the base scroller rule survives for the pages that still want it');

// Phone: back to one swipeable line. Eleven chips wrapped would cost three rows
// of a phone screen, and sideways is the expected gesture on this row.
// Located by its nearest ENCLOSING media query rather than by splitting the
// file: `@media (max-width: 700px)` opens nine separate blocks in this
// stylesheet, so a naive split-to-end-of-file happily matched the desktop rule
// from inside the first one.
const rules = [...css.matchAll(/\.tabs-row \.category-tabs \{[^}]*\}/g)];
const mobileRule = rules.find(m => /flex-wrap: nowrap/.test(m[0]));
assert(mobileRule, 'the phone must restore the single-line strip');
assert(/overflow-x: auto/.test(mobileRule[0]),
  'the phone strip must scroll on one line, not wrap');
const openers = [...css.slice(0, mobileRule.index).matchAll(/@media\s*\(([^)]*)\)/g)];
assert(openers.length, 'the phone rule must sit inside a media query, not at top level');
assert(/max-width:\s*700px/.test(openers[openers.length - 1][1]),
  `the phone rule must be inside the 700px query, found "${openers[openers.length - 1][1]}"`);
ok('the phone keeps one swipeable line, inside the 700px query');

// The buttons beside the strip must stay unshrinkable, which is what kept this
// a clipping bug rather than an actual overlap.
assert(/\.tabs-row-cols \{[^}]*flex-shrink: 0/.test(css),
  'the row buttons must not shrink into the strip');
ok('the row buttons stay out of the strip rather than overlapping it');

// ── New product belongs on the FILTER row, not beside the tabs ──────────────
// It is ~138px wide, and beside the tabs that width came straight out of the
// strip - which is what pushed the eleventh category off the end. The filter
// row has spare width at its right; the tabs row did not. Put it back and the
// strip goes ~50px over again.
const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
const tabsRow = /<div class="tabs-row">[\s\S]*?\n  <\/div>/.exec(html);
assert(tabsRow, '.tabs-row block not found in index.html');
assert(!/newProductBtn/.test(tabsRow[0]),
  'New product must not sit in the tabs row - it eats the category strip width');
const filterRow = /<div id="priorityFilter"[\s\S]*?\n  <\/div>/.exec(html);
assert(filterRow && /id="newProductBtn"/.test(filterRow[0]),
  'New product must live on the filter row');
// Outside .priority-pills on purpose: that container is display:none on a
// phone, and the button hides itself separately.
const pills = /<div class="priority-pills">[\s\S]*?\n    <\/div>/.exec(filterRow[0]);
assert(pills && !/newProductBtn/.test(pills[0]),
  'New product must sit outside .priority-pills, which is display:none on a phone');
assert(/#newProductBtn \{[^}]*margin-left: auto/.test(css),
  'New product must be pinned to the far right of the filter row');
ok('New product sits hard right on the filter row, clear of the category strip');

console.log(`\ncategory_tabs_selfcheck: ${n} checks passed`);
