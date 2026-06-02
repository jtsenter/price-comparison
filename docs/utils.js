// ── utils.js — Shared utilities for PriceWatch
// SINGLE SOURCE OF TRUTH for trend position, hot deal detection, and sorting
// Both app.js (index.html) and hot-deals.html load this file before their own code
// Do NOT redefine these functions elsewhere or divergence will occur

// ── Trend Position Calculation ──────────────────────────────────────────────
// Returns 0.0–1.0 where current best price sits in purchase-history range:
//   0.0 = at/below all-time low   (best deal, maximum savings)
//   0.5 = flat history or middle
//   1.0 = at/above all-time high  (worst deal, least savings)
//   999 = no usable history (sorts last)

function calcTrendPosition(item) {
  const hist = item.price_history || [];
  if (hist.length < 2) return 999;
  const prices = hist.map(h => Number(h.price)).filter(p => p > 0);
  if (prices.length < 2) return 999;
  const histMin = Math.min(...prices);
  const histMax = Math.max(...prices);
  if (histMin === histMax) return 0.5;  // flat → middle
  const wwP = item.woolworths?.price;
  const coP = item.coles?.price;
  if (!wwP && !coP) return 999;
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return 999;
  const pos = (currentBest - histMin) / (histMax - histMin);
  return isNaN(pos) ? 999 : Math.max(0, Math.min(1, pos));
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

// ── Hot Deal Detection ──────────────────────────────────────────────────────
// An item qualifies as a hot deal if:
//   1. Not archived
//   2. Current best price is at/below all-time low (within 1¢), OR
//   3. Current best price is in bottom 20% of its historical range
// Uses price_history only (Excel purchase trips, not scrape history)

function isHotDeal(item) {
  if (item.archived) return false;
  const pos = calcTrendPosition(item);
  if (pos === 999 || pos === 0.5) return false;  // no usable history or flat
  const hist = item.price_history || [];
  const prices = hist.map(h => Number(h.price)).filter(p => p > 0);
  if (prices.length < 2) return false;
  const histMin = Math.min(...prices);
  const wwP = item.woolworths?.price;
  const coP = item.coles?.price;
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return false;
  // All-time low (1¢ tolerance) OR bottom 20% of range
  return currentBest <= histMin + 0.01 || pos < 0.20;
}
