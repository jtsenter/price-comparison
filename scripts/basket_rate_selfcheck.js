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

const built = rows.map(i => {
  const r = per100Pair(i.woolworths, i.coles);
  const rated = r.ww.value > 0 && r.coles.value > 0;
  const q = sameQtyCost(i.woolworths.price, i.coles.price, r.ww.value, r.coles.value);
  return {
    name: i.list_item,
    packDiff: q.co - q.ww,
    rateWw: rated ? r.ww.value * 10 : null,
    rateCo: rated ? r.coles.value * 10 : null,
    rateDiff: rated ? (r.coles.value - r.ww.value) * 10 : null,
    // The denominator the old pack comparison implicitly used, in grams.
    impliedQty: r.ww.value > 0 ? i.woolworths.price / r.ww.value * 100 : null,
  };
});

// THE BUG: the old comparison used a different denominator on every row.
const qtys = built.map(b => Math.round(b.impliedQty));
assert(new Set(qtys).size > 1,
  'fixture must reproduce the mixed denominators, got ' + JSON.stringify(qtys));
ok(`the pack comparison really does use different quantities per row (${qtys.join('g, ')}g)`);

// Every one of these four is a weight item, so all four must now carry a rate.
assert(built.every(b => b.rateDiff != null), 'all four rows must be rated per kg');
ok('a weight item at both stores gets a $/kg rate');

// The rate is a RATE: both sides are per the same 1000 units.
for (const b of built) {
  assert(b.rateWw > 0 && b.rateCo > 0, `${b.name} must have both rates`);
}
assert(Math.abs(built[0].rateWw - 12.00) < 0.005,
  `WW chicken breast is $12.00/kg, got ${built[0].rateWw}`);
assert(Math.abs(built[0].rateCo - 28.13) < 0.01,
  `Coles chicken breast is $28.13/kg, got ${built[0].rateCo}`);
ok('the rate is computed per kg on both sides ($12.00 vs $28.13)');

// Precision: the stored per_100_* fields are rounded to 2dp, which would
// quantise $/kg to the nearest 10c and print Coles at $28.10 rather than
// $28.13. per100Pair recomputes at 4dp, so the rate must NOT land on a 10c
// boundary here.
assert(Math.abs(built[0].rateCo - 28.10) > 0.02,
  'the rate must come from per100Pair, not the 2dp-rounded stored field');
ok('rates are recomputed rather than read from the 2dp stored per_100 fields');

// THE ORDERING. By pack gap the order was chicken, basa, inglewood, zucchini.
// Per kg, Inglewood ($20.00 vs $35.50 = $15.50/kg) overtakes Basa ($12.10/kg).
const byPack = [...built].sort((a, b) => Math.abs(b.packDiff) - Math.abs(a.packDiff)).map(b => b.name);
const byRate = [...built].sort((a, b) => Math.abs(b.rateDiff) - Math.abs(a.rateDiff)).map(b => b.name);
assert.notDeepStrictEqual(byPack, byRate,
  'the two rankings must differ - otherwise this fixture proves nothing');
assert.strictEqual(byRate[1], 'Inglewood Farms Chicken Thigh Fillets Skin Off',
  `per kg, Inglewood ranks 2nd at $15.50/kg; got ${byRate[1]}`);
assert.strictEqual(byPack[1], 'Woolworths Basa Fillets Boneless With Skin Off',
  'sanity: by pack gap Basa was 2nd');
ok('ranking per kg reorders the list (Inglewood overtakes Basa)');

// ── An item with no shared rate is kept, not dropped or mis-ranked ──────────
// Loose produce - a per-each cucumber at both stores resolves no size.
const loose = mk('Lebanese Cucumbers', 1.5, 'Lebanese Cucumbers', '', null, 2.0, 'Cucumber Lebanese');
{
  const r = per100Pair(loose.woolworths, loose.coles);
  const rated = r.ww.value > 0 && r.coles.value > 0;
  assert(!rated, 'a per-each item must not fabricate a $/kg rate');
  ok('a per-each item is left unrated rather than given an invented rate');
}

// The "no lone unit price" rule: one side sized, the other not. Comparing a real
// rate against a fabricated one is exactly the mixing this fix removes.
{
  const half = mk('Woolworths Corn Sweet', 1.0, 'Woolworths Corn Sweet 500g', '', null,
                  1.2, 'Corn Cob Each');
  const r = per100Pair(half.woolworths, half.coles);
  assert(!(r.ww.value > 0 && r.coles.value > 0),
    'one sized side and one unsized side must not produce a rated row');
  ok('a row where only one store resolves a size stays unrated');
}

// ── The page actually wires it up ───────────────────────────────────────────
assert(/const r = per100Pair\(i\.woolworths, i\.coles\);/.test(src),
  'buildStorePanel must compute a rate per product');
assert(/rateWw: +rated \? r\.ww\.value \* 10 : null/.test(src),
  'the rate must be per 1000 units (per kg / per litre)');
assert(/rateUnit: r\.ww\.label === '100ml' \? 'L' : 'kg'/.test(src),
  'a millilitre item must be quoted per litre, not per kg');
ok('buildStorePanel attaches a per-kg/per-litre rate to every product');

// The sort must be grouped, never interleaved - mixing a $/kg gap with a pack
// gap by magnitude would be the same bug wearing a different hat.
assert(/\(p\.rateDiff == null\) - \(q2\.rateDiff == null\) \|\|/.test(src),
  'rated and unrated rows must be grouped, not interleaved by magnitude');
ok('rated rows are ranked separately from unrated ones');

// The unit has to be ON the row. Two bare dollar figures that are secretly
// per-kg are what made the old display unreadable in the first place.
assert(/const per = rated \? '\/' \+ x\.rateUnit : '';/.test(src),
  'a rated row must print its unit');
assert(/sg-group-note/.test(src) && /no\s*\n?\s*shared \$\/kg to compare/.test(src),
  'the unrated group must say why it is separate');
ok('rated rows carry their unit and the unrated group explains itself');

// A comparison metric, not money: fmtUnitMetric keeps the third decimal below
// 20c, where 2dp would collapse genuinely different rates onto one figure.
assert(/fmtUnitMetric\(Math\.abs\(d\)\)/.test(src) && /fmtUnitMetric\(x\.rateWw\)/.test(src),
  'rates must print through fmtUnitMetric, not fmt');
ok('rates print through fmtUnitMetric so sub-20c differences survive');

console.log(`\nbasket_rate_selfcheck: ${n} checks passed`);
