// ── utils.js - Shared utilities for PriceWatch
// SINGLE SOURCE OF TRUTH for trend position, hot deal detection, and sorting
// Both app.js (index.html) and hot-deals.html load this file before their own code
// Do NOT redefine these functions elsewhere or divergence will occur

// ── HTML escape ─────────────────────────────────────────────────────────────
// Escape a value for safe interpolation into an innerHTML template. Store-scraped
// product names and user-typed strings (search, renames) are untrusted: a name
// containing "<" or "&" both breaks rendering AND is an XSS vector (the GitHub
// token in localStorage is the prize). Use esc() for TEXT content and escAttr()
// inside a double-quoted attribute (escAttr also neutralises the quote). Numbers
// from fmt()/toFixed() and hardcoded markup never need escaping.
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}
function escAttr(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// The one explanation of how a store total is built, shared verbatim by the main
// page and the basket - the whole point is that the two agree, so the wording
// they show must come from one place. Rendered inside a .info-ico tooltip, which
// honours the line breaks (white-space: pre-line).
const TOTALS_RULE_TIP =
  'Both store totals always cover exactly the same items, so neither store is ' +
  'flattered by what it happens to stock.\n\n' +
  '• Every row counts as the price shown × its Qty.\n\n' +
  '• Per-kg categories count at their RATE, not their pack price: $10/kg × 1kg ' +
  '= $10, whether that store sells it in 500g trays or one 2kg bag. A store is ' +
  'never made to look expensive just for selling in bulk.\n\n' +
  '• An item only ONE store sells still counts in BOTH totals, priced at what ' +
  "you'd really pay for it. Dropping it from the other total would make that " +
  'store look cheaper purely for not stocking it.\n\n' +
  'The main page and your basket apply these same three rules, so their totals match.';

// Display name for a product. The stored list_item keeps its "Woolworths "
// prefix (it is the key for price history and localStorage), but that prefix is
// just how the shopping list happens to name things - it does NOT mean the
// product is Woolworths'. Showing it raw made Coles price changes read
// "Woolworths Cookie Caramel Bar Slice". Defined here once; app.js, hot-deals
// and shopping-list previously each had their own copy.
const stripWW = (name) => String(name == null ? '' : name).replace(/^Woolworths\s+/i, '');
// Short display name from name_map.js when the page loads it; else stripWW.
const shortName = (name) => (window.PW_NAME_MAP && window.PW_NAME_MAP[name]) || stripWW(name);

// A small circled "?" that reveals its explanation on hover OR tap/focus
// (tabindex makes :focus-visible tooltips work on touch). CSS: .info-ico.
// Used instead of an always-visible paragraph for anything explanatory but not
// essential to read every time - the tooltip is there when wanted, invisible
// when not.
function infoIcoHTML(tip) {
  return `<span class="info-ico" tabindex="0" role="note" aria-label="${escAttr(tip)}" data-tip="${escAttr(tip)}">?</span>`;
}

// ── Per-100g / per-100ml price ─────────────────────────────────────────────
// Compute per-100g or per-100ml price from a product result object.
// Prioritises size extracted from the product name (reliable for pack goods)
// over the store-scraped cup price (which is often wrong for Coles packs).
function clientPer100(result) {
  if (!result || result.price == null) return { value: null, label: '100g' };
  const price = result.price;
  const name  = result.name || '';

  // Strategy 1: extract size from product name
  const kgM = name.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kgM) { const g = +kgM[1] * 1000; return { value: +(price * 100 / g).toFixed(4), label: '100g' }; }
  const gM = name.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gM && +gM[1] > 0) return { value: +(price * 100 / +gM[1]).toFixed(4), label: '100g' };
  const lM = name.match(/(\d+(?:\.\d+)?)\s*l(?:it(?:re|er)s?)?\b(?!\w)/i);
  if (lM) { const ml = +lM[1] * 1000; return { value: +(price * 100 / ml).toFixed(4), label: '100ml' }; }
  const mlM = name.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (mlM && +mlM[1] > 0) return { value: +(price * 100 / +mlM[1]).toFixed(4), label: '100ml' };

  // Strategy 2: use store-provided cup price + unit (for loose/weight goods)
  const unit = (result.unit || '').toLowerCase().trim();
  const up   = result.unit_price;
  if (up != null && unit) {
    const uM = unit.match(/^(\d*\.?\d*)?\s*(g|kg|ml|l)\b/);
    if (uM) {
      let qty = parseFloat(uM[1]) || 1.0;
      const uom = uM[2];
      if (uom === 'kg') qty *= 1000;
      else if (uom === 'l') qty *= 1000;
      if (qty > 0) return { value: +(up * 100 / qty).toFixed(4), label: (uom === 'ml' || uom === 'l') ? '100ml' : '100g' };
    }
  }
  return { value: null, label: '100g' };
}

// $/100 for a WW+Coles pair with the "no lone unit price" rule: when BOTH stores
// are priced but only ONE resolves a size, show $/100 for NEITHER - a single
// side's $/100 (because only that store's name/cup-price carries a size) is a
// confusing asymmetry between the two columns. If only one store is priced at
// all, there's nothing to compare against, so its $/100 shows normally.
function per100Pair(ww, co) {
  const w = clientPer100(ww), c = clientPer100(co);
  const bothPriced = ww && ww.price != null && co && co.price != null;
  if (bothPriced && (w.value == null) !== (c.value == null)) {
    // blanked=true tells the renderer to suppress even the raw fmtUnit fallback,
    // so BOTH columns are truly empty (not just missing the $/100 figure).
    return { ww: { value: null, label: w.label, blanked: true }, coles: { value: null, label: c.label, blanked: true } };
  }
  return { ww: w, coles: c };
}

// ── Per-kg single source of truth ────────────────────────────────────────────
// Every per-kg number in the UI (current price, history modal, trend bar) is
// derived through these so the values can never diverge. They lived in app.js
// until history-modal.js - which hot-deals.html loads WITHOUT app.js - started
// calling perKgRatio: opening a per-kg group member's price history from Hot
// Deals threw "perKgRatio is not defined" and the modal silently never opened.
function clientPerKg(result) {
  if (!result || result.price == null) return null;
  const p = clientPer100(result);
  return p.value != null ? +(p.value * 10).toFixed(2) : null;
}

// Pack-price → $/kg multiplier for one store's result. Ratio is the store's own
// current $/kg over its current pack price; applied to that store's historical
// pack prices. Returns null when the store has no usable size/price data - the
// caller must then DROP that store's history rather than treat raw pack prices
// as $/kg (that mislabelling was a recurring source of wrong trend numbers).
// ponytail: assumes pack size is stable over the item's history - if a product's
// pack size changed, older points convert with the current ratio. Acceptable for
// a personal grocery tracker; the upgrade path is storing size per history entry.
function perKgRatio(res) {
  const kg = clientPerKg(res);
  return (kg != null && res?.price) ? kg / res.price : null;
}

// THE money formatter for the whole site. Grouped thousands: a basket total of
// "$1059.16" is genuinely hard to read at a glance and was doing so on every
// page. Lived as three identical copies in app.js, hot-deals and the basket.
function fmt(n) {
  if (n == null || n === '' || isNaN(Number(n))) return '-';
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A COMPARISON metric ($/kg, or $/piece for a perPack category), not a shelf
// price. Two decimals is right for money but destroys a per-piece category
// whose whole point is small differences: baby wipes run 2.9c to 14.2c each, so
// at 2dp ALDI's $0.0286, Goat's $0.0312 and Little One's $0.0317 all print as
// "$0.03" - three different winners rendered identically. Below 20c the third
// decimal is the only digit carrying the comparison, so it is shown.
// ponytail: a flat threshold, not a significant-figures rule. A category whose
// members straddle $0.20 would show mixed precision in one column; none does
// today (nappies are 29-48c, wipes are all under 15c). If one ever does, switch
// this to decide once per group from the group's own min value.
const UNIT_METRIC_3DP_BELOW = 0.20;
function fmtUnitMetric(n) {
  if (n == null || isNaN(Number(n))) return '-';
  const v = Number(n);
  return '$' + v.toFixed(Math.abs(v) < UNIT_METRIC_3DP_BELOW ? 3 : 2);
}

// How many pieces a per-piece category QUOTES its price for.
// A wipe at $0.029 and a wipe at $0.032 are both "about three cents" to read,
// and neither moves the needle against a $400 shop - but $2.90 vs $3.20 per 100
// is a real difference you can act on. Woolworths and Coles print exactly this
// on the same shelves ("$10.93 / 100EA"), so quoting per 100 also makes our
// number checkable against the store's own label.
//
// It is per CATEGORY, not global, because the right quote is "about one pack".
// Wipes and dishwasher tablets come in 60-640, so 100 reads naturally. Nappies
// come in 26-60, and quoting a 100-nappy price invents a pack nobody sells -
// 50 is the honest unit there. Editable per category (Compare prices by ->
// Per piece), which is why the seeds below carry `quote`.
const PIECE_QUOTES = [1, 10, 50, 100];
const PER_PIECE_QUOTE = 100;      // fallback when a perPack category names none

// Pieces this category quotes its per-piece price for. 1 = plain "each".
function pieceQuoteOf(g) {
  const q = Number(g && (g._quote ?? g.quote));
  return PIECE_QUOTES.includes(q) ? q : PER_PIECE_QUOTE;
}

// The suffix that belongs next to a quoted per-piece figure.
function pieceQuoteSuffix(q) {
  return q === 1 ? ' each' : ' /' + q;
}

// A metric value as DISPLAYED. Per-piece categories are shown per `quote`
// pieces; everything else shows what it stores.
// DISPLAY ONLY, and that is the whole point: _wwPerKg/_coPerKg stay per ONE
// piece because groupStoreTotal() and the Total column multiply them by the
// quantity actually bought. Scaling the stored value would multiply every
// basket total and saving by the quote.
function metricShown(group, v) {
  if (v == null || isNaN(Number(v))) return null;
  return (group && group._perPack) ? Number(v) * pieceQuoteOf(group) : Number(v);
}

// Price the SAME QUANTITY at both stores. Comparing pack prices across stores
// silently compares different amounts of food: Woolworths sells salmon as a
// $34 fillet pack and Coles as a $10 portion, so a pack-price comparison says
// Coles is $24 cheaper when per-kg it is dearer ($34/kg vs $50/kg) - the
// comparison doesn't just blur, it INVERTS.
// Where both stores expose a per-100 rate, the rival's cost is restated at the
// Woolworths pack quantity. When pack sizes already match this is an identity
// (per100Co === coPrice / qty), so it can be applied unconditionally; it only
// bites when the sizes genuinely differ. Falls back to pack prices when either
// rate is missing, and says so via `normalised` for callers that want to flag it.
function sameQtyCost(wwPrice, coPrice, per100Ww, per100Co) {
  if (wwPrice == null || coPrice == null) return null;
  if (per100Ww > 0 && per100Co > 0) {
    const qty = wwPrice / per100Ww;              // WW pack size, in per-100 units
    return { ww: +wwPrice, co: +(per100Co * qty).toFixed(2), normalised: true };
  }
  return { ww: +wwPrice, co: +coPrice, normalised: false };
}

// Restate a per-100 measure ($/100g, $/100ml) at the price actually being
// charged rather than the shelf ticket. When a multi-buy drops the headline, a
// $/100g still figured off the ticket contradicts the number directly above it.
// Pack size is what the measure divides by and that never changes, so scaling
// by effective÷shelf is exact rather than an approximation.
// Returns the input untouched when there is no measure, no shelf price, or the
// two prices agree - callers can pass results straight through.
function scalePer100(p100, shelfPrice, effPrice) {
  if (!p100 || p100.value == null) return p100;
  if (!shelfPrice || effPrice == null) return p100;
  if (Math.abs(effPrice - shelfPrice) < 0.0001) return p100;
  return { ...p100, value: p100.value * (effPrice / shelfPrice) };
}

// ── Exclusion-key parsing ───────────────────────────────────────────────────
// One parser for pw_exclusions_v1 keys, which exist in three historical formats:
// bare numbers, bare strings ("3.50"), and store-prefixed strings ("ww:3.50" /
// "coles:3.50"). Returns a Set of "X.XX" price strings with prefixes stripped -
// for mixed WW+Coles series a price excluded at either store is dropped entirely
// (matches buildPriceBar's documented behaviour).
function exclPriceSet(exclKeys) {
  return new Set((exclKeys || []).map(k => {
    const s = String(k);
    return Number(s.includes(':') ? s.split(':')[1] : s).toFixed(2);
  }));
}

// What you'd actually pay per unit at this store RIGHT NOW, at the quantity
// you're buying: the multi-buy effective rate ONLY once the deal is genuinely
// live (units >= the deal quantity), otherwise the shelf price. A deal you
// haven't qualified for isn't a price you can pay, so it must not drag the
// trend marker down - the marker would claim an all-time low you can't buy.
// Same formula as the price column, so the number under the marker and the
// number in the cell are always the same. Returns null when unpriced.
// The lowest per-unit price this store is offering, ignoring how many you're
// buying: the multi-buy rate when it beats the ticket, else the ticket price.
// This is the number the HISTORY records and the history chart plots - a promo
// price is a real price the item sold at, so it belongs in the range and the
// trend. Distinct from mbUnitPrice(), which is qty-gated because the trend
// MARKER must only claim a price you have actually qualified for.
function promoUnitPrice(res) {
  if (!res || res.price == null) return null;
  const mb = res.multi_buy;
  if (mb?.qty > 0 && mb.total != null) {
    const per = mb.total / mb.qty;
    if (per < res.price) return +per.toFixed(2);
  }
  return res.price;
}

function mbUnitPrice(res, units = 1) {
  if (!res || res.price == null) return null;
  const mb = res.multi_buy;
  if (mb?.qty > 0 && mb.total != null && units >= mb.qty) {
    return multiBuyCost(units, res.price, mb) / units;
  }
  return res.price;
}

// ── Unified trend data source ──────────────────────────────────────────────
// Single series for both slider and sort: includes price_history + current prices.
// `units` is the quantity the shopper is actually buying - it decides whether a
// multi-buy counts (see mbUnitPrice). Defaults to 1 for callers with no Qty
// concept (hot-deals), where a deal needing 2+ is correctly not yet in effect.
function getTrendSeries(item, units = 1) {
  // Include every observed price: Excel receipts (price_history) plus the scraped
  // WW and Coles histories. Previously only price_history was used, so items whose
  // lows live in ww_price_history (e.g. added from receipts) showed a too-high
  // trend minimum.
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ];
  // Honour the user's excluded history points (pw_exclusions_v1) here so the
  // sort ranks items by the same series the bar draws. loadExclusions() is a
  // function declaration in app.js/hot-deals.html - hoisted and available by
  // the time this actually runs (renders always happen after page scripts
  // finish loading), even though this file is included first.
  const excluded = exclPriceSet(loadExclusions()[item.list_item]);
  const histPrices = hist
    .map(h => Number(h.price))
    .filter(p => p > 0 && !excluded.has(p.toFixed(2)));
  // Current price = what you'd actually pay per unit RIGHT NOW, so a live
  // multi-buy counts. Using the sticker here meant a promo that beat the
  // all-time low still plotted mid-range: the price column showed the green
  // effective price while the trend marker sat nowhere near the left end, and
  // the off-range marker (below every price ever seen) was unreachable via a
  // promo. History stays at sticker prices - those are what was observed then.
  const w = mbUnitPrice(item.woolworths, units), c = mbUnitPrice(item.coles, units);
  const prices = [...histPrices, w, c].filter(p => typeof p === 'number' && p > 0);
  const current = Math.min(
    w != null ? w : Infinity,
    c != null ? c : Infinity
  );
  // `prices` (history + both current prices) is the SORT series - current has to
  // be inside it for a stable 0..1 ranking.
  // `past` is history only, and is what the trend BAR is drawn against: a bar
  // whose range already contains the current price can never show it as
  // off-range, which is why the "below everything ever seen" marker had quietly
  // become unreachable. Keeping them separate is what makes it fire again.
  return {
    prices,
    past: histPrices.filter(p => typeof p === 'number' && p > 0),
    current: isFinite(current) ? current : null,
  };
}


