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
  const w = item.woolworths?.price, c = item.coles?.price;
  const prices = [...histPrices, w, c].filter(p => typeof p === 'number' && p > 0);
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

  const reason = isAllTimeLow
    ? '🏆 All-time low'
    : `↓ ${Math.round(dropPct * 100)}% below usual`;

  return {
    qualifies, store, price: currentBest, otherPrice,
    typical, lo, hi, spread, dropPct, saveAmount, isAllTimeLow,
    notAboveRecent, savingPct, reason,
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

// ── Per-kg variant groups (seed data) ───────────────────────────────────────
// Per-kg categories. Each is a comparable product type; the two near-identical
// salmon-fillet and basa entries are merged so each category holds its real
// equivalents. Membership can be fine-tuned in the edit dialog (DEFAULT_VARIANT_GROUPS
// is the seed; user overrides live in localStorage - see loadVariantGroups()).
const DEFAULT_VARIANT_GROUPS = [
  { key: 'chicken_breast', label: 'Chicken Breast', items: [
    'Woolworths RSPCA Approved Chicken Breast Fillet',
    'Woolworths RSPCA Approved Chicken Breast Fillets Skinless Small 450g - 715g',
    'Woolworths RSPCA Approved Chicken Single Breast Fillet 300g',
    'Macro Chicken Breast Fillets Free Range 700g - 1.4kg',
    'Macro Free Range Australian Chicken Breast 500g - 1kg',
    'Macro RSPCA Approved Chicken Breast Free Range Single 300g',
    'Macro Organic Chicken Breast Fillet 500g - 750g',
    'The Bare Bird Free Range Chicken Breast Fillets 600g',
    'Al Sadiq Halal Chicken Breast Fillets Skinless Bulk Pack 1.1kg - 1.65kg',
    'Coles RSPCA Approved Chicken Breast Fillets Large Pack 1.4kg',
    'Coles RSPCA Approved Chicken Breast Fillets Small Pack 600g',
    'Coles RSPCA Approved Free Range Chicken Breast Large Pack 1.25kg',
    'Coles RSPCA Approved Free Range Chicken Breast Fillet Small Pack 600g',
    'Lilydale Free Range Chicken Breast Fillets Bulk 1kg',
  ]},
  { key: 'chicken_drumsticks', label: 'Chicken Drumsticks', items: [
    'Woolworths RSPCA Approved Chicken Drumsticks',
    'Woolworths RSPCA Approved Chicken Drumsticks Bulk 1.1kg - 1.9kg',
    'Macro Free Range Chicken Drumsticks 750g - 1.1kg',
    'Coles RSPCA Approved Chicken Drumsticks 2kg',
    'Coles RSPCA Approved Free Range Chicken Drumsticks 1.4kg',
    'Lilydale Free Range Chicken Drumsticks Bulk 1kg',
  ]},
  { key: 'chicken_thigh', label: 'Chicken Thigh', items: [
    'Woolworths RSPCA Approved Chicken Thigh Skinless Cutlets Bone-In',
    'Woolworths RSPCA Approved Chicken Thigh Fillets Skinless Tray 1kg - 1.9kg',
    'Woolworths RSPCA Approved Chicken Thigh Fillets Skinless Small 550g - 715g',
    'Woolworths RSPCA Approved Chicken Thigh Cutlets Skin On 400g - 600g',
    'Woolworths RSPCA Approved Chicken Thigh Fillet per 190g',
    'Macro Free Range Chicken Thigh Fillet 800g - 1.1kg',
    'Macro Free Range Australian Chicken Thigh Fillet 450g - 650g',
    'Macro Organic Chicken Thigh Fillet 450g - 550g',
    'Al Sadiq Halal Chicken Thigh Fillets Bulk Pack 1.5kg - 1.7kg',
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
    'Woolworths Salmon Portions Skin Off 4 pack',
    'Woolworths Diced Tasmanian Salmon Skin Off 300g',
    'Tassal Atlantic Salmon Skin On 300g',
    'Tassal Atlantic Salmon Skin Off 300g',
    'Coles Tasmanian Salmon Portions Skin On 4 Pack 460g',
    'Coles Tasmanian Salmon Portions Skin Off 460g',
    'Tassal Salmon Portions Skin On 300g',
  ]},
  { key: 'basa_fillets', label: 'Basa Fillets', items: [
    'Woolworths Basa Fillets Boneless With Skin Off',
    'Just Caught Skinless Basa Fillets Frozen 1kg',
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
    'Macro Organic Lamb Mince 500g',
    "Cleaver's Grass Fed Lamb Mince 500g",
    'Fettayleh Foods Lamb Mince 500g',
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
  // STICKER group (sticker: true): compared + displayed by PACK PRICE, not $/kg.
  // For near-same-size complementary products the user treats as interchangeable
  // (like the per-kg groups, but "just a normal category"). WW side = cheapest of
  // the two WW jars; Coles side = cheapest Coles jar. See STICKER_GROUPS below.
  { key: 'bolognese_sauce', label: 'Bolognese sauce', category: 'Pantry', sticker: true, items: [
    'Macro Organic Pasta Sauce Chunky Bolognese',
    'Dolmio Extra Bolognese Tomato Pasta Sauce',
  ]},
];

// Groups compared by PACK PRICE, not $/kg (the group's headline shows "$X", no
// "/kg" suffix, and Units count packs). Derived from the sticker flag on the
// group defs so callers that only have the key (basket, units model) can check.
const STICKER_GROUPS = new Set(
  DEFAULT_VARIANT_GROUPS.filter(g => g.sticker).map(g => g.key)
);
// Comparison metric for a group's store-side result: pack price for sticker
// groups, $/kg otherwise. Threading this (instead of clientPerKg) through the
// group builders makes the whole per-kg pipeline - sort, trend, history, hot
// deals, basket - work in "sticker space" for sticker groups (history ratio
// becomes price/price = 1, i.e. raw prices) with no other changes.
function groupMetric(g, res) {
  if (!res || res.price == null) return null;
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
]);

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
  for (const g of DEFAULT_VARIANT_GROUPS) variantGroupItemNames(g, ov).forEach(n => names.add(n));
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
  const perKg = (g, res) => groupMetric(g, res);
  // A store's pack-price history converted to the metric via that store's own
  // current ratio (metric ÷ pack price). For sticker groups metric = price, so
  // ratio = 1 (raw prices). Null ratio (no size) => drop rather than mislabel.
  const convHist = (g, res, arr) => {
    const kg = perKg(g, res);
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
  for (const g of DEFAULT_VARIANT_GROUPS) {
    const members = variantGroupItemNames(g, ov).map(n => byName.get(n)).filter(Boolean);
    if (!members.length) continue;

    const wwBest = members.map(m => ({ m, kg: perKg(g, m.woolworths) })).filter(x => x.kg != null).sort((a, b) => a.kg - b.kg)[0];
    const coBest = members.map(m => ({ m, kg: perKg(g, m.coles)      })).filter(x => x.kg != null).sort((a, b) => a.kg - b.kg)[0];
    if (!wwBest && !coBest) continue;

    groups.push({
      list_item: '__group_' + g.key,
      _isGroup: true,
      _groupLabel: g.label,
      _sticker: !!g.sticker,
      _memberNames: members.map(m => m.list_item), // for the basket handoff (re-collapsed there)
      category: g.category || 'Meat & Seafood',
      trip_count: null,
      woolworths: wwBest ? { price: wwBest.kg, url: wwBest.m.woolworths.url, image_url: wwBest.m.woolworths.image_url, name: wwBest.m.woolworths.name } : null,
      coles:      coBest ? { price: coBest.kg, url: coBest.m.coles.url,      image_url: coBest.m.coles.image_url,      name: coBest.m.coles.name } : null,
      ww_price_history:    mergeSeries(members.map(m => convHist(g, m.woolworths, [...(m.price_history || []), ...(m.ww_price_history || [])]))),
      coles_price_history: mergeSeries(members.map(m => convHist(g, m.coles, m.coles_price_history))),
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
  const tune = {
    drop: opts.minDropPct      != null ? opts.minDropPct      : DEAL_TUNE_DEFAULTS.drop,
    diff: opts.minStoreDiffPct != null ? opts.minStoreDiffPct : DEAL_TUNE_DEFAULTS.diff,
    atl:  opts.includeATL == null ? DEAL_TUNE_DEFAULTS.atl : !!opts.includeATL,
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
// tune: { drop, diff (whole percents), atl, mode: 'and'|'or' }.
function dealPassesTune(deal, tune) {
  if (deal.typical == null || deal.spread < DEAL_MIN_SPREAD || !deal.notAboveRecent) return false;
  const passDrop = deal.dropPct   >= tune.drop / 100;
  const passDiff = deal.savingPct >= tune.diff / 100;
  const passSliders = tune.mode === 'or' ? (passDrop || passDiff) : (passDrop && passDiff);
  // All-time low is an OR escape hatch (checkbox), regardless of the sliders.
  return (tune.atl && deal.isAllTimeLow) || passSliders;
}

// Shared slider state for the two deal thresholds (Hot Deals page writes it,
// both pages read it so their numbers agree).
// Slider defaults are deliberately strict - "a fifth off its usual price AND a
// tenth cheaper than the rival". At the old 4%/0% defaults the page showed 73
// "deals" out of ~210 active items, which made the word meaningless. ATL stays
// on by default: an all-time low is always worth surfacing regardless of where
// the sliders sit, which is the point of the checkbox being an OR escape hatch.
const DEAL_TUNE_DEFAULTS = { drop: 20, diff: 10, atl: true, mode: 'and' };
function loadDealTune() {
  try {
    const t = JSON.parse(localStorage.getItem('pw_hd_tune_v1') || 'null');
    if (t && typeof t.drop === 'number' && typeof t.diff === 'number')
      return {
        atl: typeof t.atl === 'boolean' ? t.atl : DEAL_TUNE_DEFAULTS.atl,
        drop: t.drop, diff: t.diff,
        mode: t.mode === 'or' ? 'or' : 'and',
      };
  } catch {}
  return { ...DEAL_TUNE_DEFAULTS };
}
