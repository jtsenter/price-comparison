# PriceWatch — Woolworths vs Coles Price Comparison

## What this project does

A personal grocery price comparison tool. A Python scraper runs on a
self-hosted GitHub Actions runner (Windows), fetches current prices from
Woolworths and Coles via Playwright, and writes JSON to `docs/data/`. A
static GitHub Pages site (`docs/`) reads that JSON and renders a price
table with history bars, multi-key sorting, category filters, and a Hot
Deals page.

## Architecture

```
shopping_list.xlsx              ← source of truth for item list & price history
scripts/
  scraper.py                   ← main entry point; orchestrates Playwright scrape
  matcher.py                   ← fuzzy product matching, per-100g normalisation
  shopping_list.py             ← reads Excel; returns {item: {trip_count, price_history}}
  categories.py                ← keyword-based category guesser
  recheck.py                   ← standalone re-check helper (not wired to workflow)
docs/
  index.html + app.js          ← main comparison table (GitHub Pages)
  hot-deals.html               ← items currently priced below historical average
  style.css                    ← shared styles (both pages)
  data/
    latest.json                ← current prices (written by scraper, read by UI)
    archived_items.json        ← items excluded from normal scrapes
    url_overrides.json         ← pinned product URLs (written by UI → GitHub API)
.github/workflows/scrape.yml   ← runs on schedule (Mon/Thu) + workflow_dispatch
```

## Commands

```bash
# Full scrape (manual trigger)
python scripts/scraper.py manual

# Single-item refresh
python scripts/scraper.py manual "Helga's Bread Traditional Wholemeal 750g"

# Single-item refresh with explicit URLs
python scripts/scraper.py manual "Milk 2L" "https://www.woolworths.com.au/..." ""

# Scrape archived items only
python scripts/scraper.py scrape_archived

# Preview the site locally
cd docs && python -m http.server 8080
```

## Key conventions

**Data flow**
- `shopping_list.xlsx` → `shopping_list.py` → `scraper.py` → `docs/data/latest.json` → `app.js`
- Items appear in the UI only if they have ≥2 purchase trips in the Excel file.
- Priorities (`weekly`/`monthly`/`rare`/`archive`) are stored in **browser localStorage**
  (`pw_priorities_v1`). The scraper never sees them.
- **Archived items** are persisted in `docs/data/archived_items.json` (written via GitHub
  API by the "Scrape Archived" button). The scraper reads this file to skip those items in
  normal runs and to target only them in `scrape_archived` runs.
- **URL overrides** from the edit dialog live in localStorage (`pw_overrides_v1`) AND
  trigger a `workflow_dispatch` with `ww_url`/`coles_url` inputs for an immediate
  single-item re-scrape.

**Product matching**
- `matcher.py` `pick_best_match()` scores candidates by canonical-name similarity + form
  class (FROZEN/COOKED/PROCESSED/FRESH/UNKNOWN) + pack-size ratio.
- Items fetched via a pinned/explicit URL bypass the matcher entirely
  (`_skip_picker_ww/co = True`). Confidence levels: `high` (≥0.82), `medium` (≥0.55),
  `low`, `none`. A `none` match means the item is not found.

**Per-100g pricing**
- Always compute from the product name size first (reliable for pre-packed goods).
- Fall back to the store-scraped cup price only for loose/bulk goods.
- **Never trust Coles `unit_price`** for pack goods — Coles frequently stores the pack
  price as `unit_price` with `unit='1kg'`, giving a wrong per-kg figure.
- `clientPer100()` lives in `utils.js` (single copy, loaded by both pages).

**Multi-key sort**
- `sortKeys` array in `app.js`. Clicking a column **prepends** it as the primary key;
  the previous primary becomes the secondary tiebreaker. No visual badge shown.
- Sort values are **pre-computed** once per render (a `Map` of item → `[val, val, …]`)
  to avoid repeated localStorage reads during the comparison loop.

**Progress during scrape**
- Scraper pushes partial `latest.json` every 5 items via a background thread.
- `scrape_progress: {done, total}` is present in the JSON during a run; absent when done.
- If the workflow is killed, the field stays set. The UI detects this via a 3-minute
  no-change timeout and shows "⚠ Stalled".

## Scraper configuration constants

All tunable values are defined near the top of `scraper.py`:

| Constant              | Default | Purpose                                  |
|-----------------------|---------|------------------------------------------|
| `CONCURRENCY`         | 2       | Parallel page-pairs (don't exceed 3)     |
| `MAX_RESULTS`         | 5       | Search results fetched per store         |
| `PAGE_TIMEOUT_MS`     | 20 000  | `page.goto` timeout                      |
| `COLES_WAIT_MS`       | 1 500   | Post-navigation wait for Coles pages     |
| `COLES_SCROLL_WAIT_MS`| 800     | Post-scroll wait for lazy-loaded tiles   |
| `MAX_PRODUCT_PRICE`   | 80.0    | Upper bound for plausible product prices |
| `SKIP_FRESH_HOURS`    | 12      | Scheduled runs skip items scraped within N hours (manual runs never skip) |

## Areas needing care

- **WW blocking**: Woolworths intermittently blocks GitHub Actions IPs. `search_woolworths`
  returns `[]` silently and existing WW data is carried forward. `_ww_debug_done` logs only
  the first blocked response per run.
- **Git conflicts**: Progress pushes use `git pull --no-rebase -X ours` before pushing. The
  `_push_lock` in `push_progress_bg` skips a new push if the previous thread is still
  running. Workflow timeout is 90 minutes.
- **CONCURRENCY = 2** — applies to Woolworths. Coles requests are additionally
  serialised through a global semaphore (`_COLES_SEM`, one in flight + jitter): Coles
  rate-bans mid-run when hammered — a 2026-07-06 manual run got 14 items then 0 for the
  rest, and the scheduled run 18 min later got 0/208. Each slot uses one WW page + one
  Coles page from pool queues; the `finally` block always returns pages so the gather
  never deadlocks.
- **Persistent browser profile** — the scraper uses `launch_persistent_context` with a
  profile under the service account's `%LOCALAPPDATA%\pricewatch-pw-profile`, so Coles
  bot-check (Incapsula) trust cookies survive across runs. No user-agent override: a
  hardcoded UA that lags the real Chrome build is itself a bot fingerprint.
- **Outside shops (`third_stores.py`) need the SAME launch config as `scraper.py`** —
  real Chrome (`channel="chrome"`) plus `--disable-blink-features=AutomationControlled`.
  It shipped as a bare bundled-Chromium launch and Big W + Kmart 403'd for months while
  WW/Coles sailed through in the same run. The blocker was the `HeadlessChrome` token in
  the default UA; `_undetectable_ua()` DERIVES the installed Chrome's own UA and strips
  it. Derive, never pin — a hardcoded `Chrome/141` against a real Chrome 151 was still
  403'd, which is the same rule as the bullet above, not an exception to it.
  Big W also **rate-limits bursts**: a dozen rapid requests and every Big W URL 403s
  (including ones that just worked), recovering after a few minutes' rest. Entries are
  visited round-robin across shops to spread the load. If you're testing by hand, expect
  403s and wait it out rather than concluding the site is blocked.
  **All five outside shops are reachable** with this config — Chemist Warehouse,
  ALDI, Big W, Kmart and Priceline. Priceline was written off as a "Cloudflare JS
  challenge" too; that was also just the UA. Before recording any shop as blocked,
  re-test it under the CURRENT launch config — every "unscrapable" verdict in this
  project's history has turned out to be the client config, not the site.
- **Scrape-log rates are per-store**: single-store-pinned items deliberately skip the
  other store ("a single-store pin means a single store") and are recorded as neither
  attempted nor missed there — `ww_attempted`/`coles_attempted` in scrape_log.json are
  the denominators, not `scraped`. A pin-skipped store is also NOT carried forward
  (its stale data drops on the next run) — that's how "remove a product from one
  store" works, via the validate page's 🚫 button or clearing a URL in the edit
  dialog. Explicit single-URL refresh dispatches still keep the other store (it
  flows through `existing_item` into the results).
- **Excel-history fallback is suffix-only**: a pinned item missing from the Excel
  borrows history only when an Excel name ENDS with the item name (store-prefix
  variants). A bare substring match once gave "Beef Porterhouse Steak" the
  "…Steak & Butter" receipt history → phantom $100/kg trend points.

## Self-hosted Runner

- **Location:** `C:\actions-runner`
- **Runner name:** `home-pc` (registered to `jtsenter/price-comparison`)
- **Installed as:** Windows service — `actions.runner.jtsenter.price-comparison.home-pc`
- **Starts automatically** on every Windows boot (service StartupType = Automatic)
- **Restart on failure:** configured to restart after 60 s (×2), then 5 min
- **Service executable:** `C:\actions-runner\bin\RunnerService.exe`

```powershell
# Check status
Get-Service -Name "actions.runner.jtsenter.price-comparison.home-pc"

# Stop / start manually
Stop-Service  -Name "actions.runner.jtsenter.price-comparison.home-pc"
Start-Service -Name "actions.runner.jtsenter.price-comparison.home-pc"

# Re-install (run elevated)
powershell -ExecutionPolicy Bypass -File "C:\actions-runner\install-service.ps1"
```

Verify online status: https://github.com/jtsenter/price-comparison/settings/actions/runners

## Commit Rules — CRITICAL
- Never push more than once per task unless explicitly told to
- Accumulate all changes locally, push ONE commit at the end
- If a task has multiple fixes, apply all before committing
- Never do "one commit per fix" unless user explicitly requests it

## Known gaps / work in progress

- `renderPage()` in `app.js` is ~400 lines. Candidates for extraction: `renderBanner()`,
  `renderProgress()`, `renderRows()`.
- `_scrape_single_item()` in `scraper.py` is ~200 lines — could split into fetch + match +
  build phases.
- `find_alternatives()` stores cheaper alternatives in item JSON but nothing renders them.
- `detect_fuzzy_changes()` in `shopping_list.py` is O(n²). Fine up to ~300 items.
- `recheck.py` is not wired into any workflow.
