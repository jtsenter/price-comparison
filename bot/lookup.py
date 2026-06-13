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
    """Score how well a query matches an item name."""
    name = item['list_item'].lower()
    name_words = set(re.findall(r'\w+', name))
    query_words = re.findall(r'\w+', query.lower())
    if not query_words:
        return 0
    # Count query words that appear as whole words in the item name
    hits = sum(1 for w in query_words if w in name_words)
    # Bonus: full query is a substring (catches multi-word phrases)
    bonus = 5 if query.lower() in name else 0
    # Penalty: item name has many extra words (reduces noise matches)
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
    return name[:38] + '…' if len(name) > 38 else name


def build_reply(queries: list) -> str:
    ww_basket = []
    coles_basket = []
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
                ww_basket.append((name, ww, co - ww))
            else:
                coles_basket.append((name, co, ww - co))
        elif ww is not None:
            ww_basket.append((name, ww, 0.0))
        elif co is not None:
            coles_basket.append((name, co, 0.0))
        else:
            not_found.append(q)

    if not ww_basket and not coles_basket:
        return "❓ Couldn't find any of those items in the price list."

    lines = []

    if ww_basket:
        total = sum(p for _, p, _ in ww_basket)
        lines.append(f"🟡 *Woolworths* — ${total:.2f}")
        for name, price, saving in ww_basket:
            save = f"  _(save ${saving:.2f} vs Coles)_" if saving > 0.005 else ''
            lines.append(f"  • {name} — ${price:.2f}{save}")

    if coles_basket:
        if lines:
            lines.append('')
        total = sum(p for _, p, _ in coles_basket)
        lines.append(f"🔴 *Coles* — ${total:.2f}")
        for name, price, saving in coles_basket:
            save = f"  _(save ${saving:.2f} vs WW)_" if saving > 0.005 else ''
            lines.append(f"  • {name} — ${price:.2f}{save}")

    total_saving = sum(s for _, _, s in ww_basket) + sum(s for _, _, s in coles_basket)
    if total_saving > 0.01:
        lines.append(f"\n💰 Splitting saves *${total_saving:.2f}*")

    if not_found:
        lines.append(f"\n❓ Not in list: {', '.join(not_found)}")

    return '\n'.join(lines)