// `historyBtn` renders the clock/"History" button that opens the price-history
// modal. Pages that do not host that modal pass false rather than shipping a
// button that does nothing when clicked.
function buildPriceBar(itemName, priceHistory, currentPrice, factor = 1, historyBtn = true) {
  if (!priceHistory?.length || currentPrice == null) return '';

  // exclPriceSet (utils.js) handles both "ww:X.XX"/"coles:X.XX" and legacy bare keys.
  // For trend bars (mixed WW+Coles series) a price excluded at either store is dropped.
  const excluded = exclPriceSet(loadExclusions()[itemName]);
  // Use raw history prices - they are already in the same monetary units (pack/shelf price)
  // as currentPrice. _ww_price_factor is only used for cheaper_store comparison in the scraper.
  const prices = priceHistory
    .map(p => p.price)
    .filter((p, i) => p > 0 && !excluded.has(Number(priceHistory[i].price).toFixed(2)));
  if (prices.length < 2) return '';

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  if (minP === maxP) {
    const safeItemName = itemName.replace(/"/g, '&quot;');
    let flatTrack;
    if (currentPrice < minP - 0.005) {
      // Current price is below all historical prices - green circle left
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-marker-off-left"></div><div class="price-bar price-bar-flat"></div></div>`;
    } else if (currentPrice > minP + 0.005) {
      // Current price is above all historical prices - red circle right
      flatTrack = `<div class="price-bar-track-wrap"><div class="price-bar price-bar-flat"></div><div class="price-marker-off-right"></div></div>`;
    } else {
      flatTrack = `<div class="price-bar price-bar-flat"><div class="price-marker" style="left:50%"></div></div>`;
    }
    return `
    <div class="price-bar-outer">
      ${flatTrack}
      <div class="price-bar-labels price-bar-labels-flat"><span class="price-bar-always">${fmt(minP)}</span></div>
    </div>
    ${historyBtn ? `<button class="price-bar-manage" data-manage-item="${safeItemName}" aria-label="View price history"><svg class="pbm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg><span class="pbm-txt">History</span></button>` : ''}`;
  }

  const rawPos = ((currentPrice - minP) / (maxP - minP)) * 100;
  const pos = Math.max(0, Math.min(100, rawPos));
  // (The old hover histogram tooltip was removed as redundant - the History
  // modal, one click away on the always-visible clock icon, shows the same
  // data properly.)
  const safeItemName = itemName.replace(/"/g, '&quot;');

  // Off-range: green circle LEFT (price below min) or red circle RIGHT (price above max)
  let trackHtml;
  if (rawPos < 0) {
    trackHtml = `<div class="price-bar-track-wrap"><div class="price-marker-off-left"></div><div class="price-bar"></div></div>`;
  } else if (rawPos > 100) {
    trackHtml = `<div class="price-bar-track-wrap"><div class="price-bar"></div><div class="price-marker-off-right"></div></div>`;
  } else {
    trackHtml = `<div class="price-bar"><div class="price-marker" style="left:${pos.toFixed(1)}%"></div></div>`;
  }

  const allTimeLowBadge = rawPos === 0 ? '<span class="trophy-icon" title="All-time low - the cheapest this item has ever been recorded at">🏆</span>' : '';
  return `
    <div class="price-bar-outer">
      ${trackHtml}
      <div class="price-bar-labels">
        <span>${fmt(minP)}${allTimeLowBadge}</span>
        <span>${fmt(maxP)}</span>
      </div>
    </div>
    ${historyBtn ? `<button class="price-bar-manage" data-manage-item="${safeItemName}" aria-label="View price history"><svg class="pbm-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg><span class="pbm-txt">History</span></button>` : ''}`;
}

// ── Trend Position Calculation ──────────────────────────────────────────────
// Returns 0.0–1.0 where current best price sits in purchase-history range:
//   0.0 = at/below all-time low   (best deal, maximum savings)
//   0.5 = flat history or middle
//   1.0 = at/above all-time high  (worst deal, least savings)
//   999 = no usable history (sorts last)

function calcTrendPosition(item, units = 1) {
  // Measured against history ONLY (`past`), the same series the bar is drawn
  // against - so the sort order and the marker position always agree.
  const { past, current } = getTrendSeries(item, units);
  if (past.length < 2 || current == null) return 999;
  const lo = Math.min(...past), hi = Math.max(...past);
  // Flat history (one price ever seen): off-range in EITHER direction. Returning
  // 0.5 for "dearer than the only price we know" put Dill Fresh and Parsley -
  // freshly up from $3.20 to $3.30, so genuinely off the top - in the middle of
  // a trend sort, between items that are actually mid-range.
  if (lo === hi) {
    if (current < lo - 0.005) return -1;
    if (current > lo + 0.005) return 2;
    return 0.5;
  }
  // Clamped at NEITHER end, on purpose. Below everything ever recorded is
  // "better than the best we've seen" and must sort ahead of an item merely at
  // its own low (0); above everything is worse than one at its own high (1) and
  // must sort behind it. Clamping collapsed each pair into one score, which is
  // why off-chart rows landed among ordinary ones instead of at the extremes.
  return (current - lo) / (hi - lo);
}

// ── Trend Sort Comparator ──────────────────────────────────────────────────
// Sorts items by trend position (best value first on asc, worst value first on desc)
// Tiebreak: alphabetical item name for deterministic ordering

function sortByTrend(items, dir = 'asc') {
  return [...items].sort((a, b) => {
    const pa = calcTrendPosition(a);
    const pb = calcTrendPosition(b);
    const cmp = pa - pb;
    if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    return a.list_item.localeCompare(b.list_item);
  });
}

// ── Deal Quality ──────────────────────────────────────────────────────────
// A "hot deal" is a price that is meaningfully LOW relative to the item's own
// price history. The old rule (all-time-low within 1¢ OR bottom 20%) flagged
// trivial deals: an item that only ever sells $3.80–$3.90 hits its "all-time
// low" at $3.80, but that's a 2.6% range - not worth surfacing.
//
// getDealQuality() measures the DEPTH of the discount against the item's
// TYPICAL (median) historical price and requires the price to actually move
// over time before anything qualifies, so flat items drop out.
//
//   typical   = median of historical prices (the "usual" shelf price)
//   spread    = (hi - lo) / hi   - how much the price varies historically
//   dropPct   = (typical - currentBest) / typical - how far below usual we are
//   saveAmount= max(0, typical - currentBest) - $ saved vs the usual price
//
// Qualifies when the price varies enough (spread ≥ MIN_SPREAD) AND the current
// price is a real discount (dropPct ≥ MIN_DROP, or an all-time low). Ranking is
// by dropPct (deepest discount first).

const DEAL_MIN_SPREAD = 0.05;  // price must vary ≥5% historically to count
const DEAL_MIN_DROP   = 0.04;  // current must be ≥4% below the usual price

function _median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function getDealQuality(item, exclusions) {
  const empty = { qualifies: false };
  if (item.archived) return empty;

  // Historical (past) prices only - the "usual" price is what it cost before now.
  // exclPriceSet handles the "ww:X.XX"/"coles:X.XX" key format - the old inline
  // Number(p).toFixed(2) turned prefixed keys into "NaN", silently disabling
  // exclusions for hot-deal detection (an excluded bogus low still made a 🔥).
  const excludedSet = exclPriceSet(exclusions && exclusions[item.list_item]);
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].map(h => Number(h.price))
   .filter(p => p > 0 && !excludedSet.has(p.toFixed(2)));
  if (hist.length < 2) return empty;

  // promoUnitPrice, not the shelf price: a multi-buy that takes an item below
  // everything it has ever sold for IS a deal, and reading the ticket price hid
  // exactly those from this page (e.g. Sam's Salted Caramel Nut Bar - an
  // all-time low on the promo rate, absent from Hot Deals entirely). History is
  // recorded at the promo rate too, so both sides of the comparison now agree.
  const wwP = promoUnitPrice(item.woolworths);
  const coP = promoUnitPrice(item.coles);
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return empty;
  const store = (coP != null && coP <= (wwP ?? Infinity)) ? 'coles' : 'woolworths';
  // A dead heat is not a win for either store. The rule above breaks ties
  // towards Coles, which then flew a red chip over "$8 at both" and read as a
  // claim that Coles was cheaper. Callers show no chip when this is true.
  const tied = wwP != null && coP != null && Math.abs(wwP - coP) < 0.005;

  // The SHELF prices, kept alongside the promo ones. The two are not
  // interchangeable and confusing them produced a visible contradiction: Top
  // Deck is $4 at Woolworths and $8 at Coles, but Coles runs "2 for $10", so
  // the promo rate is $5 and the Save column read "$1" directly beside two
  // columns showing $4 and $8. Deal DETECTION still uses the promo rate (a
  // multi-buy that beats every price ever recorded is a real deal), but any
  // figure shown next to the price columns has to be computed from the same
  // numbers those columns display - and at quantity 1, which is the only
  // quantity a per-item saving can honestly assume.
  const wwShelf = item.woolworths?.price ?? null;
  const coShelf = item.coles?.price ?? null;
  const shelfPrice      = store === 'woolworths' ? wwShelf : coShelf;
  const otherShelfPrice = store === 'woolworths' ? coShelf : wwShelf;

  const lo = Math.min(...hist), hi = Math.max(...hist);
  const typical = _median(hist);

  // Everything observed BEFORE today, and when the price last actually moved.
  // Both read the dated entries; undated ones (old Excel receipts) count as past
  // because they certainly are.
  const _today = new Date().toISOString().slice(0, 10);
  const dated = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].filter(h => Number(h.price) > 0 && !excludedSet.has(Number(h.price).toFixed(2)))
   .map(h => ({ date: String(h.date || '').slice(0, 10), price: Number(h.price) }))
   .sort((a, b) => a.date.localeCompare(b.date));
  const past = dated.filter(h => !h.date || h.date < _today).map(h => h.price);

  // Months since the price last CHANGED (not since it was last checked). An item
  // frozen for a year is noise on this page; one that swings every 8 weeks is
  // exactly what belongs here even if it is between swings right now.
  let lastChange = null;
  for (let i = 1; i < dated.length; i++) {
    if (Math.abs(dated[i].price - dated[i - 1].price) > 0.005) lastChange = dated[i].date;
  }
  const monthsSinceChange = lastChange
    ? (Date.now() - Date.parse(lastChange)) / (30.44 * 86400000)
    : (dated.length ? Infinity : null);   // never moved in all the history we hold
  const spread = hi > 0 ? (hi - lo) / hi : 0;
  const dropPct = typical > 0 ? (typical - currentBest) / typical : 0;
  const saveAmount = Math.max(0, typical - currentBest);
  // "All-time low" is measured against the price BEFORE today. The scrape writes
  // today's price into the very history it was being compared with, so
  // `currentBest <= min(everything)` was true whenever today merely TIED the old
  // minimum - which, on a price that never moves, is true every week forever.
  // That fired the trophy on a fifth of the catalogue and made it worthless.
  const priorLo = past.length ? Math.min(...past) : lo;
  const isAllTimeLow = past.length > 0 && currentBest < priorLo - 0.005;
  // Where today sits in its own past year: 0.94 = cheaper than 94% of what it
  // has actually sold for. A rank, not a binary, so "unusually cheap" survives
  // on an item that simply never sets new records.
  const pricePercentile = past.length
    ? past.filter(p => p > currentBest + 0.005).length / past.length
    : 0;

  // Recency guard: "below the long-run median" is not a deal if the item was
  // CHEAPER within the last fortnight - the price went up, not down. Items
  // with no dated recent entries keep the old behaviour.
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const recent = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].filter(h => h.date >= cutoff && Number(h.price) > 0 && !excludedSet.has(Number(h.price).toFixed(2)))
   .map(h => Number(h.price));
  const notAboveRecent = !recent.length || currentBest <= Math.min(...recent) + 0.01;

  const qualifies = spread >= DEAL_MIN_SPREAD && notAboveRecent && (dropPct >= DEAL_MIN_DROP || isAllTimeLow);

  // Cross-store gap (secondary "savings": buying at the cheaper store vs the other)
  const otherPrice = store === 'woolworths' ? coP : wwP;
  const savingPct = (otherPrice != null && otherPrice > 0)
    ? (otherPrice - currentBest) / otherPrice : 0;

  // A rank reads as information; a trophy on a fifth of the catalogue reads as
  // decoration. The trophy is now reserved for a genuine new low.
  const reason = isAllTimeLow
    ? '🏆 Cheapest ever'
    : pricePercentile >= 0.5
    ? `Cheaper than ${Math.round(pricePercentile * 100)}% of the past year`
    : `↓ ${Math.round(dropPct * 100)}% below usual`;

  // Same guard the Buy/Wait panel uses (bwsComparable, below): min(ww, coles)
  // is only a price when both listings are the same amount of food. Woolworths
  // salmon at $38/kg "beaten" by a $10 Coles portion restates to $50/kg - dearer,
  // not cheaper. Carried through so dealPassesTune can refuse it before the ATL
  // trophy or the sliders get a chance to wave it through.
  const comparable = bwsComparable(item);

  return {
    qualifies, store, price: currentBest, otherPrice,
    tied, shelfPrice, otherShelfPrice,
    typical, lo, hi, spread, dropPct, saveAmount, isAllTimeLow,
    notAboveRecent, savingPct, reason, comparable,
    pricePercentile, monthsSinceChange,
  };
}

// Pass the pw_exclusions_v1 map so the 🔥 filter/badges agree with the
// Hot Deals page (getHotDealItems), which always applies exclusions.
// Tune-aware: the badges follow the user's Hot Deals sliders/mode, so the set
// of 🔥 rows on the main page IS the set of rows on the Hot Deals page.
function isHotDeal(item, exclusions) {
  return dealPassesTune(getDealQuality(item, exclusions), loadDealTune());
}

