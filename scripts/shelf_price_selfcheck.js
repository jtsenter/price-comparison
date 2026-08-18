// Self-check for the one genuinely dangerous ambiguity in the data model:
// `price` does NOT always mean "what you pay".
//
// For a Woolworths by-weight item (Unit=KG, sold as "per 200g") scraper.py
// deliberately stores the per-KG rate in `price` - so the price history and the
// $/kg comparison stay in $/kg and don't cliff the day a portion price appears -
// and puts the portion shelf price in `pack_price`.
//
// That storage choice is right. What went wrong is that only ONE render path
// knew about it (the per-kg category panel). Everywhere else printed the rate
// bare in a column of pack prices: loose mushrooms read "$13.90" against Coles'
// "$4.00" 200g punnet, and - worse than cosmetic - the client recomputed the
// verdict from `price`, so it called COLES cheaper at $4.00 when a $2.78 portion
// beats it. latest.json had it right (cheaper_store: woolworths, saving 1.22);
// the client overrode the correct answer with a wrong one.
//
// The rule these cases pin: MONEY questions go through shelfPrice(); RATE
// questions (per-100, $/kg, history, trend) keep using `price`.
//
// Run: node scripts/shelf_price_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const utils = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
const basket = fs.readFileSync(path.join(__dirname, '..', 'docs', 'shopping-list.html'), 'utf8');

function ex(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// eslint-disable-next-line no-eval
eval([ex(utils, 'shelfPrice'), ex(utils, 'isRatePriced'),
      ex(utils, 'clientPer100'), ex(utils, 'clientPerKg'),
      ex(utils, 'multiBuyCost')].join('\n'));

let n = 0;
const check = (label, fn) => { fn(); n++; process.stdout.write(`  ok  ${label}\n`); };

// The real row, straight out of latest.json on 2026-08-18.
const looseMushrooms = {
  name: 'Mushrooms Cups Loose', price: 13.9, unit_price: 13.9, unit: '1KG', pack_price: 2.78,
};
const colesPunnet = { name: 'Coles Mushrooms Cup | 200g', price: 4.0, unit_price: 7.0, unit: '1kg' };
const plainPack = { name: 'Helga\'s Wholemeal 750g', price: 5.5, unit_price: 7.33, unit: '1kg' };

// ── the money question ──────────────────────────────────────────────────────
check('a by-weight item costs its PORTION price, not its per-kg rate', () => {
  assert.strictEqual(shelfPrice(looseMushrooms), 2.78);
});
check('an ordinary pack is untouched', () => {
  assert.strictEqual(shelfPrice(plainPack), 5.5);
  assert.strictEqual(shelfPrice(colesPunnet), 4.0);
});
check('THE regression: Woolworths wins this row, and by $1.22', () => {
  // $2.78 for 200g vs Coles $4.00 for 200g. Reading `price` gave $13.90 vs $4.00
  // and handed the win to Coles - the exact inversion this file exists to stop.
  const ww = shelfPrice(looseMushrooms), co = shelfPrice(colesPunnet);
  assert.ok(ww < co, 'Woolworths must be the cheaper store here');
  assert.strictEqual(+(co - ww).toFixed(2), 1.22, 'and the saving must match latest.json');
});
check('missing / null sides stay null rather than becoming 0', () => {
  assert.strictEqual(shelfPrice(null), null);
  assert.strictEqual(shelfPrice(undefined), null);
  assert.strictEqual(shelfPrice({}), null);
  assert.strictEqual(shelfPrice({ price: null }), null);
});
check('a legitimately free/zero price is not swallowed by ??', () => {
  // ?? and not ||: a 0 pack_price must win over the rate, not fall through it.
  assert.strictEqual(shelfPrice({ price: 9.9, pack_price: 0 }), 0);
});

// ── the rate question must NOT move ─────────────────────────────────────────
check('$/100g still comes from the per-kg rate, not the portion', () => {
  // 13.90/kg -> $1.39/100g. Computing it from $2.78 without the size would say
  // $2.78/100g and overstate the item 2x.
  assert.strictEqual(clientPer100(looseMushrooms).value, 1.39);
  assert.strictEqual(clientPerKg(looseMushrooms), 13.9);
});
check('the two questions genuinely disagree here - that is the whole point', () => {
  assert.notStrictEqual(shelfPrice(looseMushrooms), looseMushrooms.price);
});

// ── isRatePriced: who needs a label ─────────────────────────────────────────
check('only the by-weight case is flagged as a rate', () => {
  assert.strictEqual(isRatePriced(looseMushrooms), true);
  assert.strictEqual(isRatePriced(plainPack), false);
  assert.strictEqual(isRatePriced(colesPunnet), false);
  assert.strictEqual(isRatePriced(null), false);
});
check('a pack_price equal to price is not a rate (nothing to disambiguate)', () => {
  assert.strictEqual(isRatePriced({ price: 5, pack_price: 5 }), false);
});
check('the portion size is recoverable from the ratio', () => {
  // validate.html prints "per 200g" from this; the size is nowhere in latest.json.
  assert.strictEqual(Math.round((looseMushrooms.pack_price / looseMushrooms.price) * 1000), 200);
});

// ── multi-buy must be unaffected ────────────────────────────────────────────
check('a multi-buy pack is priced off its pack price exactly as before', () => {
  const mb = { name: 'Avocado', price: 2.5, multi_buy: { qty: 2, total: 4 } };
  assert.strictEqual(shelfPrice(mb), 2.5);
  assert.strictEqual(multiBuyCost(2, shelfPrice(mb), mb.multi_buy), 4);
});

// ── the call sites, so a future edit cannot quietly revert one ──────────────
// Every MONEY path must route through shelfPrice. These greps are deliberately
// anchored on the one line in each file that decides a row's cost.
check('main page: mbLineCost (Best, Savings, Total, sort) uses shelfPrice', () => {
  const src = ex(app, 'mbLineCost');
  assert.ok(/shelfPrice\(res\)/.test(src), 'mbLineCost must not read res.price directly');
});
check('basket: lineCost uses shelfPrice, so both pages agree to the cent', () => {
  assert.ok(/const p = shelfPrice\(store === 'ww' \? i\.woolworths : i\.coles\)/.test(basket),
    'basket lineCost must not read .price directly');
});
check('basket: the price it PRINTS matches the price it charges', () => {
  assert.ok(/return shelfPrice\(store === 'ww' \? i\.woolworths : i\.coles\)/.test(basket),
    'effPrice must not read .price directly');
});
check('main table: both price cells show the shelf price', () => {
  assert.ok(/wwShown = wwActive \? multiBuyCost\(units, ww\.price, ww\.multi_buy\) \/ units : shelfPrice\(ww\)/.test(app));
  assert.ok(/coShown = coActive \? multiBuyCost\(units, co\.price, co\.multi_buy\) \/ units : shelfPrice\(co\)/.test(app));
});
check('shelfPrice is defined exactly once, in utils.js', () => {
  assert.strictEqual((utils.match(/function shelfPrice\(/g) || []).length, 1);
  assert.strictEqual((app.match(/function shelfPrice\(/g) || []).length, 0);
  assert.strictEqual((basket.match(/function shelfPrice\(/g) || []).length, 0);
});

console.log(`\nshelf_price_selfcheck: ${n} checks passed`);
