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


_NAME_MAP = {
    "Annalisa Chickpeas": "Annalisa Chickpeas",
    "Armada Small Kitchen Tidy Bag": "Kitchen Tidy Bags",
    "Baby Mum-Mum Organiic Rice Rusks Blueberry & Carrot": "Baby Rice Rusks Blueberry",
    "Baby Mum-Mum Snack Vegetable Rice Rusk": "Baby Rice Rusks Veggie",
    "Balconi Mix Max Cake Cocoa 350g": "Balconi Cocoa Cake",
    "Beechworth 100% Pure Australian Honey Jar": "Beechworth Honey",
    "Ben & Jerry's Ice Cream Tub Chocolate Chip Cookie Dough": "Ben & Jerry's Choc Chip",
    "Blueberries Punnet": "Blueberries Punnet",
    "Bulla Creme Fraiche Creme Fraiche": "Bulla Creme Fraiche",
    "Cadbury Dairy Milk Large Chocolate Block": "Cadbury Dairy Milk Large",
    "Cadbury Dairy Milk Top Deck Chocolate Block": "Cadbury Dairy Milk Top Deck",
    "Cadbury Old Gold Dark 70% Cocoa Chocolate Block": "Cadbury Old Gold Dark",
    "Capsicum Green": "Capsicum Green",
    "Capsicum Yellow": "Capsicum Yellow",
    "Cavendish Bananas": "Cavendish Bananas",
    "Coca-Cola Zero Sugar Soft Drink Bottle": "Coca-Cola Zero",
    "Colman's Ingredients English Mustard": "Colman's Mustard",
    "Continental Classics Cup A Soup Chicken With Lots Of Noodles": "Cup A Soup Chicken",
    "Continental Classics Cup A Soup Creamy Chicken With Croutons": "Cup A Soup Creamy Chicken",
    "Continental Classics Cup A Soup Italian Minestrone With Pasta": "Cup A Soup Minestrone",
    "Dettol Antibacterial Liquid Hand Wash Hand Soap Pump Aloe Vera": "Dettol Hand Wash",
    "Dolmio Extra Bolognese Tomato Pasta Sauce": "Dolmio Bolognese Sauce",
    "Ecostore Dish Liquid Ultrasensitive": "Ecostore Dish Liquid",
    "Essentials Domestic Wipes Roll": "Wipes Roll",
    "Essentials Salted Butter": "Essentials Salted Butter",
    "Essentials White Vinegar": "Essentials White Vinegar",
    "Fresh Broccoli": "Broccoli",
    "Fresh Cauliflower Half": "Cauliflower Half",
    "Fresh Radish Bunch": "Radish",
    "Golden Palm Medjool Dates Punnet": "Medjool Dates",
    "Greek Style Yoghurt 2kg": "Greek Style Yoghurt 2kg",
    "Green Zucchini": "Green Zucchini",
    "Hass Avocado": "Hass Avocado",
    "Hedy's Fresh Quiche Lorraine Chilled Meal": "Hedy's Quiche Lorraine",
    "Helga's Wholemeal Bread With Grains": "Helga's Wholemeal Bread",
    "Hellmann's Real Mayonnaise Squeeze": "Hellmann's Mayo",
    "Kale Fresh Bunch": "Kale",
    "Katoomba Ingredients Red Lentils": "Katoomba Red Lentils",
    "Kinder Chocolate Sharepack": "Kinder Chocolate",
    "KitKat Gold Crush Block": "KitKat Gold Crush",
    "KitKat Milk Chocolate Mini Bars Share Pack": "KitKat Mini Bars",
    "Kiwi Fruit Green": "Kiwi Fruit",
    "Lebanese Cucumbers": "Lebanese Cucumbers",
    "Lotus Biscoff Spread": "Lotus Biscoff Spread",
    "Lurpak Butter Spreadable": "Lurpak Spreadable",
    "Macro Grass Fed Australian Stir-Fry Beef": "Macro Stir-Fry Beef",
    "Macro Natural Sunflower Kernels": "Sunflower Kernels",
    "Macro Organic Natural Pumpkin Kernels": "Pumpkin Kernels",
    "Macro Organic Pasta Sauce Chunky Bolognese": "Macro Bolognese Sauce",
    "Mainland Extra Tasty Cheese Block": "Mainland Tasty Cheese",
    "Maltesers Milk Chocolate Party Gift Box": "Maltesers Gift Box",
    "Manning Valley 12 Extra Large Free Range Eggs": "Manning Valley Eggs 12pk",
    "McKenzie's Dried Veg Pearl Barley": "McKenzie's Pearl Barley",
    "McKenzie's Green Lentil Whole": "McKenzie's Green Lentils",
    "McKenzie's Red Lentils": "McKenzie's Red Lentils",
    "McVitie's Digestives Milk Chocolate": "McVitie's Digestives",
    "McVitie's Hobnobs Milk Chocolate": "McVitie's Hobnobs",
    "Mon Ami French Camembert Cheese": "Mon Ami Camembert",
    "Mutti Tomato Paste Double Concentrate": "Mutti Tomato Paste",
    "Obela Hommus Dip With Garlic Smashed Falafel": "Obela Falafel Hummus",
    "Old El Paso Fajita Spice Mix Mexican Style": "Old El Paso Fajita Mix",
    "Orange Navel": "Orange Navel",
    "Parsnip Fresh": "Parsnip",
    "Philadelphia Original Cream Cheese Block": "Philadelphia Block",
    "Philadelphia Original Cream Cheese Portions Snacks": "Philadelphia Portions",
    "Philadelphia Original Cream Cheese Spread Tub": "Philadelphia Spread",
    "Pringles Sour Cream & Onion Potato Chips": "Pringles Sour Cream",
    "Rexona Men 48hr Deodorant Stick Sport Defence": "Rexona Deodorant",
    "Sam's Pantry Caramel Brownie Low Sugar Protein Bars": "Sam's Caramel Brownie Bar",
    "Sam's Pantry Granola Pink Lady Apple & Cinnamon": "Sam's Granola Apple",
    "Schweppes Lemon Lime Bitters Soft Drink Classic Mixers Bottle": "Schweppes Lemon Lime",
    "Schweppes Orange Mango Natural Mineral Water Bottle": "Schweppes Orange Mango",
    "Snickers Milk Chocolate Party Share Bag": "Snickers Share Bag",
    "Snickers Milk Chocolate Party Share Bag 20 Pieces": "Snickers 20pc Share Bag",
    "Spring Onion Bunch": "Spring Onion",
    "Strawberries Punnet": "Strawberries Punnet",
    "Strike 2 Ply Paper Towel 2 Ply": "Strike Paper Towel",
    "Strike Blue Toilet Cleaner Cistern Blocks": "Strike Cistern Blocks",
    "Strike Paper Towels Embossed 2 Ply": "Strike Embossed Towel",
    "Sweet Potato Gold": "Sweet Potato Gold",
    "The Dutch Company Confectionary 4 Syrup Wafers": "Dutch Co. Syrup Wafers",
    "The Odd Bunch Capsicum Prepacked": "Capsicum (Mixed)",
    "The Odd Bunch Carrots": "Carrots",
    "The Odd Bunch Mandarin Prepacked": "Mandarins",
    "The Odd Bunch Zucchini Prepacked": "Zucchini",
    "Truss Tomatoes": "Truss Tomatoes",
    "Twinings Honeybush, Orange & Mandarin": "Twinings Honeybush Orange",
    "Twinings Orange & Cinnamon Tea Bags Tea": "Twinings Orange Cinnamon",
    "Vanish Napisan Stain Remover Powder": "Vanish Napisan",
    "Vevelle White 2 Ply Toilet Tissue": "Vevelle Toilet Tissue",
    "Weet-Bix Little Kids Breakfast Cereal": "Weet-Bix Kids",
    "White Seedless Grapes Bag Approx. 900g": "White Seedless Grapes",
    "Woolworths 100% Canadian Maple Syrup": "Maple Syrup",
    "Woolworths 12 Extra Large Cage Free Eggs": "Cage Free Eggs 12pk",
    "Woolworths 12 Extra Large Free Range Eggs": "Free Range Eggs 12pk",
    "Woolworths 18 Large Cage Free Eggs": "Cage Free Eggs 18pk",
    "Woolworths 4 Angus Quarter Pound Beef Burgers": "Angus Beef Burgers 4pk",
    "Woolworths Asparagus Green Bunch": "Asparagus",
    "Woolworths BBQ Lamb Kebabs With Mint & Honey": "BBQ Lamb Kebabs",
    "Woolworths Baby Corn Spears": "Baby Corn Spears",
    "Woolworths Baby Leaf Spinach": "Baby Leaf Spinach",
    "Woolworths Basmati Rice": "Basmati Rice",
    "Woolworths Beef & Lamb Meatballs": "Beef & Lamb Meatballs",
    "Woolworths Beef Porterhouse Steak & Butter": "Porterhouse Steak",
    "Woolworths Black Beans": "Black Beans",
    "Woolworths Broccolini Bunch": "Broccolini",
    "Woolworths Butternut Pumpkin Cut": "Butternut Pumpkin",
    "Woolworths Capsicum Green": "Capsicum Green (WW)",
    "Woolworths Celery Heart": "Celery Heart",
    "Woolworths Cherry Tomatoes Punnet": "Cherry Tomatoes",
    "Woolworths Cookie Caramel Bar Slice": "Cookie Caramel Bar",
    "Woolworths Corn Sweet": "Corn Sweet",
    "Woolworths Corn Sweet Kernels": "Corn Sweet Kernels",
    "Woolworths Cos Hearts Lettuce": "Cos Hearts Lettuce",
    "Woolworths Cous Cous": "Cous Cous",
    "Woolworths Dill Fresh Herb": "Dill",
    "Woolworths Dreamy Choc Chip Cookies": "Dreamy Choc Chip Cookies",
    "Woolworths Extra Virgin Olive Oil Spray": "Olive Oil Spray",
    "Woolworths Extra Virgin Spanish Olive Oil": "Spanish Olive Oil",
    "Woolworths Fresh Continental Parsley Bunch": "Parsley",
    "Woolworths Frozen Meat Pies": "Frozen Meat Pies",
    "Woolworths Garlic Heads CLOVE": "Garlic",
    "Woolworths Greek Style Fetta": "Greek Style Fetta",
    "Woolworths Greek Style Yoghurt": "Greek Style Yoghurt",
    "Woolworths Green Asparagus Bunch Green": "Green Asparagus",
    "Woolworths Lamb Mince": "Lamb Mince",
    "Woolworths Mild Salsa": "Mild Salsa",
    "Woolworths Mixed Herbs Dried": "Mixed Herbs Dried",
    "Woolworths Onion Brown Bag": "Brown Onions",
    "Woolworths Pesto Basil": "Basil Pesto",
    "Woolworths Red Onions": "Red Onions",
    "Woolworths Red Onions Bag": "Red Onions Bag",
    "Woolworths Red Washed Potatoes Bag": "Red Washed Potatoes",
    "Woolworths Red Watermelon Cut Quarter": "Watermelon Quarter",
    "Woolworths Rosemary Leaves": "Rosemary Leaves",
    "Woolworths Sour Cream": "Sour Cream",
    "Woolworths Thickened Cream": "Thickened Cream",
    "Woolworths Thyme Leaves": "Thyme Leaves",
    "Woolworths Tuna In Springwater": "Tuna In Springwater",
    "Woolworths Washed Potato Bag": "Washed Potatoes",
    "Woolworths Water Chestnuts Sliced": "Water Chestnuts Sliced",
    "Woolworths Whole Milk Full Cream Milk": "Full Cream Milk",
    "Woolworths Wholegrain Wrap 8Pk": "Wholegrain Wraps 8pk",
    "Yumi's Eggplant Mediterranean Dip": "Yumi's Eggplant Dip",
}