// ── GitHub Contents-API JSON read/write ─────────────────────────────────────
// Single reader/writer for every synced data file (was 7 near-identical copies
// across app.js and hot-deals.html). githubPutJson GETs the fresh blob sha
// immediately before the PUT and retries once on 409 (stale sha from a
// concurrent writer). Base64 is unicode-safe both ways - plain btoa() throws on
// non-Latin-1 product names, and plain atob() mangles them on read. Throws on
// failure so each caller keeps its own reporting (alert / showSyncError /
// fire-and-forget). validate.html keeps its own githubPut: it threads a known
// sha end-to-end for its stale-read race fix, different semantics.
// ── Multi-buy pricing ───────────────────────────────────────────────────────
// `mb` is the normalised {qty, total} the scraper writes for BOTH stores, where
// total is the price of one whole promo block. (The two stores publish different
// shapes - WW's MultibuyData.Price is already a total, Coles' multiBuyPromotion
// .reward is per-unit and gets multiplied - scraper.py normalises before this.)
//
// Whole blocks price at the deal rate, the remainder pays shelf: 3 dips against
// "2 for $7" at $4.50 each = $7.00 + $4.50, not $10.50 and not $21.
// Deliberately reports what the store WILL charge, even if a "deal" is dearer
// than buying singles - the app mirrors the shelf, it doesn't second-guess it.
// Per-SKU only: "any 2 from this range" offers are not modelled.
// Mirrored by multi_buy_cost() in scripts/multibuy_selfcheck.py.
function multiBuyCost(qty, unitPrice, mb) {
  if (!(qty > 0) || !(unitPrice >= 0)) return 0;
  if (!mb || !mb.qty || mb.total == null || qty < mb.qty) {
    return +(qty * unitPrice).toFixed(2);
  }
  const blocks = Math.floor(qty / mb.qty);
  const rest = qty % mb.qty;
  return +(blocks * mb.total + rest * unitPrice).toFixed(2);
}

// How many MORE units are needed to reach the next promo block, and what that
// step would save versus paying shelf price for them. null when there's no
// promo or the shopper is already exactly on a block boundary.
function multiBuyNudge(qty, unitPrice, mb) {
  if (!mb || !mb.qty || mb.total == null || !(unitPrice > 0)) return null;
  const rest = qty % mb.qty;
  const need = rest === 0 ? (qty === 0 ? mb.qty : 0) : mb.qty - rest;
  if (need <= 0) return null;
  const saving = +(multiBuyCost(qty, unitPrice, mb) + need * unitPrice
                   - multiBuyCost(qty + need, unitPrice, mb)).toFixed(2);
  return saving > 0 ? { need, saving } : null;
}

// ── Viewer (read-only) mode ─────────────────────────────────────────────────
// A VIEWER is anyone without a GitHub token. Every repo-write path below already
// refuses to run without that token, so this is a UX/behaviour layer over an
// existing security boundary, not the boundary itself: it hides controls that
// could only ever fail for a visitor, and keeps their priorities/categories in
// their own browser instead of letting the owner's published settings overwrite
// them. `?setup=1` forces owner mode so the owner can paste a token on a new
// device (the token form is hidden from viewers).
// NOTE: header.js carries its own copy - it deliberately runs before utils.js.
// Keep the two in sync.
function isViewerMode() {
  try {
    if (new URLSearchParams(location.search).has('setup')) return false;
    return !(localStorage.getItem('gh_token') || '').trim();
  } catch { return true; }   // storage blocked → assume viewer, the safe side
}

// GitHub connection settings. Lives here (not app.js) because scrape-log needs
// it too - it dispatches the "retry the misses" run. validate.html keeps its own
// copy: it is the one page that doesn't load utils.js.
function loadSettings() {
  return {
    user:  localStorage.getItem('gh_user')  || 'jtsenter',
    repo:  localStorage.getItem('gh_repo')  || 'price-comparison',
    token: localStorage.getItem('gh_token') || '',
  };
}

