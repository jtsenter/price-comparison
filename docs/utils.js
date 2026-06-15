// ── utils.js — Shared utilities for PriceWatch
// SINGLE SOURCE OF TRUTH for trend position, hot deal detection, and sorting
// Both app.js (index.html) and hot-deals.html load this file before their own code
// Do NOT redefine these functions elsewhere or divergence will occur

// ── Unified trend data source ──────────────────────────────────────────────
// Single series for both slider and sort: includes price_history + current prices.
function getTrendSeries(item) {
  // Include every observed price: Excel receipts (price_history) plus the scraped
  // WW and Coles histories. Previously only price_history was used, so items whose
  // lows live in ww_price_history (e.g. added from receipts) showed a too-high
  // trend minimum.
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].map(h => Number(h.price));
  const w = item.woolworths?.price, c = item.coles?.price;
  const prices = [...hist, w, c].filter(p => typeof p === 'number' && p > 0);
  const current = Math.min(
    w != null ? w : Infinity,
    c != null ? c : Infinity
  );
  return { prices, current: isFinite(current) ? current : null };
}

// ── Trend Position Calculation ──────────────────────────────────────────────
// Returns 0.0–1.0 where current best price sits in purchase-history range:
//   0.0 = at/below all-time low   (best deal, maximum savings)
//   0.5 = flat history or middle
//   1.0 = at/above all-time high  (worst deal, least savings)
//   999 = no usable history (sorts last)

function calcTrendPosition(item) {
  const { prices, current } = getTrendSeries(item);
  if (prices.length < 2 || current == null) return 999;
  const lo = Math.min(...prices), hi = Math.max(...prices);
  if (lo === hi) return 0.5;
  return Math.max(0, Math.min(1, (current - lo) / (hi - lo)));
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
// low" at $3.80, but that's a 2.6% range — not worth surfacing.
//
// getDealQuality() measures the DEPTH of the discount against the item's
// TYPICAL (median) historical price and requires the price to actually move
// over time before anything qualifies, so flat items drop out.
//
//   typical   = median of historical prices (the "usual" shelf price)
//   spread    = (hi - lo) / hi   — how much the price varies historically
//   dropPct   = (typical - currentBest) / typical — how far below usual we are
//   saveAmount= max(0, typical - currentBest) — $ saved vs the usual price
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

  // Historical (past) prices only — the "usual" price is what it cost before now.
  const excludedSet = new Set(
    ((exclusions && exclusions[item.list_item]) || []).map(p => Number(p).toFixed(2))
  );
  const hist = [
    ...(item.price_history || []),
    ...(item.ww_price_history || []),
    ...(item.coles_price_history || []),
  ].map(h => Number(h.price))
   .filter(p => p > 0 && !excludedSet.has(p.toFixed(2)));
  if (hist.length < 2) return empty;

  const wwP = item.woolworths?.price;
  const coP = item.coles?.price;
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return empty;
  const store = (coP != null && coP <= (wwP ?? Infinity)) ? 'coles' : 'woolworths';

  const lo = Math.min(...hist), hi = Math.max(...hist);
  const typical = _median(hist);
  const spread = hi > 0 ? (hi - lo) / hi : 0;
  const dropPct = typical > 0 ? (typical - currentBest) / typical : 0;
  const saveAmount = Math.max(0, typical - currentBest);
  const isAllTimeLow = currentBest <= lo + 0.01;

  const qualifies = spread >= DEAL_MIN_SPREAD && (dropPct >= DEAL_MIN_DROP || isAllTimeLow);

  // Cross-store gap (secondary "savings": buying at the cheaper store vs the other)
  const otherPrice = store === 'woolworths' ? coP : wwP;
  const savingPct = (otherPrice != null && otherPrice > 0)
    ? (otherPrice - currentBest) / otherPrice : 0;

  const reason = isAllTimeLow
    ? '🏆 All-time low'
    : `↓ ${Math.round(dropPct * 100)}% below usual`;

  return {
    qualifies, store, price: currentBest, otherPrice,
    typical, lo, hi, spread, dropPct, saveAmount, isAllTimeLow,
    savingPct, reason,
  };
}

function isHotDeal(item) {
  return getDealQuality(item).qualifies;
}
