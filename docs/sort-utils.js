// ── sort-utils.js — shared sort & deal utilities ─────────────────────────────
// Loaded before app.js (index.html) and before the inline script (hot-deals.html).
// All functions are global (no module system) so both pages call them directly.
// Do NOT redefine isHotDeal, calcTrendPos, or sortByTrend in either page.

// ── Hot deal detection ────────────────────────────────────────────────────────
// An item qualifies as a hot deal if its current best price is:
//   • at or below the all-time purchase-history low  (currentBest <= histMin + 0.01 cent tolerance), OR
//   • in the bottom 20% of its purchase-history range (trendPos < 0.20)
// Uses price_history only (Excel purchase trips) — more stable than scrape history.

function isHotDeal(item) {
  if (item.archived) return false;
  const hist = item.price_history || [];
  if (hist.length < 2) return false;
  const prices = hist.map(h => Number(h.price)).filter(p => p > 0);
  if (prices.length < 2) return false;
  const histMin = Math.min(...prices);
  const histMax = Math.max(...prices);
  if (histMin === histMax) return false; // flat history, no range
  const wwP = item.woolworths?.price;
  const coP = item.coles?.price;
  if (!wwP && !coP) return false;
  const currentBest = Math.min(wwP ?? Infinity, coP ?? Infinity);
  if (!isFinite(currentBest)) return false;
  const range = histMax - histMin;
  const trendPos = (currentBest - histMin) / range;
  const isAllTimeLow = currentBest <= histMin + 0.01; // 1c tolerance
  const isBottom20 = trendPos < 0.20;
  return isAllTimeLow || isBottom20;
}

// ── Trend position ────────────────────────────────────────────────────────────
// Returns a value 0.0–1.0 where the current best price sits in its purchase-history range:
//   0.0 = at or below all-time low   (best deal)
//   1.0 = at or above all-time high  (most expensive)
//   0.5 = flat history (no range) or middle
//   999 = no usable price_history (sorts last in Trend ↑)
// Uses price_history only (Excel purchase trips).

function calcTrendPos(item) {
  const hist = item.price_history || [];
  if (hist.length < 2) return 999;
  const prices = hist.map(h => h.price).filter(p => p > 0);
  if (prices.length < 2) return 999;
  const histMin = Math.min(...prices);
  const histMax = Math.max(...prices);
  const range = histMax - histMin;
  if (range === 0) return 0.5;           // flat history → middle
  const currentBest = Math.min(
    item.woolworths?.price ?? Infinity,
    item.coles?.price ?? Infinity
  );
  if (!isFinite(currentBest)) return 999;
  const pos = (currentBest - histMin) / range;
  return isNaN(pos) ? 999 : pos;
}

// ── Trend sort comparator ─────────────────────────────────────────────────────
// Trend ↑ (asc)  = best deals first  (trendPos 0 = all-time low = cheapest relative to history)
// Trend ↓ (desc) = most expensive relative to history first
// Tiebreak: alphabetical item name for a deterministic order.

function sortByTrend(a, b, dir = 'asc') {
  const pa = calcTrendPos(a);
  const pb = calcTrendPos(b);
  const mul = dir === 'asc' ? 1 : -1;
  if (pa !== pb) return (pa - pb) * mul;
  return a.list_item.localeCompare(b.list_item);
}