// Pre-flight for anything that dispatches a workflow: the scrape runs on a
// self-hosted PC, and a dispatch to an offline runner queues silently forever.
// FAILS OPEN on any API/network error - a flaky check must not block a scrape.
async function getRunnerStatus(s) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${s.user}/${s.repo}/actions/runners`,
      { headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) return { anyOnline: true, runners: [] };
    const data = await res.json();
    const selfHosted = (data.runners || []).filter(r =>
      r.labels?.some(l => l.name === 'self-hosted')
    );
    const anyOnline = selfHosted.length > 0 && selfHosted.some(r => r.status === 'online');
    return { anyOnline, runners: selfHosted };
  } catch {
    return { anyOnline: true, runners: [] };
  }
}

function _ghHeaders(s) {
  return { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
}
async function githubGetJson(s, repoPath) {
  const res = await fetch(`https://api.github.com/repos/${s.user}/${s.repo}/contents/${repoPath}`, { headers: _ghHeaders(s) });
  if (!res.ok) return {};
  const meta = await res.json();
  if (!meta.content) return {};
  try { return JSON.parse(decodeURIComponent(escape(atob(meta.content.replace(/\n/g, ''))))); } catch { return {}; }
}
async function githubPutJson(s, repoPath, data, message) {
  const apiPath = `https://api.github.com/repos/${s.user}/${s.repo}/contents/${repoPath}`;
  const headers = _ghHeaders(s);
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2) + '\n')));
  const doPut = async () => {
    const getRes = await fetch(apiPath, { headers });
    const meta = getRes.ok ? await getRes.json() : {};
    // Skip the write when the repo already holds byte-identical content. GitHub's
    // contents API commits even for an unchanged blob, so the UI's on-boot syncs
    // (priorities/watchlist/archived) were spamming main with no-op commits on
    // every page load. meta.content is base64 wrapped at 60 cols; strip newlines
    // to compare against our unwrapped base64 of the same bytes.
    if (meta.content && meta.content.replace(/\n/g, '') === content) return { ok: true };
    const body = { message, content };
    if (meta.sha) body.sha = meta.sha;
    return fetch(apiPath, { method: 'PUT', headers, body: JSON.stringify(body) });
  };
  let putRes = await doPut();
  if (putRes.status === 409) putRes = await doPut();
  if (!putRes.ok) {
    const msg = await putRes.text().catch(() => String(putRes.status));
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg}`);
  }
}

// ── "Worth the detour?" ─────────────────────────────────────────────────────
// One-store shopping leaves money on the table, but splitting means a second
// trip. Nearly always the saving is concentrated in a handful of items, so the
// useful answer is not "split saves $56" but "these three are worth $48, the
// other 21 are worth $8 between them - grab the three and skip the rest".
//
// rows: [{ name, here, there, saving }] already priced at BOTH stores, `here`
// being the store currently being shopped. Returns null when the prompt should
// stay silent, which is most weeks - that silence is what keeps it credible.
const DETOUR_MAX_ITEMS  = 3;
const DETOUR_MIN_TOTAL  = 10;    // dollars: below this a detour is never worth it
const DETOUR_MIN_SHARE  = 0.6;   // the top few must carry this much of the saving
function detourAdvice(rows, opts) {
  const o = opts || {};
  const maxItems = o.maxItems || DETOUR_MAX_ITEMS;
  const minTotal = o.minTotal != null ? o.minTotal : DETOUR_MIN_TOTAL;
  const minShare = o.minShare != null ? o.minShare : DETOUR_MIN_SHARE;
  const gains = (rows || []).filter(r => r && r.saving > 0).sort((a, b) => b.saving - a.saving);
  if (!gains.length) return null;
  const total = gains.reduce((s, r) => s + r.saving, 0);
  const top = gains.slice(0, maxItems);
  const topTotal = top.reduce((s, r) => s + r.saving, 0);
  if (topTotal < minTotal) return null;                 // not worth a detour at all
  const share = total > 0 ? topTotal / total : 0;
  // If the saving is spread evenly there is no "few items" story to tell, and
  // saying "move your 3 biggest" would be arbitrary rather than useful.
  if (share < minShare) return null;
  return {
    items: top, topTotal: +topTotal.toFixed(2), total: +total.toFixed(2),
    share, restCount: gains.length - top.length,
    restTotal: +(total - topTotal).toFixed(2),
  };
}

// ── Scrape mode ─────────────────────────────────────────────────────────────
// Quick = only items whose price actually moves. Full = everything.
// The default is quick, EXCEPT that the first run of an ISO week from Wednesday
// onward is a full one - so the long tail is still checked weekly without a
// 20-minute run every day. Once a full scrape has gone out this week the default
// drops back to quick, which is why the week has to be remembered rather than
// just "is it Wednesday" (a second Wednesday click would otherwise re-default to
// full forever). Stored locally: scrapes are only ever triggered from one machine.
const FULL_SCRAPE_WEEKDAY = 3;   // 0=Sun … 3=Wed

// ISO-8601 week key, e.g. "2026-W33". Thursday-based, so a week never splits
// across a year boundary the way a naive day-of-year division does.
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
function lastFullScrapeWeek() {
  try { return localStorage.getItem('pw_last_full_scrape_week') || ''; } catch { return ''; }
}
function markFullScrapeDone(now) {
  try { localStorage.setItem('pw_last_full_scrape_week', isoWeekKey(now || new Date())); } catch {}
}
// -> { mode, reason } so the menu can say WHY it is about to do the slow one.
function defaultScrapeMode(now) {
  const d = now || new Date();
  const doneThisWeek = lastFullScrapeWeek() === isoWeekKey(d);
  // Sunday counts as the END of the ISO week, not the start, so it is "past
  // Wednesday" like Thu-Sat rather than before it.
  const pastWednesday = d.getDay() >= FULL_SCRAPE_WEEKDAY || d.getDay() === 0;
  if (pastWednesday && !doneThisWeek) {
    return { mode: 'full', reason: "The weekly full scrape hasn't run yet." };
  }
  return {
    mode: 'quick',
    // Three different reasons for "quick", and saying the wrong one is worse
    // than saying nothing - "already done this week" on a Monday is just false.
    reason: doneThisWeek
      ? 'The weekly full scrape has already run.'
      : 'The weekly full scrape is due Wednesday.',
  };
}

// ── Per-kg variant groups (seed data) ───────────────────────────────────────
// Per-kg categories. Each is a comparable product type; the two near-identical
// salmon-fillet and basa entries are merged so each category holds its real
// equivalents. Membership can be fine-tuned in the edit dialog (DEFAULT_VARIANT_GROUPS
// is the seed; user overrides live in localStorage - see loadVariantGroups()).
const DEFAULT_VARIANT_GROUPS = [
  { key: 'chicken_breast', label: 'Chicken Breast', items: [
    'Woolworths RSPCA Approved Chicken Breast Fillet',
    'Macro Chicken Breast Fillets Free Range 700g - 1.4kg',
    'Macro RSPCA Approved Chicken Breast Free Range Single 300g',
    'Macro Organic Chicken Breast Fillet 500g - 750g',
    'The Bare Bird Free Range Chicken Breast Fillets 600g',
    'Coles RSPCA Approved Chicken Breast Fillets Large Pack 1.4kg',
    'Coles RSPCA Approved Chicken Breast Fillets Small Pack 600g',
    'Coles RSPCA Approved Free Range Chicken Breast Large Pack 1.25kg',
    'Coles RSPCA Approved Free Range Chicken Breast Fillet Small Pack 600g',
    'Lilydale Free Range Chicken Breast Fillets Bulk 1kg',
  ]},
  { key: 'chicken_drumsticks', label: 'Chicken Drumsticks', items: [
    'Woolworths RSPCA Approved Chicken Drumsticks',
    'Macro Free Range Chicken Drumsticks 750g - 1.1kg',
    'Coles RSPCA Approved Chicken Drumsticks 2kg',
    'Coles RSPCA Approved Free Range Chicken Drumsticks 1.4kg',
    'Lilydale Free Range Chicken Drumsticks Bulk 1kg',
  ]},
  { key: 'chicken_thigh', label: 'Chicken Thigh', items: [
    'Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone-In',
    'Macro Free Range Chicken Thigh Fillet 800g - 1.1kg',
    'Coles RSPCA Approved Chicken Thigh Fillets Large Pack',
    'Coles RSPCA Chicken Thigh Fillets Small Pack',
    'Coles RSPCA Approved Chicken Thigh Cutlets',
    'Coles RSPCA Approved Free Range Chicken Thigh Large Pack',
    'Coles RSPCA Approved Free Range Chicken Thigh Cutlets 1.05kg',
    'Lilydale Free Range Chicken Thigh Fillets Bulk',
    'Lilydale Free Range Chicken Thigh Fillets Small Pack 545g',
    'Inglewood Farms Chicken Thigh Fillets Skin Off',
    'El-Amins Halal Chicken Thigh Fillets Large Pack',
    'The Bare Bird Chicken Thigh Fillets',
    'El Amins Halal Chicken Thigh Cutlets',
  ]},
  { key: 'salmon', label: 'Salmon', items: [
    'Woolworths Fresh Tasmanian Atlantic Skin On Salmon Fillets',
    'Woolworths Salmon Portions Skin On',
    'Woolworths Diced Tasmanian Salmon Skin Off 300g',
    'Tassal Atlantic Salmon Skin On 300g',
    'Tassal Atlantic Salmon Skin Off 300g',
    'Coles Tasmanian Salmon Portions Skin On 4 Pack 460g',
    'Coles Tasmanian Salmon Portions Skin Off 460g',
    'Tassal Salmon Portions Skin On 300g',
  ]},
  { key: 'basa_fillets', label: 'Basa Fillets', items: [
    'Woolworths Basa Fillets Boneless With Skin Off',
    'I&J Frozen Basa Fillets 750g',
    'Coles Frozen Basa Fillet',
  ]},
  { key: 'beef_mince', label: 'Beef Mince', items: [
    'Woolworths Lean Beef Mince',
    'Woolworths Heart Smart Extra Lean Beef Mince 500g',
    'Woolworths Lean Beef Mince 500g',
    'Macro Grass Fed Lean Beef Mince 500g',
    'Macro Organic Extra Lean Beef Mince 500g',
    'Coles No Added Hormone Beef 5 Star Extra Lean Mince 500g',
    'Coles No Added Hormone Beef 4 Star Lean Mince 500g',
    'Coles No Added Hormone Beef 4 Star Lean Mince 800g',
    "Cleaver's Organic Grass-fed Extra Lean Beef Mince 500g",
    "Cleaver's Organic Grass-fed Premium Beef Mince 500g",
    "El-Amin's Beef Lean Mince 500g",
    'Macro Organic Lean Beef Mince 500g',
    'Coles Graze Grass Fed No Added Hormone Beef Mince 500g',
  ]},
  { key: 'lamb_mince', label: 'Lamb Mince', items: [
    'Woolworths Lamb Mince',
    'Macro Grass Fed Australian Lamb Mince 450g',
    'Coles 3 Star Lamb Mince 500g',
    'Coles Graze Lamb Mince 500g',
    "El-Amin's Halal Lamb Mince 500g",
  ]},
  // Porterhouse: pack sizes vary wildly (180g quick-cook → 1kg roast), so only
  // $/kg is comparable - a textbook per-kg group. WW members pinned ww-only in
  // url_overrides.json; the "& Butter" item bridges to a real Coles porterhouse
  // (2-pack 450g) via its coles pin. Coles-specific variants get added as their
  // URLs are captured (Coles rate-bans the scraper's headless session, so they
  // trickle in). Members with no live price at a store simply don't show there.
  { key: 'beef_porterhouse', label: 'Beef Porterhouse Steak', items: [
    'Woolworths Beef Porterhouse Steak & Butter',
    'Woolworths Beef Porterhouse Steak',
    'Woolworths Beef Porterhouse Steak Medium',
    'Woolworths Beef Porterhouse Steak Thick Cut',
    'Macro Grass Fed Beef Porterhouse Steaks 2 Pack',
    // Coles side (coles-only pins). The VSP RR 2-pack (id 4997140) is NOT listed
    // here - it's already the "& Butter" item's coles match, so re-adding it would
    // show the same product twice in the Coles column.
    'Coles No Added Hormone Beef Quick Cook Porterhouse Steak 180g',
    'Coles No Added Hormone Beef Porterhouse Steak With Thyme & Pepper Butter 500g',
    'Coles Finest Carbon Neutral Beef Porterhouse Steak 370g',
    'Drovers Choice Beef Porterhouse Steaks 200g',
    'Drovers Choice No Added Hormone Beef Porterhouse Steak 1kg',
    "Cleaver's Organic Grass-Fed Beef Porterhouse Steak 290g",
  ]},
  // 2026-07 non-meat per-kg groups: pack sizes vary, only cheapest $/kg matters.
  // These carry their own category (buildVariantGroups/buildDealGroups default
  // to Meat & Seafood otherwise).
  { key: 'greek_yoghurt', label: 'Greek Yoghurt', category: 'Dairy & Eggs', items: [
    'Greek Style Yoghurt 2kg',
    'Woolworths Greek Style Yoghurt',
  ]},
  { key: 'washed_potatoes', label: 'Washed Potatoes', category: 'Fruit & Veg', items: [
    'Washed Potato Bag 4kg',
    'Woolworths Washed Potato Bag',
    'Woolworths Red Washed Potatoes Bag',
    // Single-store variants pinned via url_overrides.json. (Coles Washed 2kg and
    // Red Royale 2kg are NOT members: they're already the Coles side of the two
    // WW bag pairs above - listing them again duplicated the products.)
    'Woolworths White Washed Baby Potatoes Bag 1kg',
    'Woolworths Baby Red Washed Potato Bag 1kg',
    'Coles Baby Washed Potatoes 1kg',
    'Coles Kestrel Washed Potatoes 2kg',
    'Coles Carisma Washed Potatoes 2kg',
  ]},
  { key: 'carrots', label: 'Carrots', category: 'Fruit & Veg', items: [
    'Woolworths Australian Grown Carrots',
    'The Odd Bunch Carrots',
    // Single-store variants pinned via url_overrides.json. (Coles I'm Perfect
    // 1.5kg is already the Coles side of The Odd Bunch Carrots pair.)
    'The Odd Bunch Crazy Carrots 5kg',
    'Woolworths Baby Carrots 500g',
    'Macro Organic Carrot Juicing Bag 2kg',
    'Coles Carrots 1kg',
    'Coles Baby Carrots 500g',
    'Coles Organic Carrots 1kg',
  ]},
  { key: 'brown_onions', label: 'Brown Onions', category: 'Fruit & Veg', items: [
    'Woolworths Onion Brown Bag',
    'Woolworths Brown Onions Bag 2kg',
  ]},
  { key: 'red_onions', label: 'Red Onions', category: 'Fruit & Veg', items: [
    'Woolworths Red Onions Bag',
  ]},
  { key: 'nutella', label: 'Nutella', category: 'Sweets', items: [
    'Nutella Hazelnut Chocolate Spread Spread', // the 750g (Excel history)
    // Coles variants pinned via url_overrides.json (coles-only)
    'Nutella Hazelnut Chocolate Spread 400g',
    'Nutella Hazelnut Spread With Cocoa 1kg',
    'Nutella Hazelnut Chocolate Spread 220g',
  ]},
  { key: 'lotus_biscoff', label: 'Lotus Biscoff', category: 'Sweets', items: [
    'Lotus Biscoff Spread',
    'Lotus Biscoff Spread Smooth 720g',
  ]},
  // Seeds and kernels. Every member is a single-store pin (url_overrides.json)
  // and the pack sizes are all over the place - 150g to 1kg - which is exactly
  // what a $/kg category is for: the 1kg Macro chia at $17.00 and the 350g at
  // $6.00 are $17.00/kg and $17.14/kg, near-identical rates that the shelf
  // prices hide completely. Sizes are IN the names on purpose: two of the
  // Woolworths chia URLs are both "macro-black-chia-seeds" and would otherwise
  // collide into one entry.
  { key: 'pumpkin_kernels', label: 'Pumpkin kernels', category: 'Pantry', items: [
    'Macro Natural Pumpkin Kernels 250g',
    'Macro Organic Natural Pumpkin Kernels 250g',
    'Wellness Road Pumpkin Seeds 300g',
  ]},
  { key: 'sunflower_kernels', label: 'Sunflower kernels', category: 'Pantry', items: [
    'Macro Natural Sunflower Kernels 500g',
    'Woolworths Sunflower Seeds 200g',
    'Coles Sunflower Seeds 150g',
    'Wellness Road Sunflower Kernels 500g',
    'Gaganis Premium Raw Sunflower Kernels 500g',
  ]},
  { key: 'chia_seeds', label: 'Chia seeds', category: 'Pantry', items: [
    'Macro Black Chia Seeds 350g',
    'Macro Organic Black Chia Seeds 300g',
    'Macro Black Chia Seeds 1kg',
    'Wellness Road Black Chia Seeds 300g',
    'Red Tractor Black Chia Seeds 600g',
    // A chia MIX, not pure chia - kept because it was on the list, but its $/kg
    // isn't strictly like-for-like. Pull it out via Edit category if it skews.
    'Coles Black Chia Mix 200g',
    'Coles Wellness Road Black Chia Seeds 1kg',
    'Wellness Road Organic Black Chia Seeds 300g',
  ]},

  // STICKER group (sticker: true): compared + displayed by PACK PRICE, not $/kg.
  // For near-same-size complementary products the user treats as interchangeable
  // (like the per-kg groups, but "just a normal category"). WW side = cheapest of
  // the two WW jars; Coles side = cheapest Coles jar. See STICKER_GROUPS below.
  { key: 'bolognese_sauce', label: 'Bolognese sauce', category: 'Pantry', sticker: true, items: [
    'Macro Organic Pasta Sauce Chunky Bolognese',
    'Dolmio Extra Bolognese Tomato Pasta Sauce',
  ]},
  // Nappies are not weighed, so there is no $/kg to compare - they ride here as a
  // STICKER group purely so they sit in the same category system and the same
  // filter as everything else. KNOWN LIMIT: sticker means the panel ranks on PACK
  // price, and these packs are 30 vs 40, so the ranking is not per-nappy yet. The
  // honest metric is price/count, which needs the pack count threaded into
  // groupMetric() - do that rather than pretending the pack prices compare.
  //
  // Every member is a SINGLE-store pin and the category does the cross-store
  // comparison, same as the seed categories. An earlier attempt pinned only the
  // Woolworths URLs with coles_url:"" hoping Coles would still be name-searched -
  // it is not. An empty string is falsy, so scraper.py reads it as a single-store
  // pin and skips Coles by design ("a single-store pin means a single store").
  // Both nappies came back Coles-less because of it.
  // perPack implies sticker (no $/kg anywhere in the pipeline) but ranks on
  // price PER NAPPY, which is the only figure that compares a 30-pack with a
  // 40-pack. sticker stays true so the basket, history and hot-deals paths that
  // key off it keep treating this as a pack-bought, non-weighed category.
  // Compared per BAG. Rolls run 10 to 100 bags, and the bag SIZE (56L, 76L)
  // varies independently of the count, so neither pack price nor litres ranks
  // these usefully - price per bag is the number you actually compare.
  { key: 'garbage_bags_xl', label: 'Garbage bags (extra large)', category: 'Household', perPack: true, quote: 100, items: [
    'Armada Evergreen Garbage Bags Extra Large 20pk',
    'Multix Extra Wide 56L Garbage Bags 100pk',
    'Armada Garbage Bags 20pk',
    'Multix Extra Wide Garbage Bags 50pk',
    'Multix Extra Large Extra Wide Garbage Bags 76L 10pk',
    'Glad Garbage Bag Wavetop Tie XL 30pk',
  ]},
  // Compared per TABLET, not per pack: these run 30 to 100 tablets a box, so a
  // pack price ranks the big boxes as "expensive" when they are usually the
  // cheapest wash. Same reasoning as nappies. NOT sticker - unlike nappies the
  // pack price is still worth showing beside the per-tablet rate.
  { key: 'dishwashing_tablets', label: 'Dishwashing tablets', category: 'Household', perPack: true, quote: 100, items: [
    // WW 184248 - the originally-tracked product, and the one the receipts are
    // for. It is a 100 pack; an earlier version of this category pointed the
    // tracked name at 183866 (a 30 pack) instead, which both dropped this
    // product and would have priced its history at 3x the real per-tablet rate.
    'Shine Dishwashing Tablets 100pk',
    'Shine Dishwashing Tablets 30pk',
    'Shine Optimum All In 1 Dishwasher Tablets 100pk',
    'Shine Optimum All-In-One Dishwashing Pods 45pk',
    'Finish Power Dishwashing Tablets Lemon 100pk',
    'Morning Fresh Advanced Clean Dishwasher Tablets Lemon 94pk',
    'Coles Ultra Dishwasher Tablets 40pk',
    'Coles Ultra Dishwasher Tablets 100pk',
    'Optix Titanium Pro Dishwashing Tablets 80pk',
  ]},
  { key: 'nappies_size6', label: 'Nappies size 6', category: 'Baby & Care', sticker: true, perPack: true, quote: 50, items: [
    "Little One's Ultra Dry Nappies Size 6 40pk",
    'Millie Moon Luxury Nappies Size 6 30pk',
    'Coles Nappies Unisex Junior Size 6 40pk',
    'Rascals Premium Nappies Size 6 30pk',
    'Huggies Ultra Dry Nappies Boys Size 6 30pk',
  ]},
  // Wipes are bought by the piece, never by weight, and the pack sizes run 60 to
  // 640 - so pack price is meaningless for ranking (a $59 540-pack is a BETTER
  // buy than a $27.99 240-pack). perPack makes the metric cents-per-wipe, which
  // is also the metric the Chemist Warehouse / ALDI entries carry via `packs`,
  // so the supermarket rows and the "also sold at" column compare like for like.
  { key: 'baby_wipes', label: 'Baby wipes', category: 'Baby & Care', sticker: true, perPack: true, quote: 100, items: [
    'WaterWipes Baby & Newborn Sensitive Wipes 60pk',
    'WaterWipes Baby & Newborn Sensitive Wipes 180pk',
    'WaterWipes Baby & Newborn Sensitive Wipes 360pk',
    'WaterWipes Baby & Newborn Sensitive Wipes 540pk',
    "Little One's Water Baby Wipes Fragrance Free 60pk",
    'Huggies PURE 99% Purified Water Baby Wipes 72pk',
  ]},
  // Single member, both stores already pinned on that ONE item (unlike nappies,
  // this was never split into separate single-store products) - a sticker group
  // of one exists purely so it inherits the per-kg filter, the click-anywhere
  // expand and the "also sold at" third column, same as every other category.
  // See the "add all items with third-party websites... categorize them as per
  // kilogram items" request this shipped for.
  { key: 'rexona_deodorant', label: 'Rexona Men 48hr Deodorant', category: 'Household', sticker: true, items: [
    'Rexona Men 48hr Deodorant Stick Sport Defence',
  ]},
];

// Groups compared by PACK PRICE, not $/kg (the group's headline shows "$X", no
// "/kg" suffix, and Units count packs). Derived from the sticker flag on the
// group defs so callers that only have the key (basket, units model) can check.
// Was a const Set built once from the seed array. That stopped being correct the
// moment `sticker` became editable: the Set said one thing and loadVariantGroups()
// another, and nothing would have crashed - a category would just quietly count
// kilos in the basket while showing a pack price in the table. Derived live, so
// there is one answer. Cheap enough to call per row (~23 categories).
function stickerGroups() {
  return new Set(loadVariantGroups().filter(g => g.sticker).map(g => g.key));
}
// key -> pieces quoted, for every per-piece category. Derived live for exactly
// the reason stickerGroups() is: `perPack` and `quote` are both editable, so a
// snapshot would let the Units column count one thing while the price column
// quotes another. Callers that hold only a group KEY (the units model, the
// basket) need this to know a row's quantity is measured in pieces.
function perPackQuotes() {
  return new Map(loadVariantGroups().filter(g => g.perPack).map(g => [g.key, pieceQuoteOf(g)]));
}
// Comparison metric for a group's store-side result: pack price for sticker
// groups, $/kg otherwise. Threading this (instead of clientPerKg) through the
// group builders makes the whole per-kg pipeline - sort, trend, history, hot
// deals, basket - work in "sticker space" for sticker groups (history ratio
// becomes price/price = 1, i.e. raw prices) with no other changes.
// Pack count out of a name: "... 40pk" or "... 40 pack" -> 40.
function packCountOf(name) {
  const m = String(name || '').match(/(\d+)\s*(?:pk|pack)\b/i);
  return m ? +m[1] : null;
}

function groupMetric(g, res, itemName) {
  if (!res || res.price == null) return null;
  // perPack: the comparable number is the price of ONE piece. Nappies come in
  // 30s, 40s and 124s, so ranking on pack price is meaningless - it sorted a
  // $14.40 30-pack ($0.48 each) above an $11.50 40-pack ($0.29 each). Count is
  // read from the list_item key first, because that is the one string we
  // control; the scraped store name is the fallback.
  if (g && g.perPack) {
    const n = packCountOf(itemName) || packCountOf(res.name);
    // 5 decimals, not 3. This is a per-PIECE figure that gets displayed x100
    // (see PER_PIECE_QUOTE), so rounding it to a tenth of a cent here lands as
    // 10c granularity on screen: $59.00/540 came out as $10.90 per 100 where
    // Woolworths' own shelf label says $10.93. Third-store rows never rounded,
    // so the two halves of the same column also disagreed. 5dp is far below
    // anything displayed and still clips binary-float noise.
    return n > 0 ? +(res.price / n).toFixed(5) : null;
  }
  if (g && g.sticker) return res.price;
  const p = clientPer100(res); // $/kg = $/100g × 10 (same as app.js clientPerKg)
  return p.value != null ? +(p.value * 10).toFixed(2) : null;
}

// Groups sold as one discrete can/jar/bag, not weighed loose. The main
// page's Units column should count PACKS for these (default 1, step 1) even
// though the group's own price COMPARISON metric is $/kg - "1.2kg of
// Nutella" isn't how anyone shops. Every other group (chicken, mince, salmon,
// porterhouse...) is a variable-weight cut and keeps the kg-quantity model
// (default 1.0kg, step 0.2kg).
const UNIT_BASED_GROUPS = new Set([
  'nutella', 'lotus_biscoff', 'washed_potatoes', 'carrots',
  'brown_onions', 'red_onions', 'greek_yoghurt',
  // Seeds and kernels: compared by $/kg (that's the point - the pack sizes run
  // 150g to 1kg) but bought as sealed bags, so Units counts BAGS. "1.4kg of
  // chia" is not how you shop, same reasoning as Nutella above.
  'pumpkin_kernels', 'sunflower_kernels', 'chia_seeds',
]);

// ── Shared per-kg category (variant group) model ─────────────────────────────
// The main table and the basket build their category rows from THIS one builder.
// They used to have separate implementations that silently disagreed on member
// lists, $/kg exclusions and the comparison metric - so the SAME category could
// total differently on the two pages. One builder, one answer.

function loadUnitOverrides() {
  try { return JSON.parse(localStorage.getItem('pw_units_v1') || '{}'); } catch { return {}; }
}

// Quantity planned for a category row: kilos for weighed groups (meat, salmon),
// whole packs for unit-based/sticker ones (Nutella, potato bags). Default 1 for
// both, and stored in the SAME place the main page's Units column writes - which
// is why the two pages can never show a category at different quantities.
function groupUnits(groupKey) {
  const ov = loadUnitOverrides()[groupKey];
  return ov != null ? ov : 1;
}

// What a category row COSTS at a store: the price the row SHOWS x the quantity
// it shows. For a weighed group that's $/kg x kg; for a sticker/unit group it's
// pack price x packs (groupMetric already returns pack price for those).
//
// Deliberately NOT the real till price of whole packs. The whole point of a
// per-kg category is to compare stores on the rate you pay per kilo; a 2kg bag
// costed at $10/kg counts as $10 for 1kg even though you can't buy half a bag.
// Otherwise a store offering a great $/kg only in bulk would LOSE the comparison
// purely for selling a big pack - the opposite of the answer we want.
// A per-piece category costs at the price it SHOWS, exactly like a weighed one.
// metricShown() is the whole point: the row says "$3.17 /100", so one unit of
// quantity IS 100 wipes and costs $3.17. Multiplying the hidden per-ONE-piece
// figure instead made the Total column read $0.03 while the price beside it
// read $3.17 - the same number quoted two ways in one row.
// For every other kind of category metricShown() returns the value unchanged,
// so weighed and pack rows behave exactly as before.
function groupStoreTotal(group, store) {
  const pk = store === 'ww' ? group._wwPerKg : group._coPerKg;
  return pk == null ? null : metricShown(group, pk) * groupUnits(group.list_item);
}

// How many real pieces one unit of quantity is, for a per-piece category. 1 for
// everything else, so callers can multiply unconditionally.
function qtyPiecesPer(group) {
  return group && group._perPack ? pieceQuoteOf(group) : 1;
}

// The Units control's label. A weighed row counts kilos, a per-piece row counts
// PIECES (100, 120, 140...) rather than an abstract "1.2 x100" nobody can shop
// from, and everything else counts packs.
function qtyLabel(units, kind, piecesPer) {
  if (kind === 'kg')     return units.toFixed(1) + ' kg';
  if (kind === 'pieces') return Math.round(units * (piecesPer || 1)) + ' pcs';
  return String(units);
}

// ── Per-kg override model (pure helpers; unit-tested in scripts/perkg_selfcheck.js) ──
// The override is a DIFF against the code defaults, not a frozen snapshot. This is the
// whole point: defaults stay authoritative, so a member removed in code disappears and
// a member added in code appears - while the user's own add/remove/rename still stick.
// The old snapshot form ({items, ww_items, coles_items}) is migrated on read.
//
//   v2 shape: { v:2, label?, add:[], remove:[], ww_order?, coles_order? }
//
// Known migration limit: a union snapshot can't tell a user-added item from a default
// that was later pruned in code - both look like "extra" names - so on upgrade they're
// kept as `add`. The user can remove such a straggler once and it now stays removed.
function migratePerKgOverride(o, defaultItems) {
  if (!o || typeof o !== 'object') return { v: 2, add: [], remove: [] };
  if (o.v === 2) return o;
  const out = { v: 2, label: o.label, add: [], remove: [] };
  if (Array.isArray(o.items)) out.add = o.items.filter(n => !defaultItems.includes(n));
  if (Array.isArray(o.ww_items)) out.ww_order = o.ww_items;
  if (Array.isArray(o.coles_items)) out.coles_order = o.coles_items;
  return out;
}

// Flat member list = (defaults minus user-removed) then user-added, de-duped vs defaults.
function computePerKgItems(defaultItems, override) {
  const o = migratePerKgOverride(override, defaultItems);
  const remove = new Set(o.remove || []);
  const add = (o.add || []).filter(n => !defaultItems.includes(n));
  return [...defaultItems.filter(n => !remove.has(n)), ...add];
}

// One-time repair for a specific 2026-08-06 incident: a client whose Edit-
// category snapshot pre-dated 3 newly-scraped Coles nappies recorded them as
// removed purely because of that timing (see categoryRemovals() below) -
// never a real user choice. That corrupted local override then re-published
// itself over a server-side data fix every few minutes from an already-open
// tab, which no server-side fix alone can outrun.
//
// Scoped to this EXACT shape - one category key, these exact 3 names - so it
// can never misfire on a legitimate future removal of anything else. Runs
// once per load (idempotent: a no-op once the bad shape is gone) from every
// device that loads this file, so it self-heals the moment ANY client next
// runs fresh code, without the user having to redo the edit by hand. Safe to
// delete this and its one call site once confirmed clean everywhere (~Sept 2026).
const KNOWN_BAD_NAPPIES_REMOVE = [
  'Coles Nappies Unisex Junior Size 6 40pk',
  'Rascals Premium Nappies Size 6 30pk',
  'Huggies Ultra Dry Nappies Boys Size 6 30pk',
];
function repairKnownCategoryCorruption(overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const cat = o.nappies_size6;
  if (!cat || !Array.isArray(cat.remove)) return o;
  if (!KNOWN_BAD_NAPPIES_REMOVE.every(n => cat.remove.includes(n))) return o;
  return { ...o, nappies_size6: { ...cat, remove: cat.remove.filter(n => !KNOWN_BAD_NAPPIES_REMOVE.includes(n)) } };
}

// A category the user built in the UI, rather than one seeded in code. Stored in
// the SAME override map as the patches to the seeded ones (pw_perkg_cats_v1),
// which is what makes it sync between devices for free - that map already rides
// along in user_settings.json under `perkgCats`. `created: true` is what tells a
// user-made category apart from a patch to a seeded one; without it any stale key
// left behind by an old build would materialise as a phantom category.
function isCreatedCategory(o) {
  return !!(o && typeof o === 'object' && o.created);
}

// Stable key for a category made from a product name. The key is what every
// override, exclusion and third_store entry is filed under, so it must contain
// nothing that needs escaping later - lowercase, digits and underscores only.
// Returns '' for a name with no usable characters, which the caller must treat
// as "can't make a category from this" rather than filing one under ''.
function categoryKeyFor(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

// Every category the app knows about, in the SEED shape (key + items + flags).
// Several helpers apply the overrides themselves via variantGroupItemNames()
// rather than going through loadVariantGroups(), and each one that iterated
// DEFAULT_VARIANT_GROUPS directly was a place a user-created category would
// silently not exist - members missing from the basket's exclusion set, absent
// from Hot Deals. One list, so there is one answer to "what categories are there".
// A created category has no seeded members: its whole membership arrives as the
// override's `add`, which is exactly what an empty `items` makes happen.
function allVariantGroupSeeds(ov) {
  const seedKeys = new Set(DEFAULT_VARIANT_GROUPS.map(g => g.key));
  const created = Object.keys(ov || {})
    .filter(k => !seedKeys.has(k) && isCreatedCategory(ov[k]))
    .map(k => ({
      key: k,
      label: ov[k].label || k,
      category: ov[k].category || 'Pantry',
      sticker: !!ov[k].sticker,
      perPack: !!ov[k].perPack,
      quote: ov[k].quote,
      items: [],
    }));
  return [...DEFAULT_VARIANT_GROUPS, ...created];
}

function loadVariantGroups() {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  return allVariantGroupSeeds(ov).map(g => {
    const o = migratePerKgOverride(ov[g.key], g.items);
    return {
      key: g.key,
      label: o.label || g.label,
      category: o.category || g.category,
      // The comparison metric is now editable, so it has to be read from the
      // override FIRST and fall back to the seed - `!!g.sticker` alone meant the
      // UI could store a choice that nothing downstream ever read. `!= null` and
      // not `||`, so an explicit false can turn a seeded flag back OFF.
      sticker: o.sticker != null ? !!o.sticker : !!g.sticker,
      // Dropped from this returned shape once before (had to be added back for
      // sticker itself too, going by the comment above) - groupMetric() silently
      // fell back to raw pack price for every nappy because this flag never
      // reached it: buildVariantGroups() iterates the OUTPUT of this function,
      // not DEFAULT_VARIANT_GROUPS directly, so a seed-only field is invisible
      // downstream unless it is re-exported here too.
      perPack: o.perPack != null ? !!o.perPack : !!g.perPack,
      // Same override-first rule as the two flags above, and for the same
      // reason: the quote size is editable, so a seed-only read would silently
      // discard the user's choice. See pieceQuoteOf() for the valid values.
      quote: o.quote != null ? Number(o.quote) : g.quote,
      items: computePerKgItems(g.items, o),
      // Per-store ordered member lists (display order hints; membership comes from
      // `items` + price qualification in resolveStoreLists). Null until the user saves.
      ww_items: Array.isArray(o.ww_order) ? o.ww_order : null,
      coles_items: Array.isArray(o.coles_order) ? o.coles_order : null,
    };
  });
}

// Every category member ends with its pack size in brackets - "Macro Black Chia
// Seeds (1kg)" - because in a $/kg category the size is the thing that makes two
// rows different, and a bare trailing "1kg" reads as part of the product name.
// Takes the size from the display name if it is there, otherwise from the
// list_item key (single-store pins carry it there), and always re-emits it in
// ONE place and ONE format. Purely cosmetic: no key is ever renamed.
const SIZE_TOKEN = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|pk|pack)\b/i;
function nameWithSize(displayName, key) {
  const name = String(displayName || '').trim();
  if (!name) return name;
  if (/\([^)]*\d[^)]*\)\s*$/.test(name)) return name;   // already bracketed
  const m = name.match(SIZE_TOKEN) || String(key || '').match(SIZE_TOKEN);
  if (!m) return name;
  const size = `${m[1]}${m[2].toLowerCase()}`;
  // Drop a bare trailing size off the name so it is not printed twice.
  const stripped = name.replace(new RegExp(`\\s*${m[1]}\\s*${m[2]}\\b\\s*$`, 'i'), '').trim();
  return `${stripped || name} (${size})`;
}

// ── Third stores (not Woolworths, not Coles) ────────────────────────────────
// ONE extra column holds all of them, not a column per retailer: the point is
// "is it cheaper somewhere else", and two mostly-empty columns would cost the
// table width for nothing. Each entry carries a one-letter chip like W and C.
// The letter C is reused for Chemist Warehouse - the third column and its own
// indigo colour keep it apart from the red Coles C.
// `bg`/`fg` are each shop's own sign colours, so a chip is recognisable at a
// glance instead of every outside store wearing the same grey. Chemist Warehouse
// is the odd one out: its identity is a yellow ground, which needs dark text -
// hence fg rather than assuming white everywhere. Note CW and Coles share the
// letter C; the colour is now what actually tells them apart.
const THIRD_STORES = {
  chemist_warehouse: { letter: 'C', label: 'Chemist Warehouse', bg: '#FFD400', fg: '#00285A' },
  priceline:         { letter: 'P', label: 'Priceline',         bg: '#E5006D', fg: '#ffffff' },
  big_w:             { letter: 'B', label: 'Big W',             bg: '#0072CE', fg: '#ffffff' },
  aldi:              { letter: 'A', label: 'ALDI',              bg: '#00317F', fg: '#ffffff' },
};

// Inline style for a store chip, or '' for a store we have no colours for.
function thirdChipStyle(storeKey) {
  const m = THIRD_STORES[storeKey];
  return m && m.bg ? `background:${m.bg};color:${m.fg || '#fff'}` : '';
}

// Which third store a pasted product URL belongs to, or null if it is not one
// we know. Matched on the HOSTNAME only - a path or query can contain anything
// (a Woolworths link carries "?googleshop=true"; a search URL can carry a rival
// shop's name), so substring-matching the whole URL would file links under the
// wrong store. Subdomains count (www., m.), look-alike suffixes do not
// ("bigw.com.au.evil.com" is not Big W).
function thirdStoreFromUrl(url) {
  let host;
  try {
    host = new URL(String(url).trim()).hostname.toLowerCase();
  } catch {
    return null;   // not a URL at all
  }
  const HOSTS = {
    'chemistwarehouse.com.au': 'chemist_warehouse',
    'bigw.com.au':             'big_w',
    'priceline.com.au':        'priceline',
    'aldi.com.au':             'aldi',
  };
  for (const [domain, store] of Object.entries(HOSTS)) {
    if (host === domain || host.endsWith('.' + domain)) return store;
  }
  return null;
}

// Comparable rate for one third-store entry: per piece when it is sold by the
// piece (nappies), otherwise $/100g or $/100ml parsed out of the product name -
// the same rule and the same function the W/C columns already use.
function thirdUnitPrice(entry) {
  if (!entry || entry.price == null) return null;
  if (entry.packs > 0) {
    // 5dp for the same reason groupMetric uses it: this per-piece figure is
    // displayed x100, so 3dp showed ALDI's $2.86 as "$2.90" on the chip while
    // the panel underneath - which goes through thirdGroupMetric, unrounded -
    // said $2.86. Two numbers for one price, on the same row.
    return { value: +(entry.price / entry.packs).toFixed(5), label: 'each' };
  }
  const p = clientPer100({ price: entry.price, name: entry.name || '' });
  return p.value == null ? null : { value: p.value, label: p.label };
}

// Cheapest first. Rank on unit price when EVERY entry has one, else on shelf
// price - a mixed list would otherwise compare $/100g against dollars.
function thirdRanked(entries) {
  const list = (entries || []).filter(e => e && e.price != null);
  const units = list.map(thirdUnitPrice);
  const allHaveUnit = list.length > 0 && units.every(u => u && u.value != null);
  return list
    .map((e, i) => ({ entry: e, sort: allHaveUnit ? units[i].value : e.price }))
    .sort((a, b) => a.sort - b.sort)
    .map(x => x.entry);
}

// The entry that beats BOTH supermarkets, or null. This is what turns the row's
// chip loud, so it has to be conservative: a missing store price is not a win.
//
// ponytail: compares SHELF price, which is right while a third store stocks the
// same product the row does.
function thirdBeats(entries, wwPrice, colesPrice) {
  const best = thirdRanked(entries)[0];
  if (!best) return null;
  const rivals = [wwPrice, colesPrice].filter(p => p != null && p > 0);
  if (!rivals.length) return null;
  return best.price < Math.min(...rivals) ? best : null;
}

// The size-6-nappy case the comment above used to flag as a future ceiling: for
// a per-kg/per-pack CATEGORY, wwPrice/colesPrice arrive as a per-unit metric
// (e.g. dollars per nappy), not a raw pack price - comparing that against a
// third entry's raw shelf price would be $0.29-a-nappy against $13.99-for-forty,
// never meaningfully true. Ranks and compares on thirdUnitPrice() instead.
function thirdBeatsUnit(entries, wwUnitPrice, colesUnitPrice) {
  const withUnit = (entries || [])
    .filter(e => e && e.price != null)
    .map(e => ({ entry: e, unit: thirdUnitPrice(e)?.value }))
    .filter(x => x.unit != null)
    .sort((a, b) => a.unit - b.unit);
  const best = withUnit[0];
  if (!best) return null;
  const rivals = [wwUnitPrice, colesUnitPrice].filter(p => p != null && p > 0);
  if (!rivals.length) return null;
  return best.unit < Math.min(...rivals) ? best.entry : null;
}

// The Best column's readable label per store key. ONE map, used by both the
// cell/export value and the sort key - when those disagreed, "A to Z" ordered by
// the hidden internal keys ('coles' < 'equal' < 'woolworths') and read as random.
const CHEAPER_SORT_LABEL = { woolworths: 'Woolworths', coles: 'Coles', equal: 'Equal' };

// Sort key for the Qty column, where two different units share one column: whole
// units (3 packs) and weights (1.2 kg). These used to be blocked apart - kg rows
// got +1e6 so they all sat after every unit row - which put a 0.8 kg item AFTER
// a 20-pack. The column reads as one list of quantities, so it sorts as one:
// numerically, with a hair of separation so that at the SAME number a plain unit
// comes before a weight (1, 1, 1kg, 1kg). EPS is far below any real step (0.1).
function qtySortValue(units, isKg) {
  const u = Number(units);
  if (!Number.isFinite(u)) return NaN;      // NaN sinks to the bottom either way
  return isKg ? u + 1e-6 : u;               // 1e-6 << the 0.1 step real quantities use
}

// WHICH scale a CATEGORY's own metric is on, and therefore how a third store has
// to be compared against it. Getting this wrong is silent: the verdict just
// comes out backwards, with nothing to notice.
//   sticker  -> the metric IS a shelf price, so compare raw-to-raw. Routing a
//               sticker group through the per-unit path compares a $/100g figure
//               against a pack price - a $4.00 deodorant reads as DEARER than a
//               $4.90 one, because 4.00/0.52 = 7.69 > 4.90.
//   perPack  -> the metric is dollars-per-piece, which lines up with a third
//               entry's own per-piece price (its `packs`). The nappies case.
//   weighed  -> $/kg, while thirdUnitPrice is per 100g: off by 10x, and not
//               fixable by scaling alone (an entry may be priced per piece
//               instead). No verdict at all rather than a wrong one.
function groupThirdScale(group) {
  const usable = group._sticker || group._perPack;
  return {
    perUnit: !!group._perPack,
    ww: usable && group._wwPerKg != null ? { price: group._wwPerKg } : null,
    co: usable && group._coPerKg != null ? { price: group._coPerKg } : null,
  };
}

// A third-store entry expressed in the CATEGORY's own metric - the number that
// belongs in the same bold slot where a W/C row shows "$0.29 each" or "$4.90".
// Mirrors groupMetric() for supermarket rows: per piece for a perPack category,
// the shelf price itself for a sticker one, $/kg for a weighed one. Showing a
// $13.99 pack price where the column means "per nappy" is the mismatch this
// exists to stop.
function thirdGroupMetric(group, entry) {
  if (!entry || entry.price == null) return null;
  // Precedence MUST match groupMetric(): a category can carry both flags at once
  // (nappies is sticker + perPack), and perPack wins there. Testing sticker
  // first printed "$13.99 each" - the pack price wearing the per-piece label.
  if (group._perPack) return entry.packs > 0 ? entry.price / entry.packs : null;
  if (group._sticker) return entry.price;
  const per100 = clientPer100({ price: entry.price, name: entry.name || '' });
  return per100.value == null ? null : per100.value * 10;   // $/100g -> $/kg, as the column shows
}

// The ONE place a category's "is it cheaper elsewhere?" verdict is decided, so
// the chip, the desktop panel and the mobile card cannot disagree with it.
function groupThirdBeat(group, entries) {
  const s = groupThirdScale(group);
  if (!s.ww && !s.co) return null;
  return s.perUnit ? thirdBeatsUnit(entries, s.ww?.price, s.co?.price)
                   : thirdBeats(entries, s.ww?.price, s.co?.price);
}

// Is the "other stores" section showing? Open by DEFAULT when a third store
// actually undercuts both supermarkets - a saving you only see after
// remembering to expand a badge is a saving you don't see. Two sets, not one
// flag, because "default" has to mean default: collapsing a cheaper-elsewhere
// row must stick, and expanding a not-cheaper one must stick too. Sets are
// passed in rather than closed over so this stays pure and testable.
function thirdOpenState(key, beats, openSet, closedSet) {
  if (closedSet.has(key)) return false;
  if (openSet.has(key)) return true;
  return !!beats;
}

// Flip whichever way the CURRENT resolved state points, recording the choice as
// explicit. Writing to only one set would let a stale entry in the other win on
// the next click, so each branch clears its opposite.
function thirdToggleState(key, beats, openSet, closedSet) {
  if (thirdOpenState(key, beats, openSet, closedSet)) { openSet.delete(key); closedSet.add(key); }
  else { closedSet.delete(key); openSet.add(key); }
}

// A category with no category of its own is a meat cut - every seed group that
// isn't Fruit & Veg / Pantry / Dairy / Sweets is. Named once so the fallback
// can't drift between buildVariantGroups() and the member resolution below.
const GROUP_DEFAULT_CATEGORY = 'Meat & Seafood';

// The category a product belongs to, or null if it is in none.
//
// Membership is the ONE fact that settles a member's frequency, category and
// watchlist state: adding a product to a category means it belongs to that
// category in every sense, so the CATEGORY's settings are the answer and the
// member's own entries are ignored. Before this the two silently disagreed -
// "Lotus Biscoff Spread Smooth 720g" resolved to Pantry/rare while the "Lotus
// Biscoff" category it sits in was Sweets/weekly.
//
// ponytail: the member->category index is rebuilt only when the override string
// changes, because every render resolves this once per item (250+ calls) and
// loadVariantGroups() re-derives all ~20 categories on each call. CEILING: a
// full rebuild scans every seed group - fine at 20 categories, revisit if the
// seed list ever runs to hundreds.
let _vgIndex = null, _vgIndexKey = null;
function variantGroupOf(itemName) {
  if (!itemName || String(itemName).startsWith('__group_')) return null;
  let raw = '{}';
  try { raw = localStorage.getItem('pw_perkg_cats_v1') || '{}'; } catch {}
  if (_vgIndexKey !== raw) {
    _vgIndex = new Map();
    for (const g of loadVariantGroups()) {
      for (const n of (g.items || [])) _vgIndex.set(n, g);
    }
    _vgIndexKey = raw;
  }
  return _vgIndex.get(itemName) || null;
}

// The key a product's settings actually live under: its category's synthetic
// key when it belongs to one, otherwise its own name. Every priority and
// watchlist lookup goes through this, so a member and its category can never
// hold two different answers.
function settingsKeyFor(itemName) {
  const g = variantGroupOf(itemName);
  return g ? `__group_${g.key}` : itemName;
}

// Resolve a category's per-store member lists (ordered). If the override has an
// explicit ww_items/coles_items list, use it verbatim (explicit membership - keep
// even pending items). Otherwise derive: an item belongs to a store's list if it
// has a pinned URL or a real (>0) price there.
// Which default category members Edit-category's save should record as
// user-removed. A member counts as removed ONLY if it was actually visible in
// the modal when it opened (present in snapshotItems) and is missing from what
// got saved (savedItems) - never merely because it's missing from the CURRENT
// code defaults comparison.
//
// This is the fix for a real incident (2026-08-06): the nappies category grew
// 3 Coles members in code, but a client whose _lastData snapshot pre-dated that
// scrape had never seen them (unpriced members don't qualify for a store's list
// - see resolveStoreLists' qualifies() below). Any save on that client -
// including a bare label rename - then read "defaults minus what's on screen"
// and recorded all 3 as removed, silently pinning them out and stripping them
// from every device once that override synced. The bug was structural, not a
// one-off: defItems.filter(n => !items.includes(n)) treats "never rendered"
// and "user unchecked it" as the same signal, and the FIRST is a timing
// accident that can recur for any category the day it gains a new member.
function categoryRemovals(defItems, snapshotItems, savedItems) {
  const seen = new Set(snapshotItems || []);
  const kept = new Set(savedItems || []);
  return (defItems || []).filter(n => seen.has(n) && !kept.has(n));
}

function resolveStoreLists(group, byName) {
  const qualifies = (name, store) => {
    const data = byName.get(name);
    const price = store === 'ww' ? data?.woolworths?.price : data?.coles?.price;
    return price != null && price > 0;
  };
  const build = (orderArr, store) => {
    let names;
    if (Array.isArray(orderArr)) {
      names = orderArr.filter(n => group.items.includes(n) && qualifies(n, store));
      // Append any union item that now qualifies for this store but isn't listed yet.
      for (const it of group.items) if (!names.includes(it) && qualifies(it, store)) names.push(it);
    } else {
      names = group.items.filter(n => qualifies(n, store));
    }
    return names;
  };
  return {
    ww: build(group.ww_items, 'ww'),
    coles: build(group.coles_items, 'coles'),
  };
}

// Products excluded from a category's $/kg (per category+item+store). Key form:
// "catKey::list_item::ww|coles". Stored in pw_perkg_excl_v1.
function loadPerKgExclusions() {
  try { return new Set(JSON.parse(localStorage.getItem('pw_perkg_excl_v1') || '[]')); } catch { return new Set(); }
}

// Build the live category rows from current member data. A group has no storage
// of its own - its price, winner and trend are all derived here, every render.
// Display-only per-store member COUNTS are not set here: they need the main
// page's name/dedupe helpers, so app.js attaches them after calling this.
function buildVariantGroups(byName) {
  const out = [];
  const excl = loadPerKgExclusions();
  for (const g of loadVariantGroups()) {
    // Members that aren't in latest.json yet (never scraped / scrape failed)
    // are kept as pending placeholders so they remain visible in the panel.
    const members = g.items.map(n => {
      const item = byName.get(n);
      if (!item) return { list_item: n, _pending: true, woolworths: null, coles: null, price_history: [] };
      return item.pending ? { ...item, _pending: true } : item;
    });
    if (!members.length) continue;

    // Woolworths and Coles are independent lists - a product contributes to a store
    // only if it's a member of that store's list. The cheapest in each list wins.
    const stores = resolveStoreLists(g, byName);
    const memberByName = new Map(members.map(m => [m.list_item, m]));
    // Comparison metric: pack price for sticker groups (Bolognese sauce), $/kg
    // otherwise. `perkg` keeps its name through the pipeline but holds whichever.
    const ww = stores.ww
      .filter(n => !excl.has(`${g.key}::${n}::ww`))
      .map(n => ({ name: n, result: memberByName.get(n)?.woolworths, perkg: groupMetric(g, memberByName.get(n)?.woolworths, n) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);
    const co = stores.coles
      .filter(n => !excl.has(`${g.key}::${n}::coles`))
      .map(n => ({ name: n, result: memberByName.get(n)?.coles, perkg: groupMetric(g, memberByName.get(n)?.coles, n) }))
      .filter(v => v.perkg != null).sort((a, b) => a.perkg - b.perkg);

    const wwBest = ww[0] || null;
    const coBest = co[0] || null;
    let cheaper = null;
    if (wwBest && coBest) cheaper = wwBest.perkg < coBest.perkg ? 'woolworths' : (coBest.perkg < wwBest.perkg ? 'coles' : 'equal');
    else if (wwBest) cheaper = 'woolworths';
    else if (coBest) cheaper = 'coles';

    out.push({
      list_item: `__group_${g.key}`,
      _isGroup: true,
      _groupKey: g.key,
      _groupLabel: g.label,
      _sticker: !!g.sticker,
      _perPack: !!g.perPack,
      _quote: pieceQuoteOf(g),
      _unitSuffix: g.sticker ? '' : '/kg',
      // What to PRINT after the metric. Kept apart from _unitSuffix on purpose:
      // that one is also read as "is this category weighed?" (the basket shows kg
      // quantities when it is truthy), and a per-pack category is not weighed.
      _metricSuffix: g.perPack ? pieceQuoteSuffix(pieceQuoteOf(g)) : (g.sticker ? '' : '/kg'),
      _members: members,
      _wwList: stores.ww,
      _coList: stores.coles,
      _wwAll: ww,
      _coAll: co,
      _wwBest: wwBest,
      _coBest: coBest,
      _wwPerKg: wwBest ? wwBest.perkg : null,
      _coPerKg: coBest ? coBest.perkg : null,
      // Shape like a normal item so sort/helpers work; price = best variant's pack price.
      woolworths: wwBest ? wwBest.result : null,
      coles: coBest ? coBest.result : null,
      cheaper_store: cheaper,
      category: g.category || GROUP_DEFAULT_CATEGORY,
      trip_count: null,
      price_history: [],
    });
  }
  return out;
}

// Effective count for the "⚠ Validate" pill. The main/hot-deals/basket pages
// read pending_validation from the DEPLOYED Pages copy of latest.json, which
// lags the repo ~1min after a validation write - so a just-resolved item kept
// re-showing the pill for a minute. validate.html records resolved item names in
// localStorage (pw_pv_resolved_v1); here we subtract them. Self-pruning: once the
// fresh data no longer lists a resolved name (Pages caught up), we drop it from
// the set, so a genuinely re-flagged item later isn't wrongly suppressed.
function pendingValidationCount(pending) {
  const names = new Set((pending || []).map(e => e && e.item).filter(Boolean));
  let resolved;
  try { resolved = JSON.parse(localStorage.getItem('pw_pv_resolved_v1') || '[]'); } catch { resolved = []; }
  resolved = Array.isArray(resolved) ? resolved : [];
  const pruned = resolved.filter(n => names.has(n));
  if (pruned.length !== resolved.length) {
    try { localStorage.setItem('pw_pv_resolved_v1', JSON.stringify(pruned)); } catch {}
  }
  const suppressed = new Set(pruned);
  let count = 0;
  for (const n of names) if (!suppressed.has(n)) count++;
  return count;
}

// Equivalent-quantity bundling for UNIT-BASED per-kg groups (yoghurt, potato,
// nutella...), where each store is bought in WHOLE packs, not weighed loose.
// Each store's cheapest-$/kg pack is scaled - using whole packs - to the SAME
// comparison weight (the larger of the two pack sizes), so the basket compares
// like for like (2 × WW 1kg vs 1 × Coles 2kg) instead of a lone 1kg sticker
// beside a 2kg one. The store with the lower TOTAL at that weight is cheaper -
// which, at equal weight, is exactly the lower $/kg. Pure; see utils_selfcheck.
//   ww/co: { price, perKg, ... } | null.   pack size (kg) = price / perKg.
//   returns { ww:{packs,total,...}|null, coles:{...}|null, cheaper }.
// ponytail: only aligns when the larger size is a near-integer multiple of the
// smaller (within 10%); off-multiple pairs (750g vs 1kg) fall back to 1:1 packs,
// still comparable via the kg size labels the caller renders. Upgrade: exact LCM.
function perKgEquivBundle(ww, co) {
  const one = r => r ? { ...r, packs: 1, total: +(+r.price).toFixed(2) } : null;
  if (!ww || !co) return { ww: one(ww), coles: one(co), cheaper: ww ? 'woolworths' : 'coles' };
  const sizeW = ww.price / ww.perKg, sizeC = co.price / co.perKg;
  const target = Math.max(sizeW, sizeC);
  const packsFor = size => { const n = target / size, r = Math.round(n); return (r >= 1 && Math.abs(n - r) <= 0.1) ? r : 1; };
  let nW = packsFor(sizeW), nC = packsFor(sizeC);
  // If either side can't reach the target weight in whole packs, don't scale -
  // a lopsided 1:2 that isn't a true weight match reads worse than 1:1.
  if (nW * sizeW < target - 1e-6 || nC * sizeC < target - 1e-6) { nW = 1; nC = 1; }
  const wt = +(nW * ww.price).toFixed(2), ct = +(nC * co.price).toFixed(2);
  const cheaper = wt < ct - 0.005 ? 'woolworths' : ct < wt - 0.005 ? 'coles' : 'equal';
  return { ww: { ...ww, packs: nW, total: wt }, coles: { ...co, packs: nC, total: ct }, cheaper };
}

// Products the user deleted from the dataset. Every sync path must FILTER
// these: priorities/archived lists live in each device's localStorage and the
// sync code merges local + repo then publishes the union - so one phone with a
// stale copy silently resurrects a purged item in archived_items.json /
// user_settings.json forever (bit us twice: 2026-07-19 and 2026-07-20).
// Deleting a product = purge the data files AND tombstone it here.
const REMOVED_ITEMS = new Set([
  // 2026-07-19 batch
  'Woolworths Frozen Basa Fillets 1kg',
  "Little One's Size 3 Ultra Dry Nappies Crawler 6-11Kg Boys & Girls",
  "Little One's Size 4 Ultra Dry Nappies Toddler 10-15Kg Boys & Girls",
  "Little One's Size 5 Ultra Dry Nappies Walker 12-17kg Boys & Girls",
  'Ajax Antibacterial Wipes Eco Vanilla & Berries 110 Wipes',
  'The Odd Bunch Mango',
  'The Odd Bunch Strawberries Punnet',
  // 2026-07-20 batch (incl. ghost aliases of renamed products - the alias name
  // must never render again, but its Excel receipts still feed the new name)
  'Aptamil Gold+ 2 Baby Follow-On Formula From 6 To 12 Months',
  'Aptamil Gold Stage 2 Follow On Baby Formula 6-12M',
  'Plum Red',
  "Sam's Pantry Chocolate Brownie with Roasted Almonds Protein Bar",
  'Dettol Tru Clean Antibacterial Multipurpose Wipes Citrus',
  'The Odd Bunch Cherries Punnet',
  'Eat Now Hass Avocado',
  "Arnold's Farm Granola Pink Lady Apple & Cinnamon",
  'Balconi Mix Max Spgnckes Cocoa',
  'Vevelle 2 Ply White Toilet Tissue',
  // 2026-07-26: deleted at user request. Not an alias of anything, so its 3
  // Excel receipt rows were removed too (a KNOWN_NAME_CHANGES alias would have
  // had to keep them - they feed the renamed product).
  "McKenzie's Pepper Black Corns Blended",
]);

// The list above is the frozen legacy seed. Everything deleted from the UI goes
// into docs/data/removed_items.json instead - a DATA file, because it has to be
// writable from the browser AND readable by the Python scraper (which is the
// half that stops a deleted name being re-scraped out of the Excel). Merged in
// at boot; both halves are enforced together everywhere REMOVED_ITEMS is used.
function mergeRemovedItems(names) {
  (names || []).forEach(n => { if (n) REMOVED_ITEMS.add(n); });
  return REMOVED_ITEMS;
}

async function loadRemovedItems() {
  try {
    const r = await fetch(`data/removed_items.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) mergeRemovedItems(await r.json());
  } catch {}
  return REMOVED_ITEMS;
}

