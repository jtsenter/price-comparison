// Self-check for the quick/full DEFAULT rule (utils.js half).
// Run: node scripts/scrape_mode_selfcheck.js
//
// The rule: quick by default, except the first run of an ISO week from Wednesday
// onward, which is full. The failure that matters is a full scrape that never
// happens - the long tail then goes unchecked indefinitely and nothing says so.
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

let store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
// eslint-disable-next-line no-eval
eval([exc('FULL_SCRAPE_WEEKDAY'), ex('isoWeekKey'), ex('lastFullScrapeWeek'),
      ex('markFullScrapeDone'), ex('defaultScrapeMode')].join('\n'));

// 1. ISO weeks: Thursday-based, so the turn of the year does not split a week.
assert.strictEqual(isoWeekKey(new Date(2026, 0, 1)), '2026-W01');
assert.strictEqual(isoWeekKey(new Date(2025, 11, 29)), '2026-W01', 'Mon 29 Dec 2025 is ISO 2026-W01');
assert.strictEqual(isoWeekKey(new Date(2026, 7, 10)), '2026-W33');
// Every day of one week shares a key - otherwise "already done this week" breaks
// the moment you cross a midnight.
const wk = new Date(2026, 7, 10);  // Monday
const keys = new Set();
for (let i = 0; i < 7; i++) keys.add(isoWeekKey(new Date(2026, 7, 10 + i)));
assert.strictEqual(keys.size, 1, 'a single ISO week must yield one key');

// 2. Before Wednesday -> quick, even with no full scrape recorded at all.
store = {};
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 10)).mode, 'quick', 'Monday -> quick');
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 11)).mode, 'quick', 'Tuesday -> quick');

// 3. Wednesday onward with none done this week -> full.
for (const [d, label] of [[12, 'Wed'], [13, 'Thu'], [15, 'Sat'], [16, 'Sun']]) {
  store = {};
  assert.strictEqual(defaultScrapeMode(new Date(2026, 7, d)).mode, 'full', label + ' -> full');
}

// 4. Once a full run is stamped, the SAME week drops back to quick. Without this
//    every later click that week would re-run the 20-minute scrape.
store = {};
markFullScrapeDone(new Date(2026, 7, 12));       // Wednesday
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 12)).mode, 'quick', 'same day after full -> quick');
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 14)).mode, 'quick', 'later that week -> quick');

// 5. ...and the NEXT week is due again.
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 19)).mode, 'full', 'next Wednesday -> full again');

// 6. A stamp from an older week must not satisfy this week.
store = {};
markFullScrapeDone(new Date(2026, 6, 1));
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 12)).mode, 'full', 'a stale stamp must not count');

// 7. Corrupt or absent storage degrades to "full is due" rather than silently
//    never sweeping.
global.localStorage.getItem = () => { throw new Error('blocked'); };
assert.strictEqual(defaultScrapeMode(new Date(2026, 7, 12)).mode, 'full',
  'unreadable storage must still allow the weekly full run');
global.localStorage.getItem = k => (k in store ? store[k] : null);

// 8. Every answer carries a reason - the menu shows it, so it must never be blank.
store = {};
for (const d of [new Date(2026, 7, 10), new Date(2026, 7, 12)]) {
  assert(defaultScrapeMode(d).reason.length > 10, 'reason text must be usable in the menu');
}

// 9. The refresh button's hover text (app.js half) - names WHICH scrape a plain
// click is about to run, not just why. Pulled from app.js the same way the rest
// of this file pulls from utils.js: defaultScrapeMode is already in scope above.
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
function exApp(n) {
  const at = appSrc.indexOf('function ' + n + '(');
  assert(at !== -1, 'missing ' + n + ' in app.js');
  let i = appSrc.indexOf('{', at), d = 0;
  for (let j = i; j < appSrc.length; j++) {
    if (appSrc[j] === '{') d++; else if (appSrc[j] === '}' && --d === 0) return appSrc.slice(at, j + 1);
  }
}
// const/let bindings made inside eval() never escape it, even as direct eval -
// only var does. Rewritten to globalThis. so SCRAPE_MODE_DESC is still reachable
// after this eval call ends, same trick exc() uses above for utils.js consts.
const modeDescSrc = appSrc.match(/const SCRAPE_MODE_DESC\s*=\s*\{[^}]+\};/)[0]
  .replace(/^const\s+/, 'globalThis.');
// eslint-disable-next-line no-eval
eval([modeDescSrc, exApp('refreshTooltipText')].join('\n'));

store = {};
const wedFull = refreshTooltipText(new Date(2026, 7, 12));
assert(/^Full scrape/.test(wedFull), 'Wednesday with none done -> tooltip must say Full: ' + wedFull);
assert(wedFull.includes(SCRAPE_MODE_DESC.full), 'must name what a full scrape covers');

const monQuick = refreshTooltipText(new Date(2026, 7, 10));
assert(/^Quick scrape/.test(monQuick), 'Monday -> tooltip must say Quick: ' + monQuick);
assert(monQuick.includes(SCRAPE_MODE_DESC.quick), 'must name what a quick scrape covers');
assert(monQuick.includes(defaultScrapeMode(new Date(2026, 7, 10)).reason),
  'must also carry the WHY, not just the WHAT');

console.log('scrape_mode_selfcheck.js: 11/11 OK');
