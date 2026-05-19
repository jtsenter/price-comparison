"""Product matching and price normalisation utilities.

Used by scraper.py to:
  - pick the best result from a store search list (instead of blindly taking index 0)
  - validate ww+coles pairs for form/size compatibility
  - compute per-100g or per-100ml normalised prices
  - emit a confidence level (high / medium / low / none)
"""

import re
from difflib import SequenceMatcher


# ── Weight / volume extraction ────────────────────────────────────────────────

def extract_weight_g(text: str) -> float | None:
    """Return weight in grams extracted from `text`, or None."""
    t = text.lower()
    m = re.search(r'(\d+(?:\.\d+)?)\s*kg\b', t)
    if m:
        return float(m.group(1)) * 1000
    m = re.search(r'(\d+(?:\.\d+)?)\s*g\b', t)
    return float(m.group(1)) if m else None


def extract_volume_ml(text: str) -> float | None:
    """Return volume in ml extracted from `text`, or None."""
    t = text.lower()
    # Litres — avoid matching the 'l' in words like 'salted'
    m = re.search(r'(\d+(?:\.\d+)?)\s*(?:l(?:it(?:re|er)s?)?)(?:\b|(?=\s))', t)
    if m and not re.search(r'\d+(?:\.\d+)?\s*ml', t[:m.end()]):
        return float(m.group(1)) * 1000
    m = re.search(r'(\d+(?:\.\d+)?)\s*ml\b', t)
    return float(m.group(1)) if m else None


# ── Form classification ───────────────────────────────────────────────────────

_FORM_RULES: list[tuple[str, list[str]]] = [
    ('FROZEN',    ['frozen', 'freeze dried', 'ice cream', 'sorbet']),
    # PROCESSED before COOKED so 'baked beans' is matched before 'baked'
    ('PROCESSED', ['sausage', 'salami', ' ham ', 'bacon', 'mince', 'nuggets',
                   'battered', 'crumbed', 'tinned', 'canned', 'pickled',
                   'baked beans', 'pasta sauce', 'soup', 'pate', 'terrine']),
    ('COOKED',    ['cooked', 'roasted', 'baked', 'grilled', 'smoked', 'cured',
                   'deli ', 'shaved', 'sliced ', 'marinated', 'seasoned', ' bbq',
                   'rotisserie', 'pre-cooked', 'precooked', 'ready to eat',
                   'poached', 'steamed', 'chargrilled']),
    ('FRESH',     ['fresh ', 'bunch', ' raw ']),
]


def classify_form(name: str) -> str:
    """Return one of FROZEN / COOKED / PROCESSED / FRESH / UNKNOWN."""
    n = name.lower()
    for form, keywords in _FORM_RULES:
        if any(kw in n for kw in keywords):
            return form
    return 'UNKNOWN'


# ── Canonical name ────────────────────────────────────────────────────────────

_STRIP_LEADING = [
    'woolworths ', 'coles ', 'macro ', 'odd bunch ', 'homebrand ',
    'select ', 'always fresh ', 'down to earth ', 'community co ',
]

_STRIP_INLINE = re.compile(
    r'\b(organic|free[- ]range|australian|premium|classic|original|'
    r'traditional|natural|value|economy|budget|finest|everyday)\b',
    re.IGNORECASE,
)

_STRIP_SIZE = re.compile(
    r'\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b'
    r'|\b\d+\s*(?:x\s*\d+(?:\s*(?:g|ml|kg|l))?)\b'
    r'|\b\d+\s*(?:pack|pk|ct|count)\b',
    re.IGNORECASE,
)


def canonical_name(name: str) -> str:
    """Strip store/brand prefixes and size info; return core product descriptor."""
    n = name.lower().strip()
    for prefix in _STRIP_LEADING:
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    n = _STRIP_INLINE.sub('', n)
    n = _STRIP_SIZE.sub('', n)
    n = re.sub(r'\s+', ' ', n).strip(' -,')
    return n


# ── Similarity ────────────────────────────────────────────────────────────────

def name_similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


# ── Metadata bundle ───────────────────────────────────────────────────────────

def extract_metadata(name: str) -> dict:
    weight = extract_weight_g(name)
    volume = extract_volume_ml(name)
    return {
        'canonical': canonical_name(name),
        'weight_g':  weight,
        'volume_ml': volume,
        'size':      weight or volume,
        'is_liquid': volume is not None and weight is None,
        'form':      classify_form(name),
    }


# ── Pick best match ───────────────────────────────────────────────────────────