// One group's resolved member names under the user's current overrides.
// ponytail: legacy v1 overrides are treated as pure adds, a close-enough mirror
// of app.js's migratePerKgOverride for a display/grouping filter.
function variantGroupItemNames(g, ov) {
  const o = (ov || {})[g.key] || {};
  const v2 = o.v === 2;
  const remove = new Set(v2 ? (o.remove || []) : []);
  const base = g.items.filter(n => !remove.has(n));
  const added = v2 ? (o.add || []) : (Array.isArray(o.items) ? o.items : []);
  return [...base, ...added.filter(n => !base.includes(n))];
}

// Every per-kg member name under the user's current overrides - used by the
// basket page to keep group members out of the "whole list" fallback view
// (the main table shows ONE row per group, so a raw dump of members would
// inflate the basket) and by the Hot Deals page to swap members for group rows.
function perKgMemberNames() {
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}
  const names = new Set();
  for (const g of allVariantGroupSeeds(ov)) variantGroupItemNames(g, ov).forEach(n => names.add(n));
  return names;
}

// ── Per-kg groups for the Hot Deals page ────────────────────────────────────
// Collapse each variant group's members into ONE synthetic deal item, so Hot
// Deals compares the cheapest $/kg product at each store (matching the main
// page) instead of surfacing individual members - whose cross-store pack-price
// comparison is apples-to-oranges (different pack sizes, single-store SKUs).
// The synthetic item carries $/kg as its "price" and $/kg history, so
// getDealQuality / getTrendSeries (price-agnostic min/median math) run
// correctly in $/kg space - the same trick app.js's buildGroupHistoryItem uses.
// ponytail: honours per-kg MEMBERSHIP overrides (pw_perkg_cats_v1) but not
// per-point/per-member $/kg exclusions (set from the main page's history modal;
// rare). Upgrade path: share app.js's buildGroupHistoryItem. A member with no
// derivable size (no $/kg) simply doesn't contribute.
function buildDealGroups(items) {
  const byName = new Map((items || []).map(i => [i.list_item, i]));
  let ov = {};
  try { ov = JSON.parse(localStorage.getItem('pw_perkg_cats_v1') || '{}'); } catch {}

  // Comparison metric: $/kg for per-kg groups, pack price for sticker groups.
  const perKg = (g, res, itemName) => groupMetric(g, res, itemName);
  // A store's pack-price history converted to the metric via that store's own
  // current ratio (metric ÷ pack price). For sticker groups metric = price, so
  // ratio = 1 (raw prices). Null ratio (no size) => drop rather than mislabel.
  const convHist = (g, res, arr, itemName) => {
    const kg = perKg(g, res, itemName);
    if (kg == null || !res.price || !arr) return [];
    const ratio = kg / res.price;
    return arr.filter(e => e.price > 0).map(e => ({ date: e.date, price: +(e.price * ratio).toFixed(2) }));
  };
  // Merge members' per-date series taking the cheapest $/kg across members at
  // each date (carry-forward last-known), same shape as buildGroupHistoryItem.
  const mergeSeries = (perMember) => {
    const withData = perMember.filter(s => s.length);
    const dates = [...new Set(withData.flat().map(p => p.date))].sort();
    const cursor = withData.map(() => 0), last = withData.map(() => null), out = [];
    for (const date of dates) {
      withData.forEach((s, i) => { while (cursor[i] < s.length && s[cursor[i]].date <= date) last[i] = s[cursor[i]++]; });
      const known = last.filter(p => p != null);
      if (known.length) out.push({ date, price: Math.min(...known.map(p => p.price)) });
    }
    return out;
  };

  const groups = [];
  for (const g of allVariantGroupSeeds(ov)) {
    const members = variantGroupItemNames(g, ov).map(n => byName.get(n)).filter(Boolean);
    if (!members.length) continue;

    const wwBest = members.map(m => ({ m, kg: perKg(g, m.woolworths, m.list_item) })).filter(x => x.kg != null).sort((a, b) => a.kg - b.kg)[0];
    const coBest = members.map(m => ({ m, kg: perKg(g, m.coles,      m.list_item) })).filter(x => x.kg != null).sort((a, b) => a.kg - b.kg)[0];
    if (!wwBest && !coBest) continue;

    groups.push({
      list_item: '__group_' + g.key,
      _isGroup: true,
      _groupLabel: g.label,
      _sticker: !!g.sticker,
      // Carried for the same reason perPack had to be re-exported above: anything
      // reading these groups (metricShown, pieceQuoteOf) sees only what this
      // shape hands it, so a field left off here is silently absent downstream.
      _perPack: !!g.perPack,
      _quote: pieceQuoteOf(g),
      _metricSuffix: g.perPack ? pieceQuoteSuffix(pieceQuoteOf(g)) : (g.sticker ? '' : '/kg'),
      _memberNames: members.map(m => m.list_item), // for the basket handoff (re-collapsed there)
      category: g.category || GROUP_DEFAULT_CATEGORY,
      trip_count: null,
      woolworths: wwBest ? { price: wwBest.kg, url: wwBest.m.woolworths.url, image_url: wwBest.m.woolworths.image_url, name: wwBest.m.woolworths.name } : null,
      coles:      coBest ? { price: coBest.kg, url: coBest.m.coles.url,      image_url: coBest.m.coles.image_url,      name: coBest.m.coles.name } : null,
      ww_price_history:    mergeSeries(members.map(m => convHist(g, m.woolworths, [...(m.price_history || []), ...(m.ww_price_history || [])], m.list_item))),
      coles_price_history: mergeSeries(members.map(m => convHist(g, m.coles, m.coles_price_history, m.list_item))),
      price_history: [],
    });
  }
  return groups;
}

