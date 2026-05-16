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
    "Fruit": [
        "banana", "apple", "mango", "strawberr", "blueberr", "raspberr",
        "avocado", "cherry", "cherries", "grape", "mandarin", "orange", "lemon",
        "lime", "kiwi", "passionfruit", "plum", "pomegranate", "watermelon",
        "date", "medjool",
    ],
    "Vegetables": [
        "broccoli", "cauliflower", "capsicum", "tomato", "cucumber", "zucchini",
        "mushroom", "onion", "carrot", "spinach", "kale", "asparagus", "celery",
        "pumpkin", "potato", "sweet potato", "corn", "beans", "lettuce", "cabbage",
        "radish", "eggplant", "broccolini", "spring onion", "eschallot", "beetroot",
    ],
    "Bread & Bakery": [
        "bread", "wrap", "pizza base", "crispbread", "sourdough", "grain", "helga",
        "salada",
    ],
    "Pantry": [
        "pasta", "rice", "flour", "sugar", "oil", "olive oil", "sauce", "tomato paste",
        "lentil", "barley", "chickpea", "oat", "granola", "baked beans", "tuna",
        "coconut", "honey", "maple syrup", "mustard", "mayonnaise", "pesto", "salsa",
        "vinegar", "breadcrumbs", "stock cube", "couscous", "black bean", "cous cous",
    ],
    "Snacks & Confectionery": [
        "chocolate", "chips", "biscuit", "cookie", "protein bar", "muesli bar",
        "wafer", "pringles", "snicker", "kitkat", "maltesers", "cadbury", "kinder",
        "reese", "twisties", "chewing gum", "biscoff", "digestive", "hobnob",
        "balconi", "crinkle", "dutch company",
    ],
    "Drinks": [
        "water", "coca-cola", "schweppes", "juice", "coffee", "tea", "wine",
        "mineral water", "lemon lime", "sauvignon blanc",
    ],
    "Frozen": [
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
        "trainer cup", "little one",
    ],
    "Health & Beauty": [
        "toothbrush", "hand wash", "hand soap", "dettol", "palmolive",
    ],
    "Spreads & Dips": [
        "peanut butter", "biscoff", "hommus", "hummus", "cream cheese", "philadelphia",
        "eggplant dip", "beetroot hommus", "obela", "wilma",
    ],
    "Nuts & Seeds": [
        "walnut", "macadamia", "sunflower kernel", "pumpkin kernel", "almond", "nut",
    ],
    "Spices & Herbs": [
        "paprika", "cinnamon", "pepper", "garlic powder", "rosemary", "thyme",
        "turmeric", "mixed herbs", "dill", "parsley", "citric acid", "bicarbonate",
        "hoyt",
    ],
}


def guess_category(item_name: str) -> str:
    name_lower = item_name.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in name_lower:
                return category
    return "Other"
