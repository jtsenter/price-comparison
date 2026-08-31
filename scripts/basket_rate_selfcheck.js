// Self-check for the basket's per-product ranking (scrape-log.html, "The basket").
//
// The list is headed "biggest gap first", and it was ranking on sameQtyCost -
// the rival restated at the WOOLWORTHS PACK quantity. That is the right measure
// for the basket total, and the wrong one for ranking products against each
// other, because the quantity is whatever the WW pack happens to be and so
// differs on every row. On the live file it takes 48 distinct values from 12g
// (dried thyme) to 3029g (milk), so the sort was comparing a gap measured on
// 12g of herbs against one measured on 3kg of milk, and reporting the winner.
//
// Concretely, the four rows at the top of the list read:
//   RSPCA Chicken Breast   $12.00 / $28.10   gap $16.10   (per 1000g)
//   Basa Fillets           $11.00 / $23.10   gap $12.10   (per 1000g)
//   Inglewood Chicken      $13.00 / $23.07   gap $10.07   (per  650g)
//   Odd Bunch Zucchini      $2.90 / $11.15   gap  $8.25   (per  743g)
// Four different denominators, presented as one ranking.
//
// Run: node scripts/basket_rate_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'docs', 'scrape-log.html'), 'utf8');
const utils = fs.readFileSync(path.join(root, 'docs', 'utils.js'), 'utf8');

function ex(text, name) {
  const at = text.indexOf('function ' + name + '(');
  assert(at !== -1, `${name} not found`);
  let depth = 0;
  for (let j = text.indexOf('{', at); j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(at, j + 1);
  }
  throw new Error('unbalanced braces in ' + name);
}
/* eslint-disable no-eval */
eval(ex(utils, 'clientPer100'));
eval(ex(utils, 'per100Pair'));
eval(ex(utils, 'sameQtyCost'));
eval(ex(utils, 'fmtUnitMetric'));
eval(ex(utils, 'fmt'));
eval(ex(utils, 'metricRound'));
eval(ex(utils, 'metricShown'));
eval(ex(utils, 'pieceQuoteOf'));
eval(ex(utils, 'pieceQuoteSuffix'));
eval(ex(utils, 'weightQuoteOf'));
eval(ex(utils, 'weightQuoteSuffix'));
eval(ex(utils, 'isWeighedGroup'));
// `const` inside a direct eval is scoped to that eval, so the already-eval'd
// functions would not see these. Bind them on globalThis, which they do reach.
for (const name of ['PIECE_QUOTES', 'PER_PIECE_QUOTE', 'WEIGHT_QUOTES',
                    'PER_WEIGHT_QUOTE', 'UNIT_METRIC_3DP_BELOW']) {
  const m = new RegExp(`const ${name} = ([^;]+);`).exec(utils);
  assert(m, `${name} not found in utils.js`);
  globalThis[name] = eval('(' + m[1] + ')');
}

// The page's own normaliser, mirrored: metricShown's perPack branch tests the
// RESOLVED (_perPack) shape only, and loadVariantGroups hands back the seed
// shape, so a seed group dropped through to the weighed branch.
const resolved = (g) => ({
  _perPack: !!(g._perPack ?? g.perPack), _sticker: !!(g._sticker ?? g.sticker),
  _quote: g._quote ?? g.quote, _gramQuote: g._gramQuote ?? g.gramQuote,
});

let n = 0;
const ok = (msg) => { n++; console.log('  ok  ' + msg); };

// ── The ranking metric is a rate, not a pack cost ───────────────────────────
// Rebuild the four real rows and check the order changes to the per-kg one.
const mk = (name, wwPrice, wwName, wwUnit, wwUp, coPrice, coName) => ({
  list_item: name,
  woolworths: { price: wwPrice, name: wwName, unit: wwUnit, unit_price: wwUp },
  coles: { price: coPrice, name: coName },
});

