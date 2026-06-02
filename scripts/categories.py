CATEGORY_KEYWORDS = {
    "Dairy & Eggs": [
        "milk", "yoghurt", "yogurt", "cheese", "cream", "butter", "fetta", "feta",
        "egg", "eggs", "creme fraiche", "mozzarella", "camembert", "stilton",
        "cheddar", "parmesan", "thickened cream", "sour cream",
    ],
    "Meat & Seafood": [
        "chicken", "beef", "lamb", "pork", "salmon", "turkey", "fish", "basa",
        "mince", "steak", "bacon", "kebab", "burger", "meatball", "fillet",
        "drumstick", "cutlet", "roast", "deli", "pepperoni", "scotch fillet",
        "porterhouse", "eye fillet", "chuck", "midloin",
    ],
    "Fruit & Veg": [
        "banana", "apple", "mango", "strawberr", "blueberr", "raspberr",
        "avocado", "cherry", "cherries", "grape", "mandarin", "orange", "lemon",
        "lime", "kiwi", "passionfruit", "plum", "pomegranate", "watermelon",
        "date", "medjool",
        "broccoli", "cauliflower", "capsicum", "tomato", "cucumber", "zucchini",
        "mushroom", "onion", "carrot", "spinach", "kale", "asparagus", "celery",
        "pumpkin", "potato", "sweet potato", "corn", "beans", "lettuce", "cabbage",
        "radish", "eggplant", "broccolini", "spring onion", "eschallot", "beetroot",
    ],
    "Bakery": [
        "bread", "wrap", "pizza base", "crispbread", "sourdough", "grain", "helga",
        "salada", "roll", "bun",
    ],
    "Pantry": [
        "pasta", "rice", "flour", "sugar", "oil", "olive oil", "sauce", "tomato paste",
        "lentil", "barley", "chickpea", "oat", "granola", "baked beans", "tuna",
        "coconut", "honey", "maple syrup", "mustard", "mayonnaise", "pesto", "salsa",
        "vinegar", "breadcrumbs", "stock cube", "couscous", "black bean", "cous cous",
        "paprika", "cinnamon", "pepper", "garlic powder", "rosemary", "thyme",
        "turmeric", "mixed herbs", "dill", "parsley", "citric acid", "bicarbonate",
        "hoyt", "peanut butter", "biscoff", "hommus", "hummus", "cream cheese",
        "philadelphia", "eggplant dip", "beetroot hommus", "obela", "wilma",
        "walnut", "macadamia", "sunflower kernel", "pumpkin kernel", "almond", "nut",
    ],
    "Sweets": [
        "chocolate", "chips", "biscuit", "cookie", "protein bar", "muesli bar",
        "wafer", "pringles", "snicker", "kitkat", "maltesers", "cadbury", "kinder",
        "reese", "twisties", "chewing gum", "digestive", "hobnob",
        "balconi", "crinkle", "dutch company",
    ],
    "Drinks & Alcohol": [
        "water", "coca-cola", "schweppes", "juice", "coffee", "tea", "wine",
        "mineral water", "lemon lime", "sauvignon blanc", "beer", "cider",
        "kombucha", "energy drink",
    ],
    "Frozen Foods": [
        "frozen", "ice cream", "meat pies", "pizza", "ben & jerry", "bulla crunch",
        "ristorante",
    ],
    "Household": [
        "toilet tissue", "toilet paper", "paper towel", "wipes", "cleaner",
        "dishwashing", "laundry", "garbage bag", "kitchen tidy", "aluminium foil",
        "sandwich bag", "sponge", "gloves", "paper cups", "resealable", "cistern",
        "ecostore", "vanish", "napisan", "shine dishwash", "ajax", "strike",
    ],
    "Baby": [
        "nappies", "formula", "baby food", "rafferty", "mum-mum", "aptamil",
        "trainer cup", "little one", "munchkin",
    ],
    "Personal Care": [
        "toothbrush", "hand wash", "hand soap", "dettol", "palmolive", "toothpaste",
        "shampoo", "conditioner", "deodorant", "sunscreen",
    ],
    "Ready Meals": [
        "meal kit", "ready meal", "instant noodle", "cup a soup", "continental cup",
        "frozen meal", "microwave meal",
    ],
}


def guess_category(item_name: str) -> str:
    name_lower = item_name.lower()
    best_cat, best_score, best_len = "Other", 0, 0
    for category, keywords in CATEGORY_KEYWORDS.items():
        matches = [kw for kw in keywords if kw in name_lower]
        if not matches:
            continue
        score = len(matches)
        longest = max(len(kw) for kw in matches)
        if score > best_score or (score == best_score and longest > best_len):
            best_cat, best_score, best_len = category, score, longest
    return best_cat
