// Self-check for docs/utils.js - the single source of truth for per-100g pricing,
// trend position, and hot-deal detection shared by index.html and hot-deals.html.
// No framework, no deps: extracts the real functions straight from utils.js (so the
// logic under test is single-sourced, not a re-implementation that could drift) and
// asserts against them. Run: node scripts/utils_selfcheck.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'utils.js'), 'utf8');

// Slice `function NAME(...) { ... }` by brace-matching from the first '{'.
function extract(name) {
  const at = src.indexOf('function ' + name + '(');
  assert(at !== -1, `function ${name} not found in utils.js`);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// getTrendSeries() calls the global loadExclusions() (defined in app.js/hot-deals.html
// in the real app, hoisted before use there). Stub it here; tests override per-case.
let _exclStub = {};
global.loadExclusions = () => _exclStub;
// buildPriceBar formats its min/max labels with the host page's fmt() - both
// index.html and hot-deals.html define one. Same implicit dependency it had
// before moving into utils.js; stubbed here.
global.fmt = (v) => v == null ? '-' : '$' + Number(v).toFixed(2);

// getDealQuality() closes over these two module-level tuning constants.
function extractConst(name) {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*[^;]+;`));
  assert(m, `const ${name} not found in utils.js`);
  return m[0];
}

// buildDealGroups() reads localStorage (per-kg membership overrides) and the
// module-level DEFAULT_VARIANT_GROUPS. Stub the former empty; inject a small
// fixture for the latter so the test exercises the LOGIC (cheapest $/kg per
// store, $/kg conversion, skip-empty) against controlled data rather than the
// real 250-name seed. Membership-override resolution is covered separately via
// variantGroupItemNames below.
// Mutable localStorage mock (pendingValidationCount reads AND prunes it).
let _lsStore = {};
global.localStorage = {
  getItem: k => (k in _lsStore ? _lsStore[k] : null),
  setItem: (k, v) => { _lsStore[k] = String(v); },
};
// variantGroupOf() caches its member->category index in two module-level lets.
// extract() pulls functions only, so declare them here - as globals, since a
// `let` inside the direct eval below would not be visible to the extracted
// function bodies.
global._vgIndex = null;
global._vgIndexKey = null;
global.GROUP_DEFAULT_CATEGORY = 'Meat & Seafood';
global.DEFAULT_VARIANT_GROUPS = [
  { key: 'basa_fillets', label: 'Basa Fillets', items: ['Woolworths Frozen Basa Fillets 1kg', 'Coles Frozen Basa Fillet'] },
  { key: 'lamb_mince',   label: 'Lamb Mince',   items: ['Some Lamb Mince 500g'] },
];

// eslint-disable-next-line no-eval
eval([
  extractConst('DEAL_MIN_SPREAD'),
  extractConst('DEAL_MIN_DROP'),
  extract('clientPer100'),
  extract('categoryRemovals'), // Edit-category's removal diff - see 2026-08-06 incident
  // const declared via direct eval doesn't leak to the outer scope the way a
  // function declaration does - the test cases below need to reference this
  // array directly, so promote it explicitly.
  extractConst('KNOWN_BAD_NAPPIES_REMOVE') + '\nglobal.KNOWN_BAD_NAPPIES_REMOVE = KNOWN_BAD_NAPPIES_REMOVE;',
  extract('repairKnownCategoryCorruption'),
  extract('packCountOf'),      // groupMetric's perPack branch closes over it
  extract('groupMetric'),
  extract('per100Pair'),
  extract('scalePer100'),      // card view restates $/100g at the multi-buy price
  extract('fmt'),              // the one money formatter for the whole site
  extract('sameQtyCost'),      // store-gap compares equal quantities, not packs
  extract('exclPriceSet'),
  extract('promoUnitPrice'),   // history + hot-deal detection price through this
  extract('mbUnitPrice'),      // getTrendSeries prices the current point through this
  extract('priceHistoryBtnHTML'), // buildPriceBar's History button, one definition
  extract('buildPriceBar'),    // moved here from app.js; hot-deals draws the same bar
  extract('getTrendSeries'),
  extract('_median'),
  extractConst('BWS_SIZE_TOL'),  // getDealQuality's comparable flag closes over it
  extract('bwsComparable'),      // same size-mismatch guard the Hot Deals table now uses
  extract('getDealQuality'),
  extract('calcTrendPosition'),
  extract('variantGroupItemNames'),
  extract('migratePerKgOverride'),
  extract('computePerKgItems'),
  extract('isCreatedCategory'),      // loadVariantGroups -> allVariantGroupSeeds
  extract('allVariantGroupSeeds'),   // ... needs both, or it throws at call time
  extract('loadVariantGroups'),
  extractConst('SIZE_TOKEN'),  // nameWithSize closes over it
  extract('nameWithSize'),     // "... 1kg" -> "... (1kg)"
  extract('thirdUnitPrice'),   // third-store rate: per piece, or $/100g from the name
  extract('thirdRanked'),
  extract('thirdBeats'),       // decides whether the row's chip goes loud
  extract('thirdBeatsUnit'),   // same, but for a per-kg/per-pack CATEGORY's metric
  extract('thirdOpenState'),   // default-open tri-state for the "other stores" section
  extract('thirdToggleState'),
  extract('groupThirdScale'),  // which scale a CATEGORY compares a third store on
  extract('groupFrameBest'),   // which row gets the outright-cheapest frame
  extract('groupThirdBeat'),
  extract('thirdGroupMetric'), // the price a third-store row SHOWS in the bold slot
  extract('qtySortValue'),     // Qty column: units and kg in ONE numeric order
  extract('thirdStoreFromUrl'), // which outside shop a pasted product link is
  extractConst('THIRD_STORES') + '\nglobal.THIRD_STORES = THIRD_STORES;',
  extractConst('UNIT_METRIC_3DP_BELOW'),
  extract('fmtUnitMetric'),    // comparison-metric precision (cents matter here)
  extractConst('PER_PIECE_QUOTE') + '\nglobal.PER_PIECE_QUOTE = PER_PIECE_QUOTE;',
  extractConst('PIECE_QUOTES') + '\nglobal.PIECE_QUOTES = PIECE_QUOTES;',
  extract('pieceQuoteOf'), extract('pieceQuoteSuffix'),
  extractConst('WEIGHT_QUOTES') + '\nglobal.WEIGHT_QUOTES = WEIGHT_QUOTES;',
  extractConst('PER_WEIGHT_QUOTE') + '\nglobal.PER_WEIGHT_QUOTE = PER_WEIGHT_QUOTE;',
  extract('weightQuoteOf'), extract('weightQuoteSuffix'), extract('isWeighedGroup'),
  extract('metricRound'),      // metricShown rounds through it, so it must come along
  extract('metricShown'),      // per-piece categories are QUOTED per 100 pieces
  extract('groupStoreTotal'),  // costed at the price the row DISPLAYS
  extract('qtyLabel'),         // and the Units box names what it counts
  // Used directly by the test body, not just by another extracted function, so
  // it needs the same global re-export as KNOWN_BAD_NAPPIES_REMOVE above.
  extractConst('CHEAPER_SORT_LABEL') + '\nglobal.CHEAPER_SORT_LABEL = CHEAPER_SORT_LABEL;',
  extract('variantGroupOf'),   // member -> its category
  extract('settingsKeyFor'),   // the key a member's settings actually live under
  extract('buildDealGroups'),
  extract('perKgEquivBundle'),
  // The key must come from utils.js too - pendingValidationCount reads it, and a
  // copy pasted here would let the two drift apart silently.
  extractConst('PV_EMPTY_AT_KEY'),
  extract('pendingValidationCount'),
  extract('multiBuyCost'),
  extract('multiBuyNudge'),
].join('\n'));

let n = 0;
function check(label, actual, expected) {
  n++;
  assert.deepStrictEqual(actual, expected, `${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── clientPer100 ─────────────────────────────────────────────────────────────
check('kg from name', clientPer100({ price: 10, name: 'Foo 2kg' }), { value: 0.5, label: '100g' });
check('g from name', clientPer100({ price: 5, name: 'Bar 250g' }), { value: 2, label: '100g' });
check('L from name', clientPer100({ price: 3, name: 'Milk 2L' }), { value: 0.15, label: '100ml' });
check('ml from name', clientPer100({ price: 2, name: 'Juice 500ml' }), { value: 0.4, label: '100ml' });
check('cup-price fallback (loose, kg unit)',
  clientPer100({ price: 10, unit_price: 10, unit: '1kg', name: 'Loose Bananas' }),
  { value: 1, label: '100g' });
check('no price -> null', clientPer100({ price: null }), { value: null, label: '100g' });
check('no data at all -> null', clientPer100(null), { value: null, label: '100g' });

// ── per100Pair (no lone unit price when both stores are priced) ──────────────
{
  const withSize = { price: 5, name: 'Foo 500g' };     // -> $1.00/100g
  const noSize   = { price: 3, name: 'Bar' };           // -> null
  // both priced, both resolve -> both show
  let p = per100Pair(withSize, { price: 10, name: 'Baz 1kg' });
  check('per100Pair both resolve: ww shown', p.ww.value, 1);
  check('per100Pair both resolve: coles shown', p.coles.value != null, true);
  // both priced, only one resolves -> BOTH blanked
  p = per100Pair(withSize, noSize);
  check('per100Pair asymmetric: ww blanked', p.ww.value, null);
  check('per100Pair asymmetric: coles blanked', p.coles.value, null);
  check('per100Pair asymmetric: blanked flag set', p.ww.blanked && p.coles.blanked, true);
  // only one store priced -> its value still shows (nothing to compare against)
  p = per100Pair(withSize, null);
  check('per100Pair single store: value kept', p.ww.value, 1);
  check('per100Pair single store: not blanked', !p.ww.blanked, true);
}

// ── exclPriceSet ─────────────────────────────────────────────────────────────
check('mixed key formats',
  [...exclPriceSet(['ww:2.00', 'coles:3.5', 4, '5.1'])].sort(),
  ['2.00', '3.50', '4.00', '5.10']);
check('empty/undefined -> empty set', [...exclPriceSet(undefined)], []);

// ── _median ──────────────────────────────────────────────────────────────────
check('median odd', _median([1, 3, 2]), 2);
check('median even', _median([1, 2, 3, 4]), 2.5);
check('median empty -> null', _median([]), null);

// ── getTrendSeries (exclusion-aware) ─────────────────────────────────────────
{
  const item = {
    list_item: 'X',
    price_history: [{ date: '2026-01-01', price: 2.00 }],
    ww_price_history: [{ date: '2026-02-01', price: 4.00 }],
    coles_price_history: [{ date: '2026-03-01', price: 3.00 }],
    woolworths: { price: 4.00 },
    coles: { price: 3.00 },
  };
  _exclStub = {};
  const noExcl = getTrendSeries(item);
  check('getTrendSeries no exclusions: current', noExcl.current, 3.00);
  check('getTrendSeries no exclusions: prices sorted', [...noExcl.prices].sort((a, b) => a - b), [2, 3, 3, 4, 4]);

  _exclStub = { X: ['ww:2.00'] };
  const withExcl = getTrendSeries(item);
  check('getTrendSeries excludes the $2 history point', withExcl.prices.includes(2), false);
  _exclStub = {};
}

// ── getDealQuality (exclusion must actually disqualify a fake deal) ──────────
{
  const item = {
    list_item: 'TEST',
    price_history: [
      { date: '2026-01-01', price: 2.00 },
      { date: '2026-02-01', price: 4.00 },
      { date: '2026-03-01', price: 4.00 },
    ],
    woolworths: { price: 2.00 },
    coles: null,
  };
  check('all-time-low deal qualifies', getDealQuality(item, {}).qualifies, true);
  check('excluding the low price disqualifies it',
    getDealQuality(item, { TEST: ['ww:2.00'] }).qualifies, false);
  check('archived item never qualifies',
    getDealQuality({ ...item, archived: true }, {}).qualifies, false);
}

// ── calcTrendPosition ─────────────────────────────────────────────────────────
{
  const flat = { price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-01-02', price: 5 }], woolworths: { price: 5 } };
  check('flat history -> 0.5', calcTrendPosition(flat), 0.5);
  const atLow = { price_history: [{ date: '2026-01-01', price: 1 }, { date: '2026-01-02', price: 5 }], woolworths: { price: 1 } };
  check('at all-time low -> 0', calcTrendPosition(atLow), 0);
  const noHist = { price_history: [], woolworths: { price: 5 } };
  check('insufficient history -> 999 (sorts last)', calcTrendPosition(noHist), 999);
}

// ── variantGroupItemNames (per-kg membership override resolution) ────────────
{
  const g = { key: 'k', items: ['A', 'B', 'C'] };
  check('no override -> seed verbatim', variantGroupItemNames(g, {}), ['A', 'B', 'C']);
  check('legacy v1 items = pure adds', variantGroupItemNames(g, { k: { items: ['A', 'B', 'C', 'X'] } }), ['A', 'B', 'C', 'X']);
  check('v2 remove drops a seed member', variantGroupItemNames(g, { k: { v: 2, remove: ['B'] } }), ['A', 'C']);
  check('v2 add + remove together', variantGroupItemNames(g, { k: { v: 2, add: ['X'], remove: ['A'] } }), ['B', 'C', 'X']);
}

// ── nameWithSize ────────────────────────────────────────────────────────────
// Cosmetic, but it rewrites every category member name on screen, so the risk is
// mangling a name rather than getting the brackets wrong.
{
  check('bare trailing size gets bracketed', nameWithSize('Macro Black Chia Seeds 1kg', 'x'), 'Macro Black Chia Seeds (1kg)');
  check('size is not printed twice',         nameWithSize('Macro Black Chia Seeds 350g', 'x'), 'Macro Black Chia Seeds (350g)');
  check('already bracketed is left alone',   nameWithSize('Macro Black Chia Seeds (1kg)', 'x'), 'Macro Black Chia Seeds (1kg)');
  check('size taken from the key',           nameWithSize('Macro Black Chia Seeds', 'Macro Black Chia Seeds 1kg'), 'Macro Black Chia Seeds (1kg)');
  check('unit is normalised to lower case',  nameWithSize('Sunflower Kernels 500G', 'x'), 'Sunflower Kernels (500g)');
  check('decimal sizes survive',             nameWithSize('Potato Bag 1.5kg', 'x'), 'Potato Bag (1.5kg)');
  check('pack counts work too',              nameWithSize("Little One's Nappies 40pk", 'x'), "Little One's Nappies (40pk)");
  // A size in the MIDDLE is a real part of the name - moving it would read wrong,
  // so it is re-emitted at the end and the original left in place.
  check('mid-name size is not stripped',     nameWithSize('Chicken 1kg Tray Fresh', 'x'), 'Chicken 1kg Tray Fresh (1kg)');
  check('no size at all -> untouched',       nameWithSize('Woolworths Lean Beef Mince', 'no size here'), 'Woolworths Lean Beef Mince');
  check('empty name is safe',                nameWithSize('', 'x 1kg'), '');
  check('null name is safe',                 nameWithSize(null, 'x 1kg'), '');
  // "Size 6" must not be mistaken for a pack size - 6 has no unit after it.
  check('a bare number is not a size',       nameWithSize('Nappies Size 6', 'x'), 'Nappies Size 6');
}

// ── third stores ────────────────────────────────────────────────────────────
// thirdBeats() is the one that shows on screen without being asked for: it
// turns a row's chip loud. A false positive says "cheaper at Priceline" about
// something that isn't, so the cases below lean on when it must stay quiet.
{
  const pl = (price, name, packs) => ({ store: 'priceline', name, price, packs });
  const cw = (price, name, packs) => ({ store: 'chemist_warehouse', name, price, packs });

  // unit price: from the name, or per piece when sold by the piece
  check('$/100g from the name', thirdUnitPrice(pl(5.50, 'Rexona Sport 52g')).value, 10.5769);
  check('label follows the unit', thirdUnitPrice(pl(5.50, 'Rexona Sport 52mL')).label, '100ml');
  // 5dp, not 3: this figure is displayed x100, so a tenth of a cent here is a
  // visible 10c on screen. See thirdUnitPrice's own comment.
  check('packs -> per piece', thirdUnitPrice(cw(15.99, 'Huggies Size 6', 44)).value, 0.36341);
  check('packs label', thirdUnitPrice(cw(15.99, 'Huggies Size 6', 44)).label, 'each');
  check('no size, no packs -> null', thirdUnitPrice(pl(5.50, 'Mystery item')), null);
  check('no price -> null', thirdUnitPrice({ store: 'priceline', name: 'x 52g' }), null);

  // ranking
  const mixed = [pl(5.50, 'A 52g'), cw(4.29, 'B 52g')];
  check('cheapest first', thirdRanked(mixed)[0].price, 4.29);
  check('ranked keeps both', thirdRanked(mixed).length, 2);
  check('empty list is safe', thirdRanked([]).length, 0);
  check('undefined is safe', thirdRanked(undefined).length, 0);
  check('priceless entries dropped', thirdRanked([pl(null, 'x 52g'), pl(3, 'y 52g')]).length, 1);
  // a list where only SOME entries have a unit price must not compare $/100g
  // against dollars - it falls back to shelf price for every entry.
  const halfKnown = [pl(9.00, 'Big pack 500g'), cw(4.00, 'Mystery pack')];
  check('mixed unit availability ranks on price', thirdRanked(halfKnown)[0].price, 4.00);

  // thirdBeats - the loud chip
  check('beats both',        thirdBeats(mixed, 4.90, 5.50).store, 'chemist_warehouse');
  check('ties do NOT win',   thirdBeats([pl(4.90, 'A 52g')], 4.90, 5.50), null);
  check('dearer does NOT win', thirdBeats([pl(5.50, 'A 52g')], 4.90, 5.50), null);
  check('beats the cheaper of the two, not the dearer',
        thirdBeats([pl(5.20, 'A 52g')], 4.90, 5.50), null);
  check('one store priced only', thirdBeats([pl(3.00, 'A 52g')], null, 5.50).price, 3.00);
  check('no supermarket price -> quiet', thirdBeats([pl(3.00, 'A 52g')], null, null), null);
  check('zero price is not a rival',     thirdBeats([pl(3.00, 'A 52g')], 0, null), null);
  check('no entries -> quiet',           thirdBeats([], 4.90, 5.50), null);
  check('undefined entries -> quiet',    thirdBeats(undefined, 4.90, 5.50), null);
}

// ── thirdBeatsUnit ───────────────────────────────────────────────────────────
// The exact nappies incident: a $13.99-for-40 alternative must NOT register as
// "beats" a $0.29-a-nappy rival just because 13.99 > 0.29 the wrong way round -
// thirdBeats (raw price) would get this backwards; thirdBeatsUnit must not.
{
  const pack = (price, packs, name) => ({ store: 'chemist_warehouse', name, price, packs });
  const cwFortyPack = [pack(13.99, 40, 'Huggies Essentials 40pk')];   // $0.35/each
  check('a dearer-per-unit pack does not beat a cheaper-per-unit rival',
        thirdBeatsUnit(cwFortyPack, 0.29, 0.29), null);
  check('genuinely cheaper per-unit DOES beat',
        thirdBeatsUnit(cwFortyPack, 0.40, 0.40)?.name, 'Huggies Essentials 40pk');
  // 13.99/40 is exactly 0.34975. This used to be written as 0.3498, which was a
  // tie only because thirdUnitPrice rounded to 3dp (0.350); at full precision
  // that rival was a hair DEARER and the entry won. The exact value is the
  // honest tie, and it keeps testing what the name says.
  check('ties do not win (unit price, same as thirdBeats)',
        thirdBeatsUnit(cwFortyPack, 0.34975, 0.50), null);
  check('an entry with no derivable unit price is ignored, not treated as free',
        thirdBeatsUnit([{ store: 'priceline', name: 'no size or packs', price: 3 }], 0.29, 0.29), null);
  check('no rival prices -> quiet', thirdBeatsUnit(cwFortyPack, null, null), null);
  check('zero is not a rival',      thirdBeatsUnit(cwFortyPack, 0, null), null);
  check('empty entries -> quiet',   thirdBeatsUnit([], 0.29, 0.29), null);
  check('undefined entries -> quiet', thirdBeatsUnit(undefined, 0.29, 0.29), null);
}

// ── thirdStoreFromUrl (which shop a pasted link belongs to) ─────────────────
// Matching must be on the HOSTNAME. Real Woolworths links carry
// "?googleshop=true"; a search URL can carry a rival shop's name in its query -
// substring-matching the whole URL would file those under the wrong store, and
// a look-alike domain must never be trusted.
{
  const cw = 'https://www.chemistwarehouse.com.au/buy/100138/ecostore-tablets';
  check('chemist warehouse',  thirdStoreFromUrl(cw), 'chemist_warehouse');
  check('big w',              thirdStoreFromUrl('https://www.bigw.com.au/product/x/p/184248'), 'big_w');
  check('priceline',          thirdStoreFromUrl('https://www.priceline.com.au/product/346268/rexona'), 'priceline');
  check('bare domain, no www', thirdStoreFromUrl('https://bigw.com.au/product/x'), 'big_w');
  check('query string is ignored',
        thirdStoreFromUrl('https://www.bigw.com.au/product/x/p/1?store=364'), 'big_w');

  // The supermarkets are NOT third stores - they have their own columns.
  check('woolworths is not a third store',
        thirdStoreFromUrl('https://www.woolworths.com.au/shop/productdetails/184248'), null);
  check('coles is not a third store',
        thirdStoreFromUrl('https://www.coles.com.au/product/coles-ultra-3967188'), null);

  // The traps.
  check('a rival name in the PATH does not win',
        thirdStoreFromUrl('https://www.woolworths.com.au/search?q=bigw.com.au'), null);
  check('a look-alike suffix domain is refused',
        thirdStoreFromUrl('https://bigw.com.au.evil.example/product'), null);
  check('a name-only host is refused', thirdStoreFromUrl('https://notbigw.com.au/x'), null);
  check('unknown shop -> null', thirdStoreFromUrl('https://www.iga.com.au/product/x'), null);
  check('not a URL -> null',    thirdStoreFromUrl('chemist warehouse'), null);
  check('empty -> null',        thirdStoreFromUrl(''), null);
  check('null -> null',         thirdStoreFromUrl(null), null);
  check('uppercase host still matches',
        thirdStoreFromUrl('https://WWW.BigW.COM.AU/product/x'), 'big_w');
  check('aldi',
        thirdStoreFromUrl('https://www.aldi.com.au/product/mamia-baby-water-wipes-80-pack-000000000000418168'),
        'aldi');
  // Kmart product slugs contain an apostrophe ("wrigley's"), which URL parsing
  // must not choke on - the host is all that decides the store.
  check('kmart',
        thirdStoreFromUrl("https://www.kmart.com.au/product/46-piece-wrigley's-extra-gum-64g-43253067/?sku=43253067"),
        'kmart');
  // A store is only usable end to end if utils.js can ROUTE the link AND
  // THIRD_STORES can label the result. Adding one without the other renders a
  // blank chip, so assert the pair rather than the router alone.
  check('every routable host has a THIRD_STORES label',
        ['https://www.chemistwarehouse.com.au/buy/1/x',
         'https://www.bigw.com.au/product/x/p/1',
         'https://www.priceline.com.au/product/1/x',
         'https://www.aldi.com.au/product/x',
         'https://www.kmart.com.au/product/x-1'
        ].every(u => !!THIRD_STORES[thirdStoreFromUrl(u)]?.label), true);
  // Two shops sharing a chip letter is fine (C is Coles-red vs CW-yellow), but
  // two sharing a letter AND having no colour to tell them apart is not.
  check('every third store has a chip colour',
        Object.values(THIRD_STORES).every(m => !!m.bg && !!m.letter), true);
}

// ── fmtUnitMetric (a per-piece metric must not round away the comparison) ────
{
  // The bug this exists to stop: at two decimals the three cheapest baby wipes
  // on the site all printed "$0.03", so the category could not show a winner.
  check('ALDI wipes',        fmtUnitMetric(2.29 / 80),  '$0.029');
  check('CW Goat wipes',     fmtUnitMetric(7.49 / 240), '$0.031');
  check("WW Little One's",   fmtUnitMetric(1.90 / 60),  '$0.032');
  check('three cheapest wipes stay distinguishable',
        new Set([2.29 / 80, 7.49 / 240, 1.90 / 60].map(fmtUnitMetric)).size, 3);
  check('Coles 360pk',       fmtUnitMetric(40.00 / 360), '$0.111');
  // Above the threshold nothing changes - nappies and $/kg keep two decimals.
  check('nappy stays 2dp',   fmtUnitMetric(13.99 / 40), '$0.35');
  check('threshold is exclusive', fmtUnitMetric(0.20),  '$0.20');
  check('just under threshold',   fmtUnitMetric(0.1999), '$0.200');
  check('a $/kg figure is untouched', fmtUnitMetric(24.5), '$24.50');
  check('null -> dash',      fmtUnitMetric(null), '-');
}

// ── metricShown (per-piece categories are QUOTED per 100, costed per 1) ─────
{
  const wipes  = { _perPack: true, _quote: 100 };   // baby wipes, tablets, bags
  const weighed = { _perPack: false };          // chicken, salmon - $/kg
  const sticker = { _sticker: true };           // deodorant - pack price

  // The readability fix: cents-per-wipe becomes dollars-per-100. Fed through
  // groupMetric(), the REAL path a W/C row takes - checking raw division here
  // is what let a rounding bug ship: groupMetric quantised to 3dp, so the app
  // showed $10.90 while this assertion passed on the unrounded $10.93.
  // The expected values are the stores' own printed "/100EA" labels.
  const perPack = { perPack: true };
  const shown = (price, name) =>
    fmtUnitMetric(metricShown(wipes, groupMetric(perPack, { price, name }, name)));
  check('ALDI wipes per 100',  shown(2.29, 'Mamia Water Wipes 80pk'),   '$2.86');
  check('WW 540pk per 100 matches the WW shelf label',
        shown(59.00, 'WaterWipes 540pk'),                               '$10.93');
  check('Coles 360pk per 100 matches the Coles shelf label',
        shown(40.00, 'WaterWipes 360pk'),                               '$11.11');
  check('WW 180pk half price',  shown(10.75, 'WaterWipes 180pk'),       '$5.97');
  check('a nappy per 100',      shown(13.99, 'Huggies 40pk'),           '$34.98');
  // Non-per-piece categories must be left exactly alone.
  check('$/kg is not scaled',   metricShown(weighed, 24.5), 24.5);
  check('a sticker price is not scaled', metricShown(sticker, 4.9), 4.9);
  check('no group at all',      metricShown(null, 3.5), 3.5);
  check('null stays null',      metricShown(wipes, null), null);

  // The stored value stays per ONE piece; the row COSTS at the price it shows.
  // So one unit of quantity is 100 wipes and costs $2.86, matching the "/100"
  // figure printed beside it. Costing the hidden per-piece number instead put
  // "$0.03" in the Total column next to a price reading "$2.86 /100" - the same
  // rate quoted two different ways in one row.
  // ── weighed categories choose $/kg or $/100g ─────────────────────────────
  // A kilo of chocolate is four blocks nobody buys at once, so "$28.25/kg" has
  // to be divided in your head before it means anything. Meat and produce ARE
  // bought by the kilo, so 1000 stays the default and they are untouched.
  const choc = { _wwPerKg: 28.25, _coPerKg: 30.00, _gramQuote: 100 };
  const weighedMeat = { _wwPerKg: 12, _coPerKg: 11 };
  check('chocolate shows per 100g', fmtUnitMetric(metricShown(choc, 28.25)), '$2.83');
  check('meat is untouched by default', metricShown(weighedMeat, 12), 12);
  check('an explicit per-kg choice is also unscaled',
        metricShown({ _wwPerKg: 12, _gramQuote: 1000 }, 12), 12);
  check('suffix follows the weight quote', weightQuoteSuffix(100), '/100g');
  check('...and defaults to /kg', weightQuoteSuffix(1000), '/kg');
  check('an unknown gram quote falls back rather than rendering NaN',
        weightQuoteOf({ _gramQuote: 250 }), PER_WEIGHT_QUOTE);
  check('seed value is read when there is no built _gramQuote',
        weightQuoteOf({ gramQuote: 100 }), 100);

  // THE TRAP: the gram quote may only rescale a WEIGHED metric. A per-piece or
  // pack-price category stores something that is not $/kg, so scaling it by
  // 0.1 would silently divide those prices by ten.
  check('a per-piece category ignores the gram quote',
        metricShown({ _perPack: true, _quote: 100, _gramQuote: 100 }, 0.0317).toFixed(2), '3.17');
  check('a sticker category ignores it too',
        metricShown({ _sticker: true, _gramQuote: 100 }, 4.90), 4.90);
  check('isWeighedGroup rejects per-piece', isWeighedGroup({ _perPack: true }), false);
  check('isWeighedGroup rejects sticker',   isWeighedGroup({ _sticker: true }), false);
  check('isWeighedGroup accepts a plain weighed group', isWeighedGroup({}), true);

  // The Units box must be denominated in whatever the price is quoted in.
  check('a 100g category counts grams', qtyLabel(1, 'g', 1), '100 g');
  check('...and scales', qtyLabel(2.5, 'g', 1), '250 g');
  check('a kilo category still says kg', qtyLabel(1, 'kg', 1), '1.0 kg');

  // ── the quote size is PER CATEGORY ───────────────────────────────────────
  // Quoting is meant to read as "about one pack". Wipes and tablets come in
  // 60-640 so 100 is natural; nappies come in 26-60, where a per-100 price
  // would name a pack nobody sells - hence 50 there.
  const nappies = { _perPack: true, _quote: 50 };
  check('a nappy per 50', fmtUnitMetric(metricShown(nappies, 13.99 / 40)), '$17.49');
  check('the same nappy per 100 would invent a pack size',
        fmtUnitMetric(metricShown(wipes, 13.99 / 40)), '$34.98');
  check('quote 1 is plain per-piece', metricShown({ _perPack: true, _quote: 1 }, 0.35), 0.35);
  check('suffix follows the quote', pieceQuoteSuffix(50), ' /50');
  check('suffix for 1 is "each"',   pieceQuoteSuffix(1),  ' each');
  check('an unknown quote falls back, never renders NaN',
        pieceQuoteOf({ _quote: 7 }), PER_PIECE_QUOTE);
  check('a perPack category naming no quote gets the default',
        pieceQuoteOf({ _perPack: true }), PER_PIECE_QUOTE);
  check('seed value is read when there is no built _quote',
        pieceQuoteOf({ quote: 50 }), 50);

  // The four seeded per-piece categories must carry the quotes agreed for them;
  // a silent revert to per-piece is exactly the unreadable state this fixes.
  // DEFAULT_VARIANT_GROUPS is stubbed with a 2-entry fixture at the top of this
  // file, so read the REAL seed array out of utils.js under its own name rather
  // than replacing the fixture other tests depend on.
  // eslint-disable-next-line no-eval
  const REAL_SEEDS = eval('(' + src.match(/const DEFAULT_VARIANT_GROUPS\s*=\s*(\[[\s\S]*?\n\]);/)[1] + ')');
  const seedQuote = (k) => {
    const g = REAL_SEEDS.find(x => x.key === k);
    assert(g, `seed category ${k} is missing`);
    check(`${k} is per-piece`, !!g.perPack, true);
    return pieceQuoteOf(g);
  };
  check('baby_wipes quote',          seedQuote('baby_wipes'), 100);
  check('dishwashing_tablets quote', seedQuote('dishwashing_tablets'), 100);
  check('garbage_bags_xl quote',     seedQuote('garbage_bags_xl'), 100);
  check('nappies_size6 quote',       seedQuote('nappies_size6'), 50);

  // The two chocolate categories, switched to per-100g. (Weet-Bix is a category
  // YOU created in the editor, so it lives in the synced override rather than
  // here - there is no seed to assert.)
  const gramSeed = (k) => {
    const g = REAL_SEEDS.find(x => x.key === k);
    assert(g, `seed ${k} is missing`);
    check(`${k} is weighed`, isWeighedGroup(g), true);
    return weightQuoteOf(g);
  };
  check('cadbury_dairy_milk is quoted per 100g', gramSeed('cadbury_dairy_milk'), 100);
  check('aero_peppermint is quoted per 100g',    gramSeed('aero_peppermint'), 100);
  // Meat must NOT have been swept up in the change - it is genuinely bought by
  // the kilo, and this is the assertion that catches a blanket edit.
  check('chicken_breast still quotes per kg', weightQuoteOf(REAL_SEEDS.find(x => x.key === 'chicken_breast')), 1000);

  const g = { list_item: '__group_baby_wipes', _perPack: true, _quote: 100,
              _wwPerKg: 2.29 / 80, _coPerKg: 40.00 / 360 };
  // groupUnits() reads localStorage for the planned quantity; pin it at 1 so the
  // real groupStoreTotal still runs and the assertion is about the PRICE it
  // multiplies, which is the thing that must not be the per-100 figure.
  global.groupUnits = () => 1;
  check('one unit of quantity is 100 wipes and costs the shown price',
        fmtUnitMetric(groupStoreTotal(g, 'ww')), fmtUnitMetric(metricShown(g, g._wwPerKg)));
  check('...which is ALDI\'s per-100 figure', fmtUnitMetric(groupStoreTotal(g, 'ww')), '$2.86');
  // A weighed category must be untouched by all of this: $/kg x kg, as before.
  const meat = { list_item: '__group_chicken', _wwPerKg: 12, _coPerKg: 11 };
  check('a weighed row still costs $/kg x kg', groupStoreTotal(meat, 'ww'), 12);
  // And the Units label has to name what is being counted.
  check('a per-piece row counts PIECES', qtyLabel(1, 'pieces', 100), '100 pcs');
  check('...and scales with the quantity', qtyLabel(1.2, 'pieces', 100), '120 pcs');
  check('a nappy row counts its own quote', qtyLabel(1, 'pieces', 50), '50 pcs');
  check('a weighed row still says kg', qtyLabel(1, 'kg', 1), '1.0 kg');
  check('a pack row is a plain count', qtyLabel(3, 'packs', 1), '3');

  // The row's CHIP and the panel under it price the same entry by two different
  // routes - thirdUnitPrice for the chip, thirdGroupMetric for the panel. They
  // must agree to the cent once shown per 100, or one row states two prices for
  // one product (ALDI read "$2.90" on the chip and "$2.86" in the panel).
  const aldi = { store: 'aldi', name: 'Mamia Baby Water Wipes 80 Pack', price: 2.29, packs: 80 };
  check('chip and panel agree on the same entry',
        fmtUnitMetric(metricShown(g, thirdUnitPrice(aldi).value)),
        fmtUnitMetric(metricShown(g, thirdGroupMetric(g, aldi))));
  check('...and that figure is ALDI\'s real per-100 price',
        fmtUnitMetric(metricShown(g, thirdUnitPrice(aldi).value)), '$2.86');
}

// ── groupFrameBest (which row gets the outright-cheapest frame) ─────────────
{
  const cw = (price, packs, name) => ({ store: 'chemist_warehouse', name: name || 'x', price, packs });

  // THE BUG THIS EXISTS FOR: the frame used to be derived from groupThirdScale,
  // whose verdict is gated on sticker||perPack. A WEIGHED category - chicken,
  // salmon, mince, i.e. most of them - therefore produced no candidates at all
  // and no row was ever framed. Woolworths and Coles are always comparable with
  // each other; only the OUTSIDE stores need that gate.
  const meat = { _wwPerKg: 12, _coPerKg: 11 };
  check('weighed: the cheaper supermarket is framed', groupFrameBest(meat, []).best, 11);
  check('weighed: not a tie',                         groupFrameBest(meat, []).tied, false);
  check('weighed: an outside rate is a different unit and cannot win',
        groupFrameBest(meat, [cw(2, 1)]).best, 11);
  check('weighed: outside stores are excluded from the frame entirely',
        groupFrameBest(meat, [cw(2, 1)]).includesThird, false);

  // Per-piece: the outside store IS on the category's own scale, so it can win.
  const wipes = { _perPack: true, _sticker: true, _quote: 100,
                  _wwPerKg: 1.90 / 60, _coPerKg: 6 / 60 };
  const aldi = { store: 'aldi', name: 'Mamia 80pk', price: 2.29, packs: 80 };
  check('per-piece: ALDI beats both supermarkets',
        groupFrameBest(wipes, [aldi]).best.toFixed(5), (2.29 / 80).toFixed(5));
  check('per-piece: outside stores are eligible',
        groupFrameBest(wipes, [aldi]).includesThird, true);

  // Ties never get a frame, whoever is level.
  check('two supermarkets level -> no frame',
        groupFrameBest({ _wwPerKg: 10, _coPerKg: 10 }, []).tied, true);
  check('a supermarket level with an outside store -> no frame',
        groupFrameBest({ _sticker: true, _wwPerKg: 5, _coPerKg: 9 },
                       [cw(5, 1)]).tied, true);
  check('a clear winner is not a tie',
        groupFrameBest({ _sticker: true, _wwPerKg: 5, _coPerKg: 9 }, [cw(7, 1)]).tied, false);

  // A single-store category still frames its one price - it IS the cheapest.
  check('one store priced -> that row is framed',
        groupFrameBest({ _wwPerKg: 8, _coPerKg: null }, []).best, 8);
  check('nothing priced -> nothing framed',
        groupFrameBest({ _wwPerKg: null, _coPerKg: null }, []).best, null);
}

// ── groupThirdScale / groupThirdBeat (picking the right comparison scale) ────
// The bug this exists to prevent: a STICKER category's metric is a shelf price,
// but it was being compared per-100g, so a genuinely cheaper deodorant read as
// dearer. Silent in the UI - the chip just stays quiet - so it needs a test.
{
  const stickerG = { _sticker: true,  _wwPerKg: 4.90, _coPerKg: 5.50 };
  const packG    = { _perPack: true,  _wwPerKg: 0.29, _coPerKg: 0.29 };
  const weighedG = {                  _wwPerKg: 17.00, _coPerKg: 17.00 };

  check('a sticker category compares on RAW price', groupThirdScale(stickerG).perUnit, false);
  check('a perPack category compares per unit',     groupThirdScale(packG).perUnit,    true);
  check('a weighed category offers no rivals at all',
        groupThirdScale(weighedG).ww, null);

  // The exact regression: $4.00/52g really is cheaper than a $4.90 stick.
  const pricelineCheap = [{ store: 'priceline', name: 'Rexona Sport 52g', price: 4.00 }];
  check('a cheaper sticker alternative IS detected',
        groupThirdBeat(stickerG, pricelineCheap)?.name, 'Rexona Sport 52g');
  const pricelineDear = [{ store: 'priceline', name: 'Rexona Sport 52g', price: 5.90 }];
  check('a dearer sticker alternative is not',
        groupThirdBeat(stickerG, pricelineDear), null);

  // The nappies case still has to work off per-piece, not raw.
  const cw40 = [{ store: 'chemist_warehouse', name: 'Huggies 40pk', price: 13.99, packs: 40 }];
  check('a dearer-per-nappy pack does not beat', groupThirdBeat(packG, cw40), null);
  check('a cheaper-per-nappy pack does beat',
        groupThirdBeat({ _perPack: true, _wwPerKg: 0.40, _coPerKg: 0.40 }, cw40)?.name, 'Huggies 40pk');

  // A weighed category must stay silent rather than compare $/kg against $/100g.
  check('a weighed category never returns a verdict',
        groupThirdBeat(weighedG, [{ store: 'priceline', name: 'Chia 1kg', price: 1.00 }]), null);
}

// ── thirdGroupMetric (what a third-store row shows in its bold price slot) ──
// The row has to state the same KIND of number as the W/C rows beside it: a
// nappies column means "per nappy", so a $13.99 pack price there is not a
// smaller number, it's a different unit. And a sticker category means one item,
// so a per-100g figure belongs nowhere near it.
{
  const packG    = { _perPack: true };
  const stickerG = { _sticker: true };
  const weighedG = {};

  check('a perPack category shows price PER PIECE, not the pack price',
        thirdGroupMetric(packG, { name: 'Huggies 40pk', price: 13.99, packs: 40 })?.toFixed(2), '0.35');
  check('a sticker category shows the shelf price itself',
        thirdGroupMetric(stickerG, { name: 'Rexona Sport 52g', price: 5.50 }), 5.50);
  check('...and NOT a per-100g figure for it',
        thirdGroupMetric(stickerG, { name: 'Rexona Sport 52g', price: 5.50 }) === 10.576923076923077, false);
  check('a weighed category shows $/kg (per-100g x10)',
        thirdGroupMetric(weighedG, { name: 'Chia Seeds 500g', price: 8.50 })?.toFixed(2), '17.00');

  // The real nappies category carries BOTH flags, and groupMetric gives perPack
  // priority - so this must too, or the pack price prints wearing an "each"
  // label ("$13.99 each"). Precedence, not just the individual branches.
  check('perPack beats sticker when a category sets both, as groupMetric does',
        thirdGroupMetric({ _sticker: true, _perPack: true },
                         { name: 'Huggies 40pk', price: 13.99, packs: 40 })?.toFixed(2), '0.35');

  check('a perPack entry with no packs count has no metric, rather than a wrong one',
        thirdGroupMetric(packG, { name: 'Some nappies', price: 13.99 }), null);
  check('zero packs does not divide by zero',
        thirdGroupMetric(packG, { name: 'x', price: 5, packs: 0 }), null);
  check('a priceless entry has no metric', thirdGroupMetric(stickerG, { name: 'x' }), null);
  check('a missing entry is safe',          thirdGroupMetric(stickerG, null), null);
  check('a weighed entry with no size in its name has no metric',
        thirdGroupMetric(weighedG, { name: 'Mystery bag', price: 4 }), null);
}

// ── qtySortValue (Qty column: units and kilos in ONE numeric order) ─────────
// The old rule added 1e6 to every kg row, blocking all weights after all counts,
// so a 0.8 kg item sorted AFTER a 20-pack. Both examples below are the ones
// asked for verbatim.
{
  const sortQty = rows => rows
    .map(r => ({ ...r, k: qtySortValue(r.u, r.kg) }))
    .sort((a, b) => a.k - b.k)
    .map(r => r.kg ? r.u + 'kg' : String(r.u));

  check('0.8kg, 1 unit, 1.2kg sort in numeric order',
        sortQty([{ u: 1.2, kg: true }, { u: 1, kg: false }, { u: 0.8, kg: true }]),
        ['0.8kg', '1', '1.2kg']);

  check('at the SAME number, a plain unit comes before a weight',
        sortQty([{ u: 1, kg: true }, { u: 1, kg: false }, { u: 1, kg: true }, { u: 1, kg: false }]),
        ['1', '1', '1kg', '1kg']);

  // The specific regression: a small weight must not be exiled past a big count.
  check('0.5kg sorts before a 20-pack, not after it',
        sortQty([{ u: 20, kg: false }, { u: 0.5, kg: true }]), ['0.5kg', '20']);

  check('the kg nudge is far smaller than a real step',
        qtySortValue(1, true) < 1.1, true);
  check('a unit value is left exactly alone', qtySortValue(3, false), 3);
  check('a missing quantity is NaN, so it sinks either way',
        Number.isNaN(qtySortValue(undefined, false)), true);
}

// ── CHEAPER_SORT_LABEL (Best column sorts by what it DISPLAYS) ───────────────
// Sorting the raw store keys put 'coles' < 'equal' < 'woolworths', which on
// screen read as C, =, W - an order matching nothing visible.
{
  const label = k => CHEAPER_SORT_LABEL[k] ?? 'N/A';
  check('woolworths shows as Woolworths', label('woolworths'), 'Woolworths');
  check('coles shows as Coles',           label('coles'), 'Coles');
  check('equal shows as Equal',           label('equal'), 'Equal');
  check('an unknown/missing store is N/A, not undefined', label(null), 'N/A');
  check('labels sort alphabetically as displayed',
        ['woolworths', 'equal', null, 'coles'].map(label).sort(),
        ['Coles', 'Equal', 'N/A', 'Woolworths']);
}

// ── thirdOpenState / thirdToggleState (default-open tri-state) ───────────────
// "Cheaper elsewhere" must open ITSELF - the user asked for exactly this, so a
// saving isn't hidden behind a badge nobody remembers to press. The subtlety is
// that the default must stay a default: an explicit collapse of a cheaper row
// has to survive, and so does an explicit expand of a not-cheaper one.
{
  const fresh = () => [new Set(), new Set()];

  let [op, cl] = fresh();
  check('not cheaper -> collapsed by default', thirdOpenState('k', null, op, cl), false);
  check('cheaper -> OPEN by default',          thirdOpenState('k', { store: 'p' }, op, cl), true);

  // Collapsing a cheaper-elsewhere row must stick, or the auto-open becomes a
  // lock the user cannot escape - it would spring back open on every render.
  [op, cl] = fresh();
  thirdToggleState('k', { store: 'p' }, op, cl);
  check('collapsing a cheaper row sticks', thirdOpenState('k', { store: 'p' }, op, cl), false);
  thirdToggleState('k', { store: 'p' }, op, cl);
  check('and re-expanding it works',       thirdOpenState('k', { store: 'p' }, op, cl), true);

  // The mirror case: expanding a row that ISN'T cheaper must also stick.
  [op, cl] = fresh();
  thirdToggleState('k', null, op, cl);
  check('expanding a not-cheaper row sticks', thirdOpenState('k', null, op, cl), true);
  thirdToggleState('k', null, op, cl);
  check('and re-collapsing it works',         thirdOpenState('k', null, op, cl), false);

  // Each branch must clear its opposite, or a stale entry decides the next click.
  [op, cl] = fresh();
  thirdToggleState('k', null, op, cl);              // -> explicit open
  thirdToggleState('k', null, op, cl);              // -> explicit closed
  check('toggling never leaves a key in BOTH sets', op.has('k') && cl.has('k'), false);

  // Keys are independent - one row's choice must not move another's.
  [op, cl] = fresh();
  thirdToggleState('a', null, op, cl);
  check('an unrelated key keeps its default', thirdOpenState('b', null, op, cl), false);
  check('and the toggled one is open',        thirdOpenState('a', null, op, cl), true);
}

// ── categoryRemovals (Edit-category's removal diff) ─────────────────────────
// The exact bug: a category grows a new member in code; a client whose
// snapshot pre-dates that never rendered it as a row; saving ANY edit on that
// client must not be able to record it as removed.
{
  const DEF = ['A', 'B', 'C'];   // current code defaults for the category
  check('user genuinely unticked a row they saw',
        categoryRemovals(DEF, ['A', 'B'], ['A']), ['B']);
  check('a member never shown (stale snapshot) is never removed',
        categoryRemovals(DEF, ['A'], ['A']), []);       // C never in snapshot -> untouched
  check('bare label rename removes nothing',
        categoryRemovals(DEF, ['A', 'B', 'C'], ['A', 'B', 'C']), []);
  check('empty snapshot removes nothing, however sparse the save',
        categoryRemovals(DEF, [], []), []);
  check('a user-added extra (not in defaults) is never a removal',
        categoryRemovals(DEF, ['A', 'B', 'C'], ['A', 'B', 'C', 'X']), []);
  check('every seen default dropped -> every one recorded',
        categoryRemovals(DEF, ['A', 'B', 'C'], []), ['A', 'B', 'C']);
  check('undefined snapshot is safe (treated as none seen)',
        categoryRemovals(DEF, undefined, ['A']), []);
  check('undefined defItems is safe',
        categoryRemovals(undefined, ['A'], []), []);
}

// ── repairKnownCategoryCorruption ───────────────────────────────────────────
// Scoped tightly on purpose: it must fix the exact known-bad shape and touch
// NOTHING else, including a genuine future removal of these same 3 items from
// a DIFFERENT reason, or of different items from this same category.
{
  const bad = { nappies_size6: { v: 2, add: [], remove: [...KNOWN_BAD_NAPPIES_REMOVE], label: 'Diapers size 6' } };
  const fixed = repairKnownCategoryCorruption(bad);
  check('strips exactly the known-bad names', fixed.nappies_size6.remove, []);
  check('label (a real user edit) is preserved', fixed.nappies_size6.label, 'Diapers size 6');
  check('is idempotent - a second pass is a no-op',
        repairKnownCategoryCorruption(fixed).nappies_size6.remove, []);

  const partial = { nappies_size6: { v: 2, remove: [KNOWN_BAD_NAPPIES_REMOVE[0]] } };
  check('a PARTIAL match (only one of the 3) is left alone - not this incident',
        repairKnownCategoryCorruption(partial).nappies_size6.remove, [KNOWN_BAD_NAPPIES_REMOVE[0]]);

  const other = { nappies_size6: { v: 2, remove: ['Some Other Product'] } };
  check('an unrelated removal from the same category is untouched',
        repairKnownCategoryCorruption(other).nappies_size6.remove, ['Some Other Product']);

  const mixed = { nappies_size6: { v: 2, remove: [...KNOWN_BAD_NAPPIES_REMOVE, 'Genuinely Removed Item'] } };
  check('a real removal alongside the bad 3 survives the strip',
        repairKnownCategoryCorruption(mixed).nappies_size6.remove, ['Genuinely Removed Item']);

  check('no nappies_size6 key at all is safe', repairKnownCategoryCorruption({}), {});
  check('empty overrides object is safe', repairKnownCategoryCorruption({}), {});
  check('null input is safe', repairKnownCategoryCorruption(null), {});
  check('other categories are never touched',
        repairKnownCategoryCorruption({ other_cat: { remove: ['X'] } }).other_cat.remove, ['X']);
}

// ── variantGroupOf / settingsKeyFor ─────────────────────────────────────────
// A product added to a category belongs to it in every sense, so its frequency,
// category and watchlist state resolve against the CATEGORY key, not its own
// name. These two functions are what every such lookup goes through, and the
// index they cache has to notice a membership change - that cache is the part
// most likely to break silently.
{
  const MEMBER = 'Woolworths Frozen Basa Fillets 1kg';   // seed member of basa_fillets
  const LOOSE  = 'Some Unrelated Product 500g';

  _lsStore = {};   // no membership overrides
  check('seed member resolves to its category', variantGroupOf(MEMBER).key, 'basa_fillets');
  check('non-member resolves to null',          variantGroupOf(LOOSE), null);
  check('member settings key = category key',   settingsKeyFor(MEMBER), '__group_basa_fillets');
  check('loose item keeps its own key',         settingsKeyFor(LOOSE), LOOSE);
  // A category key passed back in must not be re-resolved into another category.
  check('category key is not a member',    variantGroupOf('__group_basa_fillets'), null);
  check('category key maps to itself',     settingsKeyFor('__group_basa_fillets'), '__group_basa_fillets');
  check('empty name is safe',              variantGroupOf(''), null);

  // Adding a product to a category through Edit category must take effect at
  // once - the cached index is keyed on the override string for exactly this.
  _lsStore['pw_perkg_cats_v1'] = JSON.stringify({ basa_fillets: { v: 2, add: [LOOSE] } });
  check('added member resolves immediately', variantGroupOf(LOOSE).key, 'basa_fillets');
  check('added member inherits the key',     settingsKeyFor(LOOSE), '__group_basa_fillets');

  // ...and removing it must too, rather than serving a stale index.
  _lsStore['pw_perkg_cats_v1'] = JSON.stringify({ basa_fillets: { v: 2, remove: [MEMBER] } });
  check('removed member drops out at once',  variantGroupOf(MEMBER), null);
  check('removed member gets its own key',   settingsKeyFor(MEMBER), MEMBER);
  check('the add is gone with its override', variantGroupOf(LOOSE), null);

  _lsStore = {};
  check('clearing overrides restores seed',  variantGroupOf(MEMBER).key, 'basa_fillets');
}

// ── buildDealGroups (cheapest $/kg per store, other groups skipped) ──────────
{
  // Two real basa_fillets seed members, priced so WW is cheaper per kg.
  const items = [
    { list_item: 'Woolworths Frozen Basa Fillets 1kg', woolworths: { price: 7.20, name: 'WW Basa 1kg', url: 'u1' }, coles: null, price_history: [], ww_price_history: [{ date: '2026-01-01', price: 9.00 }], coles_price_history: [] },
    { list_item: 'Coles Frozen Basa Fillet',           woolworths: null, coles: { price: 10.00, name: 'Coles Basa 1kg', url: 'u2' }, price_history: [], ww_price_history: [], coles_price_history: [{ date: '2026-01-01', price: 12.00 }] },
  ];
  const groups = buildDealGroups(items);
  const basa = groups.find(g => g.list_item === '__group_basa_fillets');
  check('one basa group built', !!basa, true);
  check('basa marked as group', basa._isGroup, true);
  check('basa WW = cheapest member $/kg', basa.woolworths.price, 7.20);   // 7.20 / 1kg
  check('basa Coles = cheapest member $/kg', basa.coles.price, 10.00);    // 10.00 / 1kg
  check('WW history converted to $/kg', basa.ww_price_history.map(p => p.price), [9.00]);
  check('groups with no priced members are skipped', groups.some(g => g.list_item === '__group_lamb_mince'), false);
}

// ── perKgEquivBundle (equivalent-quantity bundling for unit-based groups) ────
{
  // 1kg @ $4.20/kg vs 2kg @ $4.20/kg: 2 × WW 1kg matches 1 × Coles 2kg, equal.
  const yog = perKgEquivBundle({ price: 4.20, perKg: 4.20 }, { price: 8.40, perKg: 4.20 });
  check('yoghurt WW scaled to 2 packs', yog.ww.packs, 2);
  check('yoghurt WW total = 2×4.20', yog.ww.total, 8.40);
  check('yoghurt Coles stays 1 pack', yog.coles.packs, 1);
  check('yoghurt Coles total unchanged', yog.coles.total, 8.40);
  check('equal total -> equal', yog.cheaper, 'equal');

  // Same sizes (1kg each): no scaling, cheaper by real price.
  const same = perKgEquivBundle({ price: 4.20, perKg: 4.20 }, { price: 4.50, perKg: 4.50 });
  check('same-size no scaling ww', same.ww.packs, 1);
  check('same-size no scaling coles', same.coles.packs, 1);
  check('same-size cheaper = ww', same.cheaper, 'woolworths');

  // 4kg vs 1kg: Coles buys 4 packs to reach 4kg. WW $4/kg beats Coles $5/kg.
  const potato = perKgEquivBundle({ price: 16.00, perKg: 4.00 }, { price: 5.00, perKg: 5.00 });
  check('potato Coles scaled to 4 packs', potato.coles.packs, 4);
  check('potato Coles total = 4×5', potato.coles.total, 20.00);
  check('potato WW stays 1 pack', potato.ww.packs, 1);
  check('potato cheaper = ww', potato.cheaper, 'woolworths');

  // Off-multiple (0.75kg vs 1kg): can't align in whole packs -> 1:1, no scaling.
  const odd = perKgEquivBundle({ price: 6.00, perKg: 8.00 }, { price: 7.00, perKg: 7.00 });
  check('off-multiple ww no scaling', odd.ww.packs, 1);
  check('off-multiple coles no scaling', odd.coles.packs, 1);

  // Single store: returned as-is, that store is "cheaper".
  const solo = perKgEquivBundle({ price: 5.00, perKg: 5.00 }, null);
  check('single store packs = 1', solo.ww.packs, 1);
  check('single store coles null', solo.coles, null);
  check('single store cheaper = ww', solo.cheaper, 'woolworths');
}

// ── groupMetric (sticker groups compare by pack price, else $/kg) ────────────
check('groupMetric $/kg default', groupMetric({}, { price: 5, name: 'Foo 500g' }), 10); // $5/500g = $10/kg
check('groupMetric sticker = pack price', groupMetric({ sticker: true }, { price: 4.6, name: 'Dolmio 500g' }), 4.6);
check('groupMetric null result', groupMetric({ sticker: true }, null), null);

// perPack: the case a 30-pack vs 40-pack nappy category needs. This is what
// stops "$14.40 for 30" outranking "$11.50 for 40" - $0.48 each vs $0.29 each.
{
  const g = { sticker: true, perPack: true };
  // 11.50/40 is exactly 0.2875. It used to read back 0.287 because groupMetric
  // rounded per-piece values to 3dp; that half-cent is 5c once the row is shown
  // per 100, so the rounding is now 5dp and the exact value survives.
  check('perPack count from the item key',    groupMetric(g, { price: 11.50, name: 'Store name has none' }, 'Little One\'s Nappies 40pk'), 0.2875);
  check('perPack falls back to store name',   groupMetric(g, { price: 14.40, name: 'Huggies 30 pack' }, 'no count here'), 0.48);
  check('perPack key wins over store name',   groupMetric(g, { price: 20.00, name: 'Wrong 10pk' }, 'Right 40pk'), 0.5);
  check('perPack: a 40-pack now ranks BELOW a dearer 30-pack per-piece',
        groupMetric(g, { price: 11.50 }, '40pk') < groupMetric(g, { price: 14.40 }, '30pk'), true);
  // A multi-buy is ALWAYS counted in a category's price. The scraper writes the
  // effective price into history, so using the shelf price here made the price
  // column and the history chart disagree about the same product - Coles' 60pk
  // wipes read $14.17/100 live and $10.00/100 in history.
  const mb60 = { price: 8.50, name: 'WaterWipes 60pk', multi_buy: { qty: 2, total: 12 } };
  check('multi-buy sets the per-piece price',
        groupMetric(g, mb60, 'WaterWipes 60pk'), +(6 / 60).toFixed(5));
  check('...which is the figure history already stores',
        fmtUnitMetric(metricShown({ _perPack: true, _quote: 100 },
                                  groupMetric(g, mb60, 'WaterWipes 60pk'))), '$10.00');
  check('a shelf price with no offer is untouched',
        groupMetric(g, { price: 8.50, name: 'x 60pk' }, 'x 60pk'), +(8.5 / 60).toFixed(5));
  check('an offer DEARER than the shelf price is ignored',
        groupMetric(g, { price: 5.00, name: 'x 10pk', multi_buy: { qty: 2, total: 12 } }, 'x 10pk'),
        +(5 / 10).toFixed(5));
  // The scrape result is shared with every other reader - it must not be mutated.
  const shared = { price: 8.50, name: 'y 60pk', multi_buy: { qty: 2, total: 12 } };
  groupMetric(g, shared, 'y 60pk');
  check('groupMetric does not mutate the scrape result', shared.price, 8.50);

  // ── THE WEIGHED branch, where the promo used to be dropped ────────────────
  // Everything above is perPack, which divides `price` directly. A weighed
  // category goes through clientPer100(), which prefers the size in the product
  // NAME and falls back to the store's cup price when the name has none - and
  // that fallback reads unit_price, not price. Overriding price alone therefore
  // discounted nothing for exactly those products: Woolworths scrapes the Aero
  // bar as "Aero Peppermint Milk Chocolate Bar" with no "40g" in it, so its
  // 2-for-$5 kept reading as the full $7.50/100g on screen.
  const weighed = {};   // not sticker, not perPack
  const noSize = { price: 3.00, name: 'Aero Peppermint Milk Chocolate Bar',
                   unit_price: 7.50, unit: '100G', multi_buy: { qty: 2, total: 5 } };
  check('weighed + promo + NO size in the name -> promo still applies',
        groupMetric(weighed, noSize, 'Aero Peppermint Milk Chocolate Bar 40g'), 62.5);
  // Same product, same offer, but the name carries the size: the other strategy
  // wins and must land on the identical number.
  const withSize = { price: 3.00, name: 'Aero Peppermint Milk Chocolate Bar 40g',
                     unit_price: 7.50, unit: '100G', multi_buy: { qty: 2, total: 5 } };
  check('...and agrees with the size-in-name strategy',
        groupMetric(weighed, withSize, 'x'), groupMetric(weighed, noSize, 'x'));
  // The real Coles row from the report: $7.50 118g block, 2 for $10 -> $5.00 each.
  check('Coles 118g block at 2-for-$10 reads $4.24/100g, not $6.36',
        +metricShown({ _gramQuote: 100 },
          groupMetric(weighed, { price: 7.50, name: 'Peppermint Milk Chocolate Block',
                                 unit_price: 6.36, unit: '100g',
                                 multi_buy: { qty: 2, total: 10 } }, 'x')).toFixed(2), 4.24);
  check('no offer -> the cup price is passed through untouched',
        groupMetric(weighed, { price: 5.00, name: 'no size here', unit_price: 4.24, unit: '100g' }, 'x'),
        42.4);
  check('an offer dearer than the shelf leaves the cup price alone',
        groupMetric(weighed, { price: 5.00, name: 'no size', unit_price: 4.24, unit: '100g',
                               multi_buy: { qty: 2, total: 20 } }, 'x'), 42.4);
  check('a missing cup price does not become NaN',
        groupMetric(weighed, { price: 3.00, name: 'no size', multi_buy: { qty: 2, total: 5 } }, 'x'), null);
  const sharedW = { price: 3.00, name: 'no size', unit_price: 7.50, unit: '100G',
                    multi_buy: { qty: 2, total: 5 } };
  groupMetric(weighed, sharedW, 'x');
  check('the weighed path does not mutate unit_price either', sharedW.unit_price, 7.50);

  check('perPack with no count anywhere -> null', groupMetric(g, { price: 11.50, name: 'x' }, 'y'), null);
  check('perPack with zero count -> null',        groupMetric(g, { price: 11.50, name: 'x 0pk' }, 'y'), null);
  check('packCountOf reads "pack" spelled out',   packCountOf('Huggies 30 pack'), 30);
  check('packCountOf reads "pk"',                 packCountOf('40pk'), 40);
  check('packCountOf: no count -> null',          packCountOf('no count here'), null);
  // A weight token must not be mistaken for a pack count.
  check('perPack ignores a kg token, not a count', groupMetric(g, { price: 10, name: '2kg' }, 'x'), null);
}

// ── pendingValidationCount (Validate pill, resolved-suppression + self-prune) ─
{
  const pending = [{ item: 'A' }, { item: 'B' }, { item: 'C' }];
  _lsStore = {};
  check('no resolved -> full count', pendingValidationCount(pending), 3);
  _lsStore = { pw_pv_resolved_v1: JSON.stringify(['B']) };
  check('one resolved (still lagging) suppressed', pendingValidationCount(pending), 2);
  // B still present so it stays tracked
  check('resolved kept while still pending', JSON.parse(_lsStore.pw_pv_resolved_v1), ['B']);
  // Pages caught up: B gone from pending -> pruned from the set, count unaffected
  _lsStore = { pw_pv_resolved_v1: JSON.stringify(['B']) };
  check('pruned when fresh data drops it', pendingValidationCount([{ item: 'A' }, { item: 'C' }]), 2);
  check('resolved set self-pruned', JSON.parse(_lsStore.pw_pv_resolved_v1), []);
  check('empty pending -> 0', pendingValidationCount(undefined), 0);

  // Stale-copy suppression. A scrape rewrites latest.json repeatedly, adding then
  // clearing pending_validation, so the main page and validate.html can hold
  // different versions - which is how the pill offered a count and opened onto an
  // empty page. validate.html stamps the version at which it saw nothing.
  const V1 = '2026-08-15T10:00:00Z', V2 = '2026-08-15T11:00:00Z';
  _lsStore = { pw_pv_empty_at_v1: V2 };
  check('older copy than a proven-empty one is suppressed',
    pendingValidationCount(pending, V1), 0);
  check('same version as proven-empty is suppressed',
    pendingValidationCount(pending, V2), 0);
  // A NEWER scrape genuinely flagged things - the old observation must not hide it.
  check('newer copy than the proven-empty stamp still counts',
    pendingValidationCount(pending, '2026-08-15T12:00:00Z'), 3);
  // The stamp must never suppress when the caller has no version to compare.
  check('no version passed -> stamp ignored, counts normally',
    pendingValidationCount(pending), 3);
  _lsStore = {};
  check('no stamp -> counts normally', pendingValidationCount(pending, V1), 3);
}

// ── multiBuyCost / multiBuyNudge ────────────────────────────────────────────
// Mirrors scripts/multibuy_selfcheck.py - the same numbers must come out of the
// Python (scraper) and JS (basket) sides or a basket total silently disagrees
// with what the register charges.
{
  const DIPS = { qty: 2, total: 7 };   // WW Chris' Dips: 2 for $7, shelf $4.50
  check('mb: below threshold pays shelf', multiBuyCost(1, 4.5, DIPS), 4.5);
  check('mb: exactly one block',          multiBuyCost(2, 4.5, DIPS), 7);
  check('mb: block + remainder',          multiBuyCost(3, 4.5, DIPS), 11.5);
  check('mb: two whole blocks',           multiBuyCost(4, 4.5, DIPS), 14);
  check('mb: no promo multiplies',        multiBuyCost(3, 4.5, null), 13.5);
  check('mb: zero qty',                   multiBuyCost(0, 4.5, DIPS), 0);
  // A dearer-than-shelf "deal" is still what the store charges - report reality.
  check('mb: worse promo still applied',  multiBuyCost(2, 5, { qty: 2, total: 12 }), 12);

  check('nudge: 1 short of the deal', multiBuyNudge(1, 4.5, DIPS), { need: 1, saving: 2 });
  check('nudge: already on a block',  multiBuyNudge(2, 4.5, DIPS), null);
  check('nudge: 3 -> 1 more',         multiBuyNudge(3, 4.5, DIPS), { need: 1, saving: 2 });
  check('nudge: no promo',            multiBuyNudge(1, 4.5, null), null);
  // A promo that saves nothing must not nag the shopper.
  check('nudge: pointless promo stays quiet', multiBuyNudge(1, 3, { qty: 2, total: 6 }), null);
}

// ── Trend: a multi-buy must be able to beat the all-time low ────────────────
// Two separate faults made the "below everything ever seen" marker unreachable:
// the current point was the SHELF price (so a promo never counted), and the
// series the bar was drawn against already contained that current price (so it
// could never fall outside its own range). Both are pinned here.
{
  check('mbUnitPrice: no promo -> shelf price', mbUnitPrice({ price: 4.5 }), 4.5);
  check('mbUnitPrice: live promo rate wins', mbUnitPrice({ price: 4.5, multi_buy: { qty: 2, total: 7 } }, 2), 3.5);
  // "2 for $12" on a $5 item is dearer per unit - multiBuyCost still charges it
  // (that is what the register does), so the shelf price is not silently kept.
  check('mbUnitPrice: dearer promo still charged', mbUnitPrice({ price: 5, multi_buy: { qty: 2, total: 12 } }, 2), 6);
  check('mbUnitPrice: unpriced store -> null', mbUnitPrice({ price: null }), null);
  check('mbUnitPrice: missing store -> null',  mbUnitPrice(null), null);

  // Shelf $4.50, never seen below $4.50, but "2 for $7" = $3.50 each.
  const promoItem = {
    list_item: 'X',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: { price: 4.5, multi_buy: { qty: 2, total: 7 } },
    coles: null,
  };
  // Qty 2 = the deal quantity, so the promo is genuinely live here.
  const t = getTrendSeries(promoItem, 2);
  check('trend current follows a LIVE promo', t.current, 3.5);
  // THE REGRESSION: `past` is history only. If the current price leaks in here,
  // min(past) becomes 3.5 and the marker can never sit left of the bar.
  check('trend past excludes current', Math.min(...t.past), 4.5);
  check('trend past is history only',  t.past.length, 2);
  assert.ok(t.current < Math.min(...t.past),
    'a promo below every historical price must read as off-range');
  n += 1;

  // Without a promo the current price sits inside the historical range, so the
  // bar draws normally - the off-range marker must not fire for everyone.
  const plain = { ...promoItem, woolworths: { price: 4.8 } };
  const t2 = getTrendSeries(plain, 1);
  assert.ok(t2.current >= Math.min(...t2.past), 'a normal price is not off-range');
  n += 1;
}

// ── buildPriceBar: off-range marker + optional History button ───────────────
{
  const hist = [{ price: 4.5 }, { price: 5 }, { price: 6 }];
  // Below every historical price -> the off-range marker, NOT a clamped bar.
  const off = buildPriceBar('X', hist, 3.5);
  assert.ok(/price-marker-off-left/.test(off), 'below-history must draw the off-left marker');
  assert.ok(!/price-marker" style/.test(off), 'off-range must not also draw an in-range marker');
  n += 2;
  // Above every historical price -> the right-hand off-range marker.
  assert.ok(/price-marker-off-right/.test(buildPriceBar('X', hist, 9)),
    'above-history must draw the off-right marker');
  n += 1;
  // In range -> an ordinary positioned marker, no off-range markers.
  const mid = buildPriceBar('X', hist, 5);
  assert.ok(/price-marker" style/.test(mid) && !/off-left|off-right/.test(mid),
    'an in-range price draws a normal marker');
  n += 1;
  // The History button is opt-out for pages with no history modal - a button
  // that does nothing is worse than no button.
  assert.ok(/price-bar-manage/.test(buildPriceBar('X', hist, 5)), 'History button on by default');
  assert.ok(!/price-bar-manage/.test(buildPriceBar('X', hist, 5, 1, false)), 'History button suppressible');
  n += 2;
  // Too little history to place a marker -> NO BAR, but the way into the history
  // survives. A product scraped for the first time yesterday used to get a wholly
  // empty Trend cell: no bar (fair - one price is not a trend) and no History
  // button either (not fair - that is exactly where you would go to look).
  const sparse = buildPriceBar('X', [{ price: 4 }], 4);
  check('single history point -> no bar drawn', /price-bar-outer/.test(sparse), false);
  check('...but the History button is still there', /price-bar-manage/.test(sparse), true);
  check('no history at all -> still a way in', /price-bar-manage/.test(buildPriceBar('X', [], 4)), true);
  check('unpriced item -> still a way in', /price-bar-manage/.test(buildPriceBar('X', [{ price: 4 }], null)), true);
  check('...and pages without the modal still opt out',
        buildPriceBar('X', [{ price: 4 }], 4, 1, false), '');
  check('the item name is escaped into the sparse button too',
        /data-manage-item="a&quot;b"/.test(buildPriceBar('a"b', [], 4)), true);
}

// ── A deal you haven't qualified for is not a price you can pay ─────────────
{
  const DEAL = { price: 4.5, multi_buy: { qty: 2, total: 7 } };
  check('mbUnitPrice: below deal qty -> shelf price', mbUnitPrice(DEAL, 1), 4.5);
  check('mbUnitPrice: at deal qty -> promo rate',     mbUnitPrice(DEAL, 2), 3.5);
  // 3 units of "2 for $7" at $4.50 = $7 + $4.50 = $11.50 -> $3.83 each. Must
  // match the price column exactly, which is why it uses multiBuyCost.
  check('mbUnitPrice: partial block averages out',
        +mbUnitPrice(DEAL, 3).toFixed(2), 3.83);

  const item = {
    list_item: 'Y',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: DEAL, coles: null,
  };
  // At Qty 1 the deal is dormant: the marker must sit at the shelf price, NOT
  // claim an all-time low the shopper cannot actually buy.
  assert.ok(getTrendSeries(item, 1).current >= Math.min(...getTrendSeries(item, 1).past),
    'a dormant deal must not read as off-range');
  assert.ok(getTrendSeries(item, 2).current < Math.min(...getTrendSeries(item, 2).past),
    'a live deal below every historical price must read as off-range');
  n += 2;

  // Off-range sorts AHEAD of an item merely sitting at its own historical low.
  const atLow = {
    list_item: 'Z',
    price_history: [{ date: '2026-01-01', price: 5 }, { date: '2026-02-01', price: 4.5 }],
    woolworths: { price: 4.5 }, coles: null,
  };
  const pOff = calcTrendPosition(item, 2);
  const pLow = calcTrendPosition(atLow, 1);
  check('at historical low scores 0', pLow, 0);
  assert.ok(pOff < 0, `off-range must score below 0 (got ${pOff})`);
  assert.ok(pOff < pLow, 'off-range must sort ahead of at-its-low');
  n += 2;

  // Dormant deal ranks the same as no deal at all.
  check('dormant deal ranks as its shelf price', calcTrendPosition(item, 1), 0);
}

// ── Off-chart sorts to the EXTREMES, both directions ────────────────────────
// Both ends were clamped, so "below everything ever seen" scored the same as
// "at its own low" (0) and "above everything" the same as "at its own high" (1).
// Trend sort therefore scattered off-chart rows among ordinary ones.
{
  const hist = [{ date: '2026-01-01', price: 4 }, { date: '2026-02-01', price: 6 }];
  const mk = (p) => ({ list_item: 'T', price_history: hist, woolworths: { price: p }, coles: null });
  const below = calcTrendPosition(mk(3));    // under the $4 low
  const atLow = calcTrendPosition(mk(4));
  const atHigh = calcTrendPosition(mk(6));
  const above = calcTrendPosition(mk(7));    // over the $6 high
  check('at historical low = 0', atLow, 0);
  check('at historical high = 1', atHigh, 1);
  assert.ok(below < atLow, 'below-everything must sort ahead of at-its-low');
  assert.ok(above > atHigh, 'above-everything must sort behind at-its-high');
  n += 2;

  // Dill Fresh / Parsley: ONE price ever recorded ($3.20), now $3.30. That is
  // off the top, not mid-range - it used to score 0.5 and land in the middle of
  // a trend sort.
  const flat = (p) => ({
    list_item: 'F',
    price_history: [{ date: '2026-01-01', price: 3.2 }, { date: '2026-02-01', price: 3.2 }],
    woolworths: { price: p }, coles: null,
  });
  assert.ok(calcTrendPosition(flat(3.3)) > 1, 'flat history, dearer now = off the top');
  assert.ok(calcTrendPosition(flat(3.0)) < 0, 'flat history, cheaper now = off the bottom');
  check('flat history, unchanged = middle', calcTrendPosition(flat(3.2)), 0.5);
  n += 2;
}

// ── Hot Deals must see multi-buy all-time lows ──────────────────────────────
{
  const base = {
    list_item: 'Nut Bar',
    price_history: [
      { date: '2026-01-01', price: 5 },
      { date: '2026-02-01', price: 5 },
      { date: '2026-03-01', price: 4.5 },
    ],
    coles: null,
  };
  // Shelf $5 is NOT a deal - it is the usual price.
  check('shelf price at its usual = no deal',
        getDealQuality({ ...base, woolworths: { price: 5 } }, {}).qualifies, false);
  // Same shelf price, but "2 for $6" = $3 each, under the $4.50 all-time low.
  // This is the case that never reached Hot Deals.
  const promo = getDealQuality(
    { ...base, woolworths: { price: 5, multi_buy: { qty: 2, total: 6 } } }, {});
  check('multi-buy all-time low qualifies', promo.qualifies, true);
  check('multi-buy low is flagged all-time-low', promo.isAllTimeLow, true);
}

// ── scalePer100: the $/100g must follow the price above it ──────────────────
// Card view shows the multi-buy price; a $/100g still figured off the shelf
// ticket sat directly under a lower headline and contradicted it.
{
  const p = { value: 1.89, label: '100g' };
  check('no deal live leaves the measure alone', scalePer100(p, 8.5, 8.5).value, 1.89);
  // "2 for $15" on an $8.50 pack = $7.50 each, so $/100g drops in the same ratio.
  check('measure follows the effective price',
        +scalePer100(p, 8.5, 7.5).value.toFixed(4), +(1.89 * 7.5 / 8.5).toFixed(4));
  check('label is preserved', scalePer100(p, 8.5, 7.5).label, '100g');
  check('input is not mutated', p.value, 1.89);
  // Pass-throughs: nothing to scale, no shelf price, or no effective price.
  check('null measure passes through', scalePer100(null, 8.5, 7.5), null);
  check('blanked measure passes through',
        scalePer100({ value: null, blanked: true }, 8.5, 7.5).blanked, true);
  check('zero shelf price cannot divide', scalePer100(p, 0, 7.5).value, 1.89);
  check('null effective price passes through', scalePer100(p, 8.5, null).value, 1.89);
}

// ── fmt: grouped thousands, everywhere ──────────────────────────────────────
{
  check('under a thousand is unchanged', fmt(66.62), '$66.62');
  check('thousands are grouped', fmt(1059.16), '$1,059.16');
  check('millions group too', fmt(1234567.5), '$1,234,567.50');
  check('always two decimals', fmt(8), '$8.00');
  check('null renders as a dash', fmt(null), '-');
  check('non-numeric renders as a dash', fmt('abc'), '-');
  check('zero is a price, not a blank', fmt(0), '$0.00');
}

// ── sameQtyCost: compare equal amounts, not equal packs ─────────────────────
// The salmon case: WW sells a $34 pack at $3.40/100g, Coles a $10 portion at
// $5.00/100g. On pack price Coles looks $24 cheaper; per quantity it is dearer.
{
  const s = sameQtyCost(34, 10, 3.4, 5.0);
  check('rival restated to the WW quantity', s.co, 50);
  check('WW side is left alone', s.ww, 34);
  check('flagged as normalised', s.normalised, true);
  check('the comparison INVERTS vs pack price', s.co > s.ww, true);
  // Equal pack sizes: normalising must be an identity, so it can run always.
  const eq = sameQtyCost(8.5, 9.0, 1.7, 1.8);
  check('equal sizes leave the rival untouched', eq.co, 9);
  // No rate at one store → fall back to pack prices and say so.
  const fb = sameQtyCost(5, 6, null, 1.2);
  check('falls back to pack price', fb.co, 6);
  check('fallback is flagged', fb.normalised, false);
  check('missing a price yields null', sameQtyCost(null, 6, 1, 1), null);
}

console.log(`utils_selfcheck: all ${n} cases passed`);
