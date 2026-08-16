// Guards ONE invariant of the price-history modal for category rows:
//
//   the plotted SERIES and the "today" row must be in the SAME unit.
//
// buildGroupHistoryItem() builds the series by scaling each member's stored PACK
// price, but takes today's row straight from metricShown() - which quotes a
// weighed category per its `gramQuote` (100 or 1000 g) and a per-piece one per
// its piece quote. If the series scaling and metricShown() disagree, the newest
// point lands on a different scale from every older one and the chart reads as a
// huge overnight jump for a price that never moved.
//
// This has now bitten TWICE, in the two halves of the same expression:
//   - per-piece categories (fixed earlier; baby wipes showed $0.03 vs $10.00)
//   - weighed categories quoted per 100g (Aero Peppermint: today $4.24, every
//     earlier date $42.40 - a 10x phantom jump, and the modal titled "$/kg"
//     while plotting /100g numbers)
// $/kg is the default quote, so the weighed half stayed invisible until a
// category overrode it. Hence a check rather than a third fix.
//
// No framework, no deps. Run: node scripts/group_history_units_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const utilsSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');

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

// Real implementations of the scaling rules under test.
const realUtils = ['weightQuoteOf', 'weightQuoteSuffix', 'isWeighedGroup', 'pieceQuoteOf', 'metricShown']
  .map(n => extract(utilsSrc, n, 'utils.js')).join('\n');
const realBuild = extract(appSrc, 'buildGroupHistoryItem', 'app.js');

// Stubs for everything buildGroupHistoryItem touches that isn't the scaling rule.
const stubs = `
  const WEIGHT_QUOTES = [1000, 100];
  const PER_WEIGHT_QUOTE = 1000;
  const PER_PIECE_QUOTE = 1;
  function loadPerKgExclusions() { return new Set(); }
  function exclSetsFor() { return { ww: new Set(), co: new Set() }; }
  function packCountOf(n) { return (String(n).match(/(\\d+)\\s*pk/i) || [])[1] * 1 || 0; }
  function qtyPiecesPer(g) { return g && g._perPack ? pieceQuoteOf(g) : 1; }
  // price -> $/kg, i.e. exactly what clientPerKg/price gives for a real product.
  function perKgRatio(res) { return res && res.price && res._perKg ? res._perKg / res.price : null; }
`;

const sandbox = new Function(`${stubs}\n${realUtils}\n${realBuild}\nreturn { buildGroupHistoryItem, metricShown, weightQuoteOf, weightQuoteSuffix };`)();
const { buildGroupHistoryItem, metricShown } = sandbox;

// One member: a 118g block at $5.00 -> $42.37/kg.
function member(name, wwPrice, wwPerKg, coPrice, coPerKg, hist) {
  return {
    list_item: name,
    woolworths: wwPrice == null ? null : { price: wwPrice, _perKg: wwPerKg },
    coles: coPrice == null ? null : { price: coPrice, _perKg: coPerKg },
    price_history: [],
    ww_price_history: (hist || []).map(([date, price]) => ({ date, price })),
    coles_price_history: (hist || []).map(([date, price]) => ({ date, price })),
  };
}

function groupFor(gramQuote, opts) {
  const m = member('Choc Block 118g', 5.0, 42.4, 5.0, 42.4, [['2026-08-14', 5.0]]);
  return Object.assign({
    _groupKey: 'g', _groupLabel: 'G', _members: [m],
    _sticker: false, _perPack: false, gramQuote,
    _wwPerKg: 42.4, _coPerKg: 42.4,
    _wwBest: { result: {} }, _coBest: { result: {} },
  }, opts || {});
}

function check(label, cond, detail) {
  assert(cond, `${label}${detail ? '\n  ' + detail : ''}`);
  console.log('  ok  ' + label);
}

console.log('group history units:');

// THE regression. Per 100g: today and history must agree.
{
  const h = buildGroupHistoryItem(groupFor(100));
  const today = h.woolworths.price;
  const past = h.ww_price_history[0].price;
  check('per-100g category: today and history are the same scale',
    Math.abs(today - past) < 0.02,
    `today=${today} history=${past} (ratio ${(past / today).toFixed(2)}x)`);
  check('per-100g category: value really is per 100g, not per kg',
    Math.abs(past - 4.24) < 0.02, `got ${past}, expected ~4.24`);
  check('per-100g category is labelled $/100g, not $/kg',
    h._unitLabel === '$/100g', `got ${h._unitLabel}`);
}

// The default quote must be untouched by the fix.
{
  const h = buildGroupHistoryItem(groupFor(1000));
  const today = h.woolworths.price;
  const past = h.ww_price_history[0].price;
  check('per-kg category: today and history are the same scale',
    Math.abs(today - past) < 0.02, `today=${today} history=${past}`);
  check('per-kg category: value is per kg',
    Math.abs(past - 42.4) < 0.05, `got ${past}, expected ~42.4`);
  check('per-kg category is labelled $/kg', h._unitLabel === '$/kg', `got ${h._unitLabel}`);
}

// An unusable per-kg rate must DROP the point, never plot it at $0.00 - the
// reason the ratio is null-guarded instead of being multiplied inline.
{
  const m = member('No rate', 5.0, null, null, null, [['2026-08-14', 5.0]]);
  const g = groupFor(100, { _members: [m] });
  const h = buildGroupHistoryItem(g);
  check('member with no per-kg rate is dropped, not plotted at $0',
    !(h.ww_price_history || []).some(e => e.price === 0),
    JSON.stringify(h.ww_price_history));
}

// Sticker groups compare raw pack prices - the gram quote must not touch them.
{
  const h = buildGroupHistoryItem(groupFor(100, { _sticker: true }));
  check('sticker category still compares raw pack prices',
    Math.abs(h.ww_price_history[0].price - 5.0) < 0.001,
    `got ${h.ww_price_history[0].price}, expected 5.00`);
  check('sticker category has no unit label', h._unitLabel === null, `got ${h._unitLabel}`);
}

console.log('\nAll group-history unit self-checks passed.');