// ── Category normalisation ──────────────────────────────────────────────────
// SINGLE map for every page (index, hot-deals, shopping-list). Covers the old
// scraper names AND the 2026-07 category consolidation (13 → 10: Bakery folded
// into Pantry, Frozen Foods + Ready Meals merged, Personal Care + Baby merged) -
// so stale latest.json values and old user overrides in pw_categories_v1 keep
// resolving to a live category instead of resurrecting a dead tab.
const CATEGORY_REMAP = {
  'Fruit':                  'Fruit & Veg',
  'Vegetables':             'Fruit & Veg',
  'Bakery':                 'Pantry',
  'Bread & Bakery':         'Pantry',
  'Spices & Herbs':         'Pantry',
  'Spreads & Dips':         'Pantry',
  'Nuts & Seeds':           'Pantry',
  'Frozen Foods':           'Frozen',
  'Ready Meals':            'Frozen',
  'Frozen & Ready Meals':   'Frozen',
  'Snacks & Confectionery': 'Sweets',
  'Snacks':                 'Sweets',
  'Drinks':                 'Drinks & Alcohol',
  'Baby':                   'Baby & Care',
  'Health & Beauty':        'Baby & Care',
  'Personal Care & Baby':   'Baby & Care',
  'Personal Care':          'Baby & Care', // 2026-07 rename: nappies/formula living under "Personal Care" read as mislabeled
};