// Real values from docs/data/latest.json.
const rows = [
  mk('Woolworths RSPCA Approved Chicken Breast Fillet', 12.0,
     'Woolworths RSPCA Approved Chicken Breast Fillet', '1KG', 12.0,
     16.88, 'Coles RSPCA Approved Free Range Chicken Breast Fillet Small Pack approx. 600g'),
  mk('Woolworths Basa Fillets Boneless With Skin Off', 11.0,
     'Basa Thawed Freshwater Basa Fillets', '1KG', 11.0,
     6.0, 'Basa Portions Skin Off 2 Pack 260g'),
  mk('Inglewood Farms Chicken Thigh Fillets Skin Off', 13.0,
     'Macro Chicken Thigh Fillets Free Range', '1KG', 20.0,
     15.09, 'Chicken Thigh Fillets Skin Off 425g'),
  mk('The Odd Bunch Zucchini Prepacked', 2.9,
     'The Odd Bunch Zucchini Prepacked', '1KG', 3.87,
     7.5, 'Zucchini 500g'),
];

// Mirrors buildStorePanel: a category's own quote where there is one, $/100g
// otherwise (a weighed shape with a 100g quote).
function quoteRow(i, group) {
  const r = per100Pair(i.woolworths, i.coles);
  const shape = group ? resolved(group) : { _gramQuote: 100 };
  const metricOf = (res) => clientPer100(res).value != null
    ? +(clientPer100(res).value * 10).toFixed(2) : null;
  const mw = (!group && r.ww.value == null) ? null : metricOf(i.woolworths);
  const mc = (!group && r.coles.value == null) ? null : metricOf(i.coles);
  const pair = mw != null && mc != null;
  const q = sameQtyCost(i.woolworths.price, i.coles.price, r.ww.value, r.coles.value);
  const qw = pair ? metricShown(shape, mw) : q.ww;
  const qc = pair ? metricShown(shape, mc) : q.co;
  const lo = Math.min(qw, qc), hi = Math.max(qw, qc);
  return {
    name: i.list_item, quoteWw: pair ? qw : null, quoteCo: pair ? qc : null,
    unit: !pair ? '' : shape._perPack ? pieceQuoteSuffix(pieceQuoteOf(shape))
      : shape._sticker ? '' : weightQuoteSuffix(weightQuoteOf(shape)),
    packDiff: q.co - q.ww,
    gapPct: lo > 0 ? (hi / lo - 1) * 100 : 0,
    impliedQty: r.ww.value > 0 ? i.woolworths.price / r.ww.value * 100 : null,
  };
}
const built = rows.map(i => quoteRow(i, null));

// THE BUG: the old comparison used a different denominator on every row.
const qtys = built.map(b => Math.round(b.impliedQty));
assert(new Set(qtys).size > 1,
  'fixture must reproduce the mixed denominators, got ' + JSON.stringify(qtys));
ok(`the pack comparison really does use different quantities per row (${qtys.join('g, ')}g)`);

// Every one of these four is a weight item, so all four must carry a quote.
assert(built.every(b => b.quoteWw != null), 'all four rows must be quoted');
ok('a weight item at both stores gets a quoted rate');

// UNGROUPED products are quoted per 100g - the unit the main table prints under
// every price - not per kg. A blanket $/kg is what produced "$220.00/kg" for
// dried dill, a quantity of dill nobody has ever held.
assert(built.every(b => b.unit === '/100g'),
  `an ungrouped weight product is quoted per 100g, got ${built.map(b => b.unit)}`);
assert(Math.abs(built[0].quoteWw - 1.20) < 0.005,
  `WW chicken breast is $1.20/100g, got ${built[0].quoteWw}`);
assert(Math.abs(built[0].quoteCo - 2.81) < 0.01,
  `Coles chicken breast is $2.81/100g, got ${built[0].quoteCo}`);
ok('an ungrouped product is quoted per 100g, like the main table');

// A product IN a category takes that category's quote instead. Meat is quoted
// per kilo, which is how meat is actually bought.
{
  const perKg = quoteRow(rows[0], { key: 'chicken_breast', items: [], gramQuote: 1000 });
  assert.strictEqual(perKg.unit, '/kg', 'a weighed category with a 1000g quote reads /kg');
  assert(Math.abs(perKg.quoteWw - 12.00) < 0.005,
    `per kg the WW figure is $12.00, got ${perKg.quoteWw}`);
  ok('a product in a weighed category takes that category\'s own gram quote');

  const per100 = quoteRow(rows[0], { key: 'x', items: [], gramQuote: 100 });
  assert.strictEqual(per100.unit, '/100g', 'a 100g quote reads /100g');
  assert(Math.abs(per100.quoteWw - 1.20) < 0.005, 'and rescales the figure with it');
  ok('changing a category\'s gram quote changes the unit AND the number');
}