def pick_best_match(query: str, results: list[dict]) -> tuple[dict | None, str]:
    """
    Choose the most relevant product from a store search result list.

    Returns (best_result | None, confidence).
    confidence: 'high' | 'medium' | 'low' | 'none'

    Scoring:
      - base = SequenceMatcher ratio between canonical names
      - form mismatch (both known & different) → ×0.35 penalty
      - extreme size mismatch (ratio < 0.25)   → ×0.65 penalty
    Reject entirely when best_sim < 0.28 (completely different product).
    """
    if not results:
        return None, 'none'

    q = extract_metadata(query)

    scored: list[tuple[float, float, bool, dict]] = []
    for r in results:
        if not r.get('name'):
            continue
        m = extract_metadata(r['name'])

        sim = name_similarity(q['canonical'], m['canonical'])

        form_ok = (
            q['form'] == 'UNKNOWN'
            or m['form'] == 'UNKNOWN'
            or q['form'] == m['form']
        )
        if not form_ok:
            sim *= 0.35

        # Size penalty only for very extreme mismatches
        r_size = m['size']
        if r_size is None and r.get('unit'):
            r_size = extract_weight_g(r['unit']) or extract_volume_ml(r['unit'])
        if q['size'] and r_size:
            ratio = min(q['size'], r_size) / max(q['size'], r_size)
            if ratio < 0.25:
                sim *= 0.65

        scored.append((sim, name_similarity(q['canonical'], m['canonical']), form_ok, r))

    if not scored:
        return None, 'none'

    scored.sort(key=lambda x: x[0], reverse=True)
    penalised_sim, raw_sim, form_ok, best = scored[0]

    # Stricter threshold when both forms are known and incompatible
    min_sim = 0.50 if not form_ok else 0.28
    if raw_sim < min_sim:
        return None, 'none'

    if raw_sim >= 0.82 and form_ok:
        confidence = 'high'
    elif raw_sim >= 0.55 and form_ok:
        confidence = 'medium'
    else:
        confidence = 'low'

    return best, confidence


# ── Per-100g / per-100ml price ────────────────────────────────────────────────

def compute_per_100(result: dict) -> tuple[float | None, str]:
    """
    Return (price_per_100, unit_label) where unit_label is '100g' or '100ml'.

    Priority:
      1. unit_price + unit  (store-provided cup price, most accurate)
      2. price ÷ size extracted from product name
    """
    if not result:
        return None, '100g'

    unit       = (result.get('unit') or '').lower().strip()
    unit_price = result.get('unit_price')
    price      = result.get('price')

    # Strategy 1 — cup price
    if unit_price is not None and unit:
        m = re.match(r'(\d*\.?\d*)?\s*(g|kg|ml|l)\b', unit)
        if m:
            qty_s = m.group(1)
            qty   = float(qty_s) if qty_s else 1.0
            uom   = m.group(2)
            if uom == 'kg': qty *= 1000
            elif uom == 'l': qty *= 1000
            if qty > 0:
                lbl = '100ml' if uom in ('ml', 'l') else '100g'
                return round(unit_price * 100 / qty, 2), lbl

    if price is None:
        return None, '100g'

    # Strategy 2 — extract from product name
    name = result.get('name', '')
    w = extract_weight_g(name)
    if w and w > 0:
        return round(price * 100 / w, 2), '100g'
    v = extract_volume_ml(name)
    if v and v > 0:
        return round(price * 100 / v, 2), '100ml'

    return None, '100g'


# ── Validate a ww + coles pair ────────────────────────────────────────────────

def validate_pair(
    item_name: str,
    ww_result:  dict | None,
    coles_result: dict | None,
    ww_confidence:    str = 'none',
    coles_confidence: str = 'none',
) -> dict:
    """
    Compute pair-level metadata after both matches are selected.

    Returns dict with keys:
      match_confidence  — worst-of-two confidence, degraded if sizes differ
      size_warning      — True when pack sizes or forms differ significantly
      per_100_ww        — normalised WW price per 100g/ml (float | None)
      per_100_coles     — normalised Coles price per 100g/ml (float | None)
      per_100_unit      — '100g' or '100ml'
    """
    per_100_ww,    lbl_ww    = compute_per_100(ww_result)
    per_100_coles, lbl_coles = compute_per_100(coles_result)
    per_100_unit = '100ml' if (lbl_ww == '100ml' or lbl_coles == '100ml') else '100g'

    size_warning = False
    if ww_result and coles_result:
        wm = extract_metadata(ww_result['name'])
        cm = extract_metadata(coles_result['name'])

        # Form mismatch (both sides known and different)
        if (wm['form'] != 'UNKNOWN' and cm['form'] != 'UNKNOWN'
                and wm['form'] != cm['form']):
            size_warning = True

        # Pack size differs by more than 25 %
        ws, cs = wm['size'], cm['size']
        if ws and cs:
            if min(ws, cs) / max(ws, cs) < 0.75:
                size_warning = True

    # Unified confidence = worst of two sides
    _order = ['high', 'medium', 'low', 'none']
    combined = _order[max(_order.index(ww_confidence),
                          _order.index(coles_confidence))]
    # Downgrade high → medium when sizes diverge noticeably
    if size_warning and combined == 'high':
        combined = 'medium'

    return {
        'match_confidence': combined,
        'size_warning':     size_warning,
        'per_100_ww':       per_100_ww,
        'per_100_coles':    per_100_coles,
        'per_100_unit':     per_100_unit,
    }
