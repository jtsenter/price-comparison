import json
import os
import re
import time

DATA_PATH = os.path.join(os.path.dirname(__file__), '..', 'docs', 'data', 'latest.json')

_items = []
_loaded_at = 0
CACHE_TTL = 300  # reload data every 5 minutes


def _load():
    global _items, _loaded_at
    with open(DATA_PATH, encoding='utf-8') as f:
        data = json.load(f)
    _items = data['items']
    _loaded_at = time.time()


def _get_items():
    if not _items or time.time() - _loaded_at > CACHE_TTL:
        _load()
    return _items


def _ww_price(item):
    ww = item.get('woolworths') or {}
    p = ww.get('price')
    if p:
        return float(p)
    hist = item.get('ww_price_history', [])
    if hist:
        return float(max(hist, key=lambda x: x.get('date', ''))['price'])
    return None


def _coles_price(item):
    co = item.get('coles') or {}
    p = co.get('price')
    if p:
        return float(p)
    hist = item.get('coles_price_history', [])
    if hist:
        return float(max(hist, key=lambda x: x.get('date', ''))['price'])
    return None


def _score(query: str, item: dict) -> int:
    name = item['list_item'].lower()
    name_words = set(re.findall(r'\w+', name))
    query_words = re.findall(r'\w+', query.lower())
    if not query_words:
        return 0
    hits = sum(1 for w in query_words if w in name_words)
    bonus = 5 if query.lower() in name else 0
    extra = max(0, len(name_words) - len(query_words) - 2)
    return hits * 10 + bonus - extra


def find_item(query: str):
    items = _get_items()
    best, best_score = None, 0
    for item in items:
        s = _score(query, item)
        if s > best_score:
            best, best_score = item, s
    return best if best_score > 0 else None


def parse_queries(text: str) -> list:
    parts = re.split(r'[,\n]+|\band\b', text, flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip() and len(p.strip()) > 1]


def _shorten(name: str) -> str:
    for prefix in ('Woolworths ', 'The Odd Bunch ', 'Coles '):
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name[:36] + '…' if len(name) > 36 else name


def _h(text: str) -> str:
    """Escape special HTML characters for Telegram HTML mode."""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def build_reply(queries: list) -> str:
    # Each entry: (name, winning_price, other_price_or_None, tag_or_None)
    # tag: 'ww_only' | 'coles_only' | None
    ww_items = []
    coles_items = []
    not_found = []

    for q in queries:
        item = find_item(q)
        if item is None:
            not_found.append(q)
            continue

        ww = _ww_price(item)
        co = _coles_price(item)
        name = _shorten(item['list_item'])

        if ww is not None and co is not None:
            if ww <= co:
                other = co if co != ww else None  # no comparison shown when equal
                ww_items.append((name, ww, other, None))
            else:
                coles_items.append((name, co, ww, None))
        elif ww is not None:
            ww_items.append((name, ww, None, 'ww_only'))
        elif co is not None:
            coles_items.append((name, co, None, 'coles_only'))
        else:
            not_found.append(q)

    if not ww_items and not coles_items:
        return "❓ Couldn't find any of those items in the price list."

    lines = []

    if ww_items:
        ww_total = sum(p for _, p, _, _ in ww_items)
        lines.append('<b>🟡 Woolworths</b>')
        for name, price, other, tag in ww_items:
            other_str = f'  <s>${other:.2f}</s>' if other else ''
            tag_str = '  <i>WW only</i>' if tag == 'ww_only' else ''
            lines.append(f'{_h(name)}{other_str}{tag_str}  <b>${price:.2f}</b>')
        lines.append(f'<i>Total: ${ww_total:.2f}</i>')

    if coles_items:
        if lines:
            lines.append('')
        coles_total = sum(p for _, p, _, _ in coles_items)
        lines.append('<b>🔴 Coles</b>')
        for name, price, other, tag in coles_items:
            other_str = f'  <s>${other:.2f}</s>' if other else ''
            tag_str = '  <i>Coles only</i>' if tag == 'coles_only' else ''
            lines.append(f'{_h(name)}{other_str}{tag_str}  <b>${price:.2f}</b>')
        lines.append(f'<i>Total: ${coles_total:.2f}</i>')

    total_saving = (
        sum(o - p for _, p, o, _ in ww_items if o) +
        sum(o - p for _, p, o, _ in coles_items if o)
    )
    if total_saving > 0.01:
        lines.append(f'\n💰 Split saves <b>${total_saving:.2f}</b>')

    if not_found:
        lines.append(f'\n❓ Not found: {_h(", ".join(not_found))}')

    return '\n'.join(lines)