// A per-piece category must not be quoted in kilos. This is the branch that
// silently broke when the seed shape was passed to metricShown unnormalised.
{
  const wipes = { key: 'baby_wipes', items: [], perPack: true, quote: 100, sticker: true };
  const shape = resolved(wipes);
  assert.strictEqual(pieceQuoteSuffix(pieceQuoteOf(shape)), ' /100',
    'a perPack category is quoted per 100 pieces');
  assert.strictEqual(metricShown(shape, 0.05), 5,
    'metricShown must take the perPack branch, not the weighed one');
  ok('a per-piece category is quoted per piece, not per kilo');
}

// THE PRECISION POINT, restated per 100g: the stored per_100_* fields are 2dp,
// so Coles chicken is $2.81/100g here and $28.13/kg when a category asks for
// kilos - never the $28.10 a x10 of the stored field would give.
{
  const perKg = quoteRow(rows[0], { key: 'k', items: [], gramQuote: 1000 });
  assert(Math.abs(perKg.quoteCo - 28.13) < 0.01,
    `per kg Coles is $28.13, got ${perKg.quoteCo}`);
  assert(Math.abs(perKg.quoteCo - 28.10) > 0.02,
    'the rate must be recomputed, not read from the 2dp stored per_100 field');
  ok('rates are recomputed rather than read from the 2dp stored per_100 fields');
}

// THE RANKING. Units now differ per row, so the sort cannot be an absolute gap
// in any unit - it has to be unit-free. By pack gap the order was chicken,
// basa, inglewood, zucchini; by ratio chicken still leads (2.34x) but zucchini
// (3.85x) outranks everything, which no absolute gap would have surfaced.
const byPack = [...built].sort((a, b) => Math.abs(b.packDiff) - Math.abs(a.packDiff)).map(b => b.name);
const byPct  = [...built].sort((a, b) => b.gapPct - a.gapPct).map(b => b.name);
assert.notDeepStrictEqual(byPack, byPct,
  'the two rankings must differ - otherwise this fixture proves nothing');
assert.strictEqual(byPct[0], 'The Odd Bunch Zucchini Prepacked',
  `zucchini is 3.85x apart, the widest here; got ${byPct[0]}`);
ok('ranking is by store-to-store ratio, which reorders the list');

// The ratio must be SYMMETRIC. (co-ww)/ww scores a half-price rival 50 and a
// double-price rival 100, so the identical relationship would rank differently
// depending only on which store happened to be cheaper.
{
  const mk2 = (w, c) => ({ list_item: 'x',
    woolworths: { price: w, name: 'x 100g' }, coles: { price: c, name: 'x 100g' } });
  const a = quoteRow(mk2(10, 20), null), b = quoteRow(mk2(20, 10), null);
  assert(Math.abs(a.gapPct - b.gapPct) < 0.01,
    `a 2x gap must score the same either way round, got ${a.gapPct} vs ${b.gapPct}`);
  assert(Math.abs(a.gapPct - 100) < 0.01, `a 2x gap is 100%, got ${a.gapPct}`);
  ok('the ranking is symmetric - which store is cheaper does not change the score');
}

// ── An item with no shared rate is kept, not dropped or mis-quoted ──────────
// Loose produce - a per-each cucumber at both stores resolves no size.
{
  const loose = mk('Lebanese Cucumbers', 1.5, 'Lebanese Cucumbers', '', null, 2.0, 'Cucumber Lebanese');
  const row = quoteRow(loose, null);
  assert.strictEqual(row.quoteWw, null, 'a per-each item must not fabricate a rate');
  assert.strictEqual(row.unit, '', 'and must not print a unit it does not have');
  assert(row.gapPct > 0, 'but it must still be ranked, on its pack prices');
  ok('a per-each item is left unquoted, kept, and still ranked');
}

// The "no lone unit price" rule: one side sized, the other not. Comparing a real
// rate against a fabricated one is exactly the mixing this fix removes.
{
  const half = mk('Woolworths Corn Sweet', 1.0, 'Woolworths Corn Sweet 500g', '', null,
                  1.2, 'Corn Cob Each');
  assert.strictEqual(quoteRow(half, null).quoteWw, null,
    'one sized side and one unsized side must not produce a quoted row');
  ok('a row where only one store resolves a size stays unquoted');
}

