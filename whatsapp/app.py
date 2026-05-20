"""WhatsApp price comparison chatbot.

Receives a shopping list via Twilio WhatsApp, matches each item against
latest.json from GitHub Pages, and replies with which store is cheaper.

Environment variables (set in .env or platform config):
  LATEST_JSON_URL   URL to fetch latest.json (default: GitHub Pages)
  CACHE_TTL_SECONDS How long to cache latest.json (default: 1800)
  FUZZY_THRESHOLD   Min match score 0-100 (default: 55)
  PORT              HTTP port (default: 5000)
  TWILIO_AUTH_TOKEN Set to enable request signature validation (optional)
  TWILIO_ACCOUNT_SID Required only when auth validation is enabled
"""

import os
import re
import time

import requests
from dotenv import load_dotenv
from flask import Flask, abort, request
from thefuzz import fuzz, process
from twilio.twiml.messaging_response import MessagingResponse

load_dotenv()

app = Flask(__name__)

LATEST_JSON_URL = os.getenv(
    "LATEST_JSON_URL",
    "https://jtsenter.github.io/price-comparison/data/latest.json",
)
CACHE_TTL       = int(os.getenv("CACHE_TTL_SECONDS", "1800"))
FUZZY_THRESHOLD = int(os.getenv("FUZZY_THRESHOLD", "55"))

_cache: dict = {"data": None, "fetched_at": 0.0}


def load_items() -> list[dict]:
    now = time.time()
    if _cache["data"] and now - _cache["fetched_at"] < CACHE_TTL:
        return _cache["data"]
    try:
        r = requests.get(LATEST_JSON_URL, timeout=10)
        r.raise_for_status()
        items = [i for i in r.json().get("items", []) if not i.get("not_found")]
        _cache["data"] = items
        _cache["fetched_at"] = now
        print(f"Loaded {len(items)} items from latest.json")
        return items
    except Exception as e:
        print(f"Failed to fetch latest.json: {e}")
        return _cache["data"] or []


def find_item(query: str, items: list[dict]) -> dict | None:
    names = [i["list_item"] for i in items]
    result = process.extractOne(query, names, scorer=fuzz.token_sort_ratio)
    if not result or result[1] < FUZZY_THRESHOLD:
        return None
    return next(i for i in items if i["list_item"] == result[0])


def fmt(price) -> str:
    return f"${price:.2f}" if price is not None else "—"


def parse_items(text: str) -> list[str]:
    parts = re.split(r"[,\n;]|\d+[.)]\s*", text)
    return [p.strip() for p in parts if p.strip() and len(p.strip()) > 1]


def build_reply(queries: list[str], items: list[dict]) -> str:
    ww_lines: list[str]  = []
    co_lines: list[str]  = []
    not_found: list[str] = []
    ww_total = co_total = 0.0

    for q in queries:
        item = find_item(q, items)
        if not item:
            not_found.append(q)
            continue

        ww = item.get("woolworths")
        co = item.get("coles")
        wp = ww.get("price") if ww else None
        cp = co.get("price") if co else None
        label = item["list_item"]
        cheaper = item.get("cheaper_store")  # "woolworths" | "coles" | "equal" | None

        if wp is None and cp is None:
            not_found.append(q)
            continue

        if cheaper == "coles" or (cheaper == "equal" and wp is None) or (cp is not None and wp is None):
            saving = f"  (save {fmt(wp - cp)} vs WW)" if wp is not None and wp != cp else ""
            co_lines.append(f"  • {label} — {fmt(cp)}{saving}")
            co_total += cp
        elif cheaper == "woolworths" or (cheaper == "equal" and cp is None) or (wp is not None and cp is None):
            saving = f"  (save {fmt(cp - wp)} vs Coles)" if cp is not None and wp != cp else ""
            ww_lines.append(f"  • {label} — {fmt(wp)}{saving}")
            ww_total += wp
        else:
            # equal — pick whichever has a price, prefer WW
            ww_lines.append(f"  • {label} — {fmt(wp)} (same at both)")
            ww_total += wp

    lines = ["🛒 *Shopping list comparison*\n"]

    if ww_lines:
        n = len(ww_lines)
        lines.append(f"*Woolworths* ({n} item{'s' if n > 1 else ''}, {fmt(ww_total)}):")
        lines.extend(ww_lines)
        lines.append("")

    if co_lines:
        n = len(co_lines)
        lines.append(f"*Coles* ({n} item{'s' if n > 1 else ''}, {fmt(co_total)}):")
        lines.extend(co_lines)
        lines.append("")

    if ww_lines or co_lines:
        lines.append(f"💰 Total: {fmt(ww_total + co_total)}")

    if not_found:
        lines.append(f"\n❓ Not in my list: {', '.join(not_found)}")

    return "\n".join(lines)


HELP_TEXT = (
    "Send me a shopping list and I'll tell you where to buy each item cheaper.\n\n"
    "Examples:\n"
    "  milk, eggs, bread, tomatoes\n"
    "  1. bananas\n  2. yoghurt\n  3. butter\n\n"
    "I compare prices between Woolworths and Coles based on the latest scraped data."
)


@app.route("/webhook", methods=["POST"])
def webhook():
    # Optional: validate Twilio signature
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    if auth_token:
        from twilio.request_validator import RequestValidator
        validator = RequestValidator(auth_token)
        url = request.url
        params = request.form.to_dict()
        sig = request.headers.get("X-Twilio-Signature", "")
        if not validator.validate(url, params, sig):
            abort(403)

    body = (request.form.get("Body") or "").strip()
    resp = MessagingResponse()

    if not body or body.lower() in ("help", "hi", "hello", "?"):
        resp.message(HELP_TEXT)
        return str(resp)

    queries = parse_items(body)
    if not queries:
        resp.message("I couldn't parse your list. Try: milk, eggs, bread, tomatoes")
        return str(resp)

    db = load_items()
    if not db:
        resp.message("⚠️ Price data unavailable right now. Try again in a minute.")
        return str(resp)

    resp.message(build_reply(queries, db))
    return str(resp)


@app.route("/health")
def health():
    return {"status": "ok", "items_cached": len(_cache["data"] or []), "cache_age_s": int(time.time() - _cache["fetched_at"])}


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
