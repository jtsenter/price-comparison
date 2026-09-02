// Self-check: the service worker's precache list must name the files the pages
// actually load.
//
// sw.js SHELL holds versioned URLs ('app.js?v=218'). The pages hold their own
// copies of those same URLs. Nothing kept the two in step, so bumping a file's
// ?v= in the HTML and forgetting sw.js left the worker precaching a URL no page
// ever requests - and NOT precaching the one it does. The install still
// succeeds (addAll fetches the stale URL happily, since the query string is
// decorative), so it fails silently: online everything looks fine, and the gap
// only shows up offline, where the app asks for app.js?v=218 and the cache has
// only app.js?v=208.
//
// Found three at once: app.js (sw said 208, pages said 217), header.js (26 vs
// 27) and history-modal.js (6 vs 9). Two of those had been wrong long enough
// that nobody could say when they drifted.
//
// Only this direction is asserted. A page asset missing from SHELL is a
// deliberate choice (SHELL is the offline shell, not an inventory), but a SHELL
// entry no page loads is always a mistake.
//
// Run: node scripts/sw_shell_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const docs = path.join(__dirname, '..', 'docs');
// Normalised: this text is matched with literal newlines below, and
// core.autocrlf=true checks the repo out as CRLF on Windows.
const read = (f) => fs.readFileSync(path.join(docs, f), 'utf8').replace(/\r\n/g, '\n');

const sw = read('sw.js');
const pages = fs.readdirSync(docs).filter(f => f.endsWith('.html'));
assert(pages.length, 'no pages found - this check would pass vacuously');
const html = pages.map(read).join('\n');

// The SHELL array only. A ?v= elsewhere in sw.js (a comment, say) is not a
// precache entry and must not be asserted on.
const shellSrc = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
assert(shellSrc, 'SHELL array not found in sw.js');
const versioned = [...shellSrc[1].matchAll(/'([^']*\?v=[^']*)'/g)].map(m => m[1]);
assert(versioned.length >= 5,
  `expected the shell to carry several versioned assets, found ${versioned.length}`);

const drifted = versioned.filter(u => !html.includes(u));
assert.deepStrictEqual(drifted, [],
  'sw.js precaches these, but no page loads them - bump them to the version the '
  + 'pages use:\n  ' + drifted.map(u => {
      const base = u.split('?')[0];
      const live = [...new Set([...html.matchAll(
        new RegExp(base.replace(/[.]/g, '\\.') + '\\?v=\\d+', 'g'))].map(m => m[0]))];
      return `${u}  ->  pages load ${live.join(', ') || '(nothing)'}`;
    }).join('\n  '));

console.log(`sw_shell_selfcheck: ${versioned.length} precached assets all match the pages`);