// ── The page actually wires it up ───────────────────────────────────────────
assert(/for \(const g of loadVariantGroups\(\)\) for \(const n of \(g\.items \|\| \[\]\)\) groupOf\.set\(n, g\);/.test(src),
  'buildStorePanel must map products to their category');
assert(/const shape = g \? resolved\(g\) : \{ _gramQuote: 100 \};/.test(src),
  'an ungrouped product must default to the main table unit, $/100g');
assert(/_perPack: !!\(g\._perPack \?\? g\.perPack\)/.test(src),
  'the seed shape must be normalised or metricShown mis-reads perPack');
assert(/quoteWw: pair \? metricShown\(shape, mw\) : null/.test(src),
  'the displayed figure must go through metricShown, like the main page');
assert(/groupMetric\(g, res, i\.list_item\)/.test(src),
  'a grouped product must use the page-wide groupMetric, not a local rule');
ok('the page reuses the main page\'s own quote rules (groupMetric + metricShown)');

// The unit has to be ON the row. Two bare dollar figures that are secretly
// per-kg are what made the display unreadable in the first place.
assert(/\$\{x\.quoteUnit\}/.test(src), 'a quoted row must print its unit');
ok('every quoted row carries its unit');

// Rows with no size on either side can only be set pack beside pack, and the
// packs may hold different amounts - Twinings peppermint scored 325% purely
// because Woolworths sells a 10-bag box against Coles' 80-bag one. On a pure
// percentage ranking those rows took the entire top of the page, which puts the
// LEAST reliable comparisons first. They go below the quoted ones.
assert(/\(p\.quoteWw == null\) - \(q2\.quoteWw == null\) \|\| q2\.gapPct - p\.gapPct/.test(src),
  'unquoted rows must rank below quoted ones, not interleave by percentage');
assert(/sg-group-note/.test(src) && /may not hold the same amount/.test(src),
  'the pack-vs-pack group must say why it is less trustworthy');
ok('pack-vs-pack rows rank below the quoted ones and say why');

// The sort must be unit-free WITHIN a group. Any absolute gap re-introduces the
// bug in a new unit, and the ratio has to be the symmetric one.
assert(/q2\.gapPct - p\.gapPct/.test(src),
  'the list must rank on the unit-free percentage');
assert(/const lo = Math\.min\(qw, qc\), hi = Math\.max\(qw, qc\);/.test(src)
    && /\(hi \/ lo - 1\) \* 100/.test(src),
  'the ranking must use the symmetric ratio, not (co-ww)/ww');
ok('the ranking is unit-free and symmetric');

// A comparison metric, not money: fmtUnitMetric keeps the third decimal below
// 20c, where 2dp would collapse genuinely different rates onto one figure.
assert(/fmtUnitMetric\(x\.quoteWw\)/.test(src) && /fmtUnitMetric\(x\.quoteCo\)/.test(src),
  'quoted figures must print through fmtUnitMetric, not fmt');
ok('quoted figures print through fmtUnitMetric so sub-20c differences survive');

// ── The basket TOTAL is deliberately untouched by all of this ───────────────
// Quoting a product per 100g instead of per kg cannot move what the basket
// costs - the totals are money for a fixed set of products, and they are summed
// from `state`, which still holds same-quantity pack costs. Asserted because
// "the chart didn't move when I changed the units" is otherwise indistinguishable
// from "the chart is stale".
assert(/state\.set\(i\.list_item, \[q\.ww, q\.co\]\);/.test(src),
  'the totals must still be built from same-quantity pack costs');
assert(!/state\.set\([^)]*quote/.test(src),
  'the quote must not leak into the basket total');
{
  const snapSrc = src.slice(src.indexOf('const snap = ()'), src.indexOf('const rows = []'));
  assert(/ww \+= a; co \+= b;/.test(snapSrc),
    'the running total must sum the same-quantity costs, untouched by the quote');
  assert(!/quote/.test(snapSrc), 'the totals must not reference the quote at all');
}
ok('the basket total is summed from pack costs, so the quote cannot move it');

console.log(`\nbasket_rate_selfcheck: ${n} checks passed`);