// Per-item category corrections - applied after CATEGORY_REMAP, before user
// localStorage overrides win. These fix scraper mismatches without editing
// latest.json. SINGLE copy here so index, hot-deals and shopping-list agree
// (when only app.js had it, corrected items landed under their raw category
// on the Basket page's shopping mode).
const ITEM_CATEGORY_DEFAULTS = {
  // Bakery → correct
  'Essentials Domestic Wipes Roll':                               'Household',
  'Woolworths Fresh Continental Parsley Bunch':                   'Fruit & Veg',
  // Dairy & Eggs → correct (scraper matched by store section, not product type)
  'Ben & Jerry\'s Ice Cream Tub Chocolate Chip Cookie Dough':    'Frozen Foods',
  'Cadbury Dairy Milk Large Chocolate Block':                     'Sweets',
  'Cadbury Dairy Milk Top Deck Chocolate Block':                  'Sweets',
  'Continental Classics Cup A Soup Creamy Chicken With Croutons': 'Pantry',
  'KitKat Milk Chocolate Mini Bars Share Pack':                   'Sweets',
  'Maltesers Milk Chocolate Party Gift Box':                      'Sweets',
  'McVitie\'s Digestives Milk Chocolate':                        'Sweets',
  'McVitie\'s Hobnobs Milk Chocolate':                           'Sweets',
  'Pringles Sour Cream & Onion Potato Chips':                     'Sweets',
  'Snickers Milk Chocolate Party Share Bag':                      'Sweets',
  'Snickers Milk Chocolate Party Share Bag 20 Pieces':            'Sweets',
  'Woolworths Beef Porterhouse Steak & Butter':                   'Meat & Seafood',
  'Woolworths Butternut Pumpkin Cut':                             'Fruit & Veg',
  'Yumi\'s Eggplant Mediterranean Dip':                          'Pantry',
  // Fruit & Veg → correct
  'Baby Mum-Mum Organiic Rice Rusks Blueberry & Carrot':         'Baby',
  'Dolmio Extra Bolognese Tomato Pasta Sauce':                    'Pantry',
  'Macro Organic Natural Pumpkin Kernels':                        'Pantry',
  'Mutti Tomato Paste Double Concentrate':                        'Pantry',
  'Sam\'s Pantry Granola Pink Lady Apple & Cinnamon':             'Pantry',
  'Schweppes Lemon Lime Bitters Soft Drink Classic Mixers Bottle': 'Drinks & Alcohol',
  'Schweppes Orange Mango Natural Mineral Water Bottle':          'Drinks & Alcohol',
  'Twinings Honeybush, Orange & Mandarin':                        'Pantry',
  'Twinings Orange & Cinnamon Tea Bags Tea':                      'Pantry',
  // Meat & Seafood → correct
  'Continental Classics Cup A Soup Chicken With Lots Of Noodles': 'Pantry',
  // Other → correct
  'Hedy\'s Fresh Quiche Lorraine Chilled Meal':                   'Ready Meals',
  'Old El Paso Fajita Spice Mix Mexican Style':                   'Pantry',
  'Parsnip Fresh':                                                'Fruit & Veg',
  'Weet-Bix Little Kids Breakfast Cereal':                        'Baby',
  'Woolworths Garlic Heads CLOVE':                                'Fruit & Veg',
  // Pantry → correct
  'Baby Mum-Mum Snack Vegetable Rice Rusk':                      'Baby',
  'Strike Blue Toilet Cleaner Cistern Blocks':                    'Household',
  'Vevelle White 2 Ply Toilet Tissue':                            'Household',
  'Woolworths Dill Fresh Herb':                                   'Fruit & Veg',
};

function normalizeCategory(raw) {
  const c = (raw || '').trim() || 'Other';
  return CATEGORY_REMAP[c] || c;
}

// Canonical hot-deal list - the SINGLE source of truth shared by the main page
// (which only needs the COUNT) and the Hot Deals page (which renders the list).
// Both call this with the same inputs so the "🔥 N deals" number on the main
// page always equals the number of rows shown on the Hot Deals page.
//   opts.exclusions  - per-item excluded historical prices (pw_exclusions_v1)
//   opts.archivedSet - names archived in docs/data/archived_items.json
//   opts.priorities  - localStorage priorities (pw_priorities_v1); 'archive' hides
//   opts.minDropPct / opts.minStoreDiffPct - optional threshold overrides (the
//     Hot Deals sliders; both pages pass the same stored values so the main-page
//     count always equals the rows shown). Defaults reproduce the canonical
//     qualify rule exactly: drop ≥ DEAL_MIN_DROP (or all-time low), any store gap.
function getHotDealItems(items, opts) {
  opts = opts || {};
  const exclusions  = opts.exclusions  || {};
  const archivedSet = opts.archivedSet || new Set();
  const priorities  = opts.priorities  || {};
  // Every field must be defaulted here. This function rebuilds the tune from
  // loose opts rather than taking one, so a field added to dealPassesTune but
  // forgotten here arrives as `undefined` - and `x >= undefined` is false, which
  // silently rejects EVERY item. That is exactly what an empty Hot Deals page
  // looked like the first time these two were added.
  const tune = {
    drop: opts.minDropPct      != null ? opts.minDropPct      : DEAL_TUNE_DEFAULTS.drop,
    diff: opts.minStoreDiffPct != null ? opts.minStoreDiffPct : DEAL_TUNE_DEFAULTS.diff,
    rank:  opts.minRankPct   != null ? opts.minRankPct   : DEAL_TUNE_DEFAULTS.rank,
    stale: opts.maxStaleMonths != null ? opts.maxStaleMonths : DEAL_TUNE_DEFAULTS.stale,
    mode: opts.mode === 'or' ? 'or' : 'and',
  };
  return (items || [])
    .filter(item =>
      !item.archived &&
      priorities[item.list_item] !== 'archive' &&
      !archivedSet.has(item.list_item))
    .map(item => ({ item, deal: getDealQuality(item, exclusions) }))
    .filter(({ deal }) => dealPassesTune(deal, tune));
}