def _shorten(name: str) -> str:
    if name in _NAME_MAP:
        return _NAME_MAP[name]
    for prefix in ('Woolworths ', 'The Odd Bunch ', 'Coles ', 'Fresh ', 'Whole Milk ', 'Continental '):
        if name.startswith(prefix):
            name = name[len(prefix):]
    for suffix in (' With Grains', ' Full Cream', ' Prepacked', ' Bunch'):
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    return name[:26] + '…' if len(name) > 26 else name


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
        lines.append('<b>🟢 Woolworths</b>')
        for name, price, other, tag in ww_items:
            old_str = f'<s>${other:.2f}</s> ' if other else ''
            tag_str = f'<i>WW only</i> · ' if tag == 'ww_only' else ''
            lines.append(f'{_h(name)} · {tag_str}{old_str}<b>${price:.2f}</b>')
        lines.append(f'<i>Total ${ww_total:.2f}</i>')

    if coles_items:
        if lines:
            lines.append('')
        coles_total = sum(p for _, p, _, _ in coles_items)
        lines.append('<b>🔴 Coles</b>')
        for name, price, other, tag in coles_items:
            old_str = f'<s>${other:.2f}</s> ' if other else ''
            tag_str = f'<i>Coles only</i> · ' if tag == 'coles_only' else ''
            lines.append(f'{_h(name)} · {tag_str}{old_str}<b>${price:.2f}</b>')
        lines.append(f'<i>Total ${coles_total:.2f}</i>')

    total_saving = (
        sum(o - p for _, p, o, _ in ww_items if o) +
        sum(o - p for _, p, o, _ in coles_items if o)
    )
    if total_saving > 0.01:
        lines.append(f'\n💰 Split saves <b>${total_saving:.2f}</b>')

    if not_found:
        lines.append(f'\n❓ Not found: {_h(", ".join(not_found))}')

    return '\n'.join(lines)