// The ONE tuned-deal predicate - shared by getHotDealItems (Hot Deals page +
// main-page count link) and isHotDeal (🔥 badges), so a 🔥 row is always a row
// the Hot Deals page would actually show at the current slider settings.
// tune: { drop, diff (whole percents), mode: 'and'|'or' }.
function dealPassesTune(deal, tune) {
  if (deal.typical == null || deal.spread < DEAL_MIN_SPREAD || !deal.notAboveRecent) return false;
  // A "deal" that only exists because the two stores are selling different
  // amounts of the product is not a deal - see bwsComparable. Gated here, not
  // just in the Buy/Wait panel, so the table and the 🔥 badges stop calling
  // Salmon Fillets ($38/kg WW vs a $10 Coles portion, i.e. $50/kg) a saving.
  // Ahead of the staleness gate and the ATL hatch: neither should get a chance
  // to wave a size mismatch through.
  if (deal.comparable === false) return false;
  // Staleness gate, applied BEFORE anything else can wave an item through -
  // including the cheapest-ever escape hatch. A price frozen for longer than the
  // cutoff is not news at any threshold; it is the same row every week. Measured
  // from the last CHANGE, so an item that swings every 8 weeks stays eligible
  // while it sits between swings. 0 disables the gate.
  if (tune.stale > 0 && deal.monthsSinceChange != null && deal.monthsSinceChange > tune.stale) return false;
  const passDrop = deal.dropPct   >= tune.drop / 100;
  const passDiff = deal.savingPct >= tune.diff / 100;
  const passRank = deal.pricePercentile != null && deal.pricePercentile >= tune.rank / 100;
  const passSliders = tune.mode === 'or'
    ? (passDrop || passDiff || passRank)
    : (passDrop && passDiff && passRank);
  // A genuine new low always shows. This was a checkbox; nobody would ever turn
  // it off, because "the cheapest this has ever been" is the single strongest
  // reason a row belongs on a page called Hot Deals. Now unconditional - the
  // staleness and comparability gates above still apply to it, which is what
  // stopped it being wallpaper in the first place.
  return deal.isAllTimeLow || passSliders;
}

// Shared slider state for the deal thresholds (Hot Deals page writes it, both
// pages read it so their numbers agree).
// Slider defaults are deliberately strict - "a fifth off its usual price AND a
// tenth cheaper than the rival". At the old 4%/0% defaults the page showed 73
// "deals" out of ~210 active items, which made the word meaningless.
// `stale`: hide items whose price has not moved in this many months (0 = off).
// `rank`: minimum price percentile, i.e. "cheaper than this % of its own past
// year". 0 keeps the old behaviour for anyone who wants the sliders alone.
// Fixed, not tunable: the UI offers a checkbox, because the exact number of
// months is not a thing anyone wants to sit and dial in.
// No `atl` any more - a genuine new low always shows (see dealPassesTune). Old
// saved tunes may still carry the key; it is simply ignored on read.
const HD_STALE_MONTHS = 3;
const DEAL_TUNE_DEFAULTS = { drop: 20, diff: 10, rank: 75, stale: HD_STALE_MONTHS, mode: 'and' };
function loadDealTune() {
  try {
    const t = JSON.parse(localStorage.getItem('pw_hd_tune_v1') || 'null');
    if (t && typeof t.drop === 'number' && typeof t.diff === 'number')
      return {
        drop: t.drop, diff: t.diff,
        // Saved tunes predate these two, so fall back to the defaults rather
        // than to 0/undefined (which would silently disable the new gates).
        rank:  typeof t.rank  === 'number' ? t.rank  : DEAL_TUNE_DEFAULTS.rank,
        stale: typeof t.stale === 'number' ? t.stale : DEAL_TUNE_DEFAULTS.stale,
        mode: t.mode === 'or' ? 'or' : 'and',
      };
  } catch {}
  return { ...DEAL_TUNE_DEFAULTS };
}

// ── Buy / Wait / Stock up ───────────────────────────────────────────────────
// The table below answers "what is cheap". It does not answer "what should I do
// about it", which is the only question anyone actually arrives with. These
// cards do, and there are deliberately few: a verdict you get five of is a
// verdict, a verdict you get forty of is another list.
//
// Every card is backed by this item's OWN recorded prices. Nothing here is a
// forecast. Promo-cycle prediction was scoped for this panel and cut on the
// evidence: the daily history only begins 2026-06-15, and on the real file
// exactly 4 of 290 items yield a repeating dip pattern - two of those at
// periods of 198 and 163 days, i.e. noise that happened to pass a consistency
// test. Predicting "back on special in 2 weeks" from that would be invention.
// "Last this cheap 6 weeks ago" carries the same decision and is measured.
// Revisit once there are ~9 months of daily prices (≈ 2027-03).
const BWS_MAX_CARDS   = 5;      // a cap, not a quota - a quiet week shows fewer
const BWS_MAX_WAIT    = 2;      // this page is called Hot Deals; don't fill it with "no"
const BWS_MIN_HISTORY = 5;      // distinct recorded dates before we will judge at all
const BWS_STOCK_RANK  = 0.9;    // "stock up" = cheaper than 90% of its own past
const BWS_WAIT_RANK   = 0.25;   // "wait" = dearer than 75% of its own past
const BWS_WAIT_GAP    = 0.10;   // ...and at least this far above a price seen recently
const BWS_WAIT_DAYS   = 120;    // how far back "recently" reaches for a wait
const BWS_MIN_STAKE   = 0.5;    // dollars per unit - below this it is not advice, it is noise
const BWS_SIZE_TOL    = 0.15;   // how far the rival may move when restated at the same quantity
const BWS_MIN_RATIO   = 0.4;    // a price move bigger than this is a different product, not a special
// Things that keep. Fruit & Veg and Dairy & Eggs are deliberately absent:
// telling someone to stock up on lettuce is how a panel like this loses trust.
// Meat is in because it freezes, and it is a third of the spend here.
const BWS_KEEPS = new Set(['Pantry', 'Household', 'Frozen', 'Drinks & Alcohol',
                           'Baby & Care', 'Sweets', 'Meat & Seafood']);

// One price per date - the cheapest seen that day across both stores, matching
// getDealQuality's `currentBest = min(ww, coles)`. Comparing today's best offer
// against a series that sometimes holds the dearer store's price would invent
// drops that never happened.
function bwsSeries(item, exclusions) {
  const excluded = exclPriceSet(exclusions && exclusions[item.list_item]);
  const by = new Map();
  for (const h of [...(item.price_history || []), ...(item.ww_price_history || []),
                   ...(item.coles_price_history || [])]) {
    const date = String(h.date || '').slice(0, 10), price = Number(h.price);
    if (!date || !(price > 0) || excluded.has(price.toFixed(2))) continue;
    if (!by.has(date) || price < by.get(date)) by.set(date, price);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
                          .map(([date, price]) => ({ date, price }));
}

// min(ww, coles) is only a price if the two listings are the same amount of
// food. sameQtyCost restates the rival at the Woolworths pack quantity; when
// that moves it by more than BWS_SIZE_TOL the two are different sizes, and the
// cheaper pack price is a smaller portion rather than a saving. On the live file
// this catches 42 of the 144 pairs that carry a rate on both sides - including
// salmon at $38/kg "beaten" by a $10 portion that restates to $50/kg.
//
// ponytail: silent when either side has no per-100 rate (146 of 290 items), so a
// mismatch between two unsized listings still gets through - BWS_MIN_RATIO is
// the second net under it. Closing that properly means sizes on every listing,
// i.e. a scraper change, not a client one.
function bwsComparable(item) {
  const ww = item.woolworths, co = item.coles;
  if (!ww || !co || ww.price == null || co.price == null) return true;  // one store: nothing to mix up
  const p = per100Pair(ww, co);
  const q = sameQtyCost(ww.price, co.price, p.ww.value, p.coles.value);
  if (!q || !q.normalised) return true;
  return Math.abs(q.co - co.price) <= co.price * BWS_SIZE_TOL;
}

function bwsAgo(days) {
  if (days == null) return '';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 70) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30.44)} months ago`;
}

// One item -> at most one card, or null. `today` is injectable so the self-check
// can pin a date instead of racing the clock.
// `rate` is {scale, unit}: multiply every dollar figure by scale and suffix the
// unit. It is injected rather than computed here because deciding whether an
// item HAS a meaningful per-kg rate needs the variant-group config, which lives
// in the page. Passing it in keeps this function pure and means the card and
// the history chart it opens are driven by the same decision - they diverged
// once already (card $18, chart $45.00/kg) and that is the bug this prevents.
function bwsVerdict(item, deal, series, tune, today, rate) {
  const _s = (rate && rate.scale) || 1;
  const _u = (rate && rate.unit) || '';
  const money = (v) => fmt(v * _s) + _u;
  if (deal.typical == null || !(deal.price > 0)) return null;
  const past = series.filter(p => !p.date || p.date < today);
  if (past.length < BWS_MIN_HISTORY) return null;
  const cur = deal.price;
  if (!bwsComparable(item)) return null;
  const keeps = BWS_KEEPS.has(normalizeCategory(item.category));

  // When was it last at or below today's price? null = never, i.e. today is the
  // cheapest this item has ever been recorded at.
  let lastAsCheap = null;
  for (let i = past.length - 1; i >= 0; i--) {
    if (past[i].price <= cur + 0.005) { lastAsCheap = past[i].date; break; }
  }
  const daysSince = lastAsCheap
    ? Math.round((Date.parse(today) - Date.parse(lastAsCheap)) / 86400000) : null;
  const rankPct = Math.round((deal.pricePercentile || 0) * 100);

  // A drop this steep is not a special, it is the listing changing underneath
  // us (a 900g bag replaced by a per-kg line, a fillet by a portion). Half price
  // still passes; four-fifths off does not, because groceries do not do that.
  const plausible = cur >= deal.typical * BWS_MIN_RATIO;

  // STOCK UP - near its own floor, and it will still be good when you get to it.
  if (plausible && deal.pricePercentile >= BWS_STOCK_RANK && deal.saveAmount >= BWS_MIN_STAKE && keeps) {
    return {
      verdict: 'stock', order: 0, price: cur, store: deal.store, tied: deal.tied, rate: { scale: _s, unit: _u },
      stake: deal.saveAmount,
      headline: lastAsCheap ? `Cheapest in ${bwsAgo(daysSince).replace(' ago', '')}` : 'Cheapest ever recorded',
      why: `${money(cur)} now vs ${money(deal.typical)} usual. Keeps, so buy for the month.`,
    };
  }
  // BUY - passes the filters you set for this page, and the saving is real money.
  if (plausible && dealPassesTune(deal, tune) && deal.saveAmount >= BWS_MIN_STAKE) {
    return {
      verdict: 'buy', order: 1, price: cur, store: deal.store, tied: deal.tied, rate: { scale: _s, unit: _u },
      stake: deal.saveAmount,
      headline: `${money(deal.saveAmount)} below its usual ${money(deal.typical)}`,
      why: lastAsCheap ? `Last this cheap ${bwsAgo(daysSince)}.`
                       : 'Never been recorded cheaper.',
    };
  }
  // WAIT - dear against its own record, and it was demonstrably cheaper within
  // living memory. Without that second half this is just "expensive item", which
  // is not advice.
  const cutoff = new Date(Date.parse(today) - BWS_WAIT_DAYS * 86400000).toISOString().slice(0, 10);
  // Same plausibility floor, applied to the price we would be telling them to
  // hold out FOR: grapes recorded at $5.50 before the listing became a $18.91
  // per-kg line are not a price that is coming back.
  const recent = past.filter(p => p.date >= cutoff && p.price >= cur * BWS_MIN_RATIO);
  const best = recent.length ? recent.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  if (deal.pricePercentile <= BWS_WAIT_RANK && best
      && cur >= best.price * (1 + BWS_WAIT_GAP) && cur - best.price >= BWS_MIN_STAKE) {
    const ago = Math.round((Date.parse(today) - Date.parse(best.date)) / 86400000);
    return {
      verdict: 'wait', order: 2, price: cur, store: deal.store, tied: deal.tied, rate: { scale: _s, unit: _u },
      stake: cur - best.price,
      headline: `Was ${money(best.price)} ${bwsAgo(ago)}`,
      why: `${money(cur)} today is dearer than ${100 - rankPct}% of its recorded prices.`,
    };
  }
  return null;
}

// Rank by what it is worth to YOU: dollars per unit x how often you buy it. A
// 50c saving on the thing bought weekly beats $3 off something bought once, and
// sorting on discount depth alone gets that exactly backwards. trip_count is
// capped so one 37-trip staple cannot own every slot.
function buyWaitCards(items, opts) {
  opts = opts || {};
  const exclusions  = opts.exclusions  || {};
  const archivedSet = opts.archivedSet || new Set();
  const priorities  = opts.priorities  || {};
  const tune        = opts.tune || loadDealTune();
  const today       = opts.today || new Date().toISOString().slice(0, 10);
  // (item, store) -> {scale, unit}. Default: pack prices, exactly as before.
  const rateFor     = opts.rateFor || (() => ({ scale: 1, unit: '' }));

  const cards = [];
  for (const item of items || []) {
    if (item.archived || item._isGroup) continue;   // group rows price in $/kg; mixing units in a decision panel misleads
    if (priorities[item.list_item] === 'archive' || archivedSet.has(item.list_item)) continue;
    const deal = getDealQuality(item, exclusions);
    const card = bwsVerdict(item, deal, bwsSeries(item, exclusions), tune, today,
                            rateFor(item, deal.store));
    if (!card) continue;
    card.item = item;
    card.score = card.stake * (1 + Math.min(item.trip_count || 0, 12));
    cards.push(card);
  }
  cards.sort((a, b) => b.score - a.score);

  // Select on score alone, then order the survivors so the two "do something"
  // verdicts lead. Waits are capped rather than scored down: one genuinely
  // overpriced staple is worth knowing, five is a different page.
  const picked = [];
  let waits = 0;
  for (const c of cards) {
    if (picked.length >= BWS_MAX_CARDS) break;
    if (c.verdict === 'wait' && ++waits > BWS_MAX_WAIT) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.order - b.order || b.score - a.score);
}
