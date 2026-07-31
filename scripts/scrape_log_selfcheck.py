"""Self-check for _append_scrape_log (scrape-miss summary backend) and _miss_reason.

Run: python scripts/scrape_log_selfcheck.py
Asserts the log appends, keeps per-store missed lists, caps at SCRAPE_LOG_MAX, and
that _miss_reason classifies no_results vs no_match vs matched correctly.
Writes to a throwaway temp dir, not the real docs/data.
"""
import json
import os
import tempfile

import scraper


def _run():
    # _miss_reason: the no_results/no_match split the scrape-log page relies on to
    # tell "site is blocking us" apart from "matcher needs tuning".
    assert scraper._miss_reason({"name": "x"}, [{"name": "x"}]) is None
    assert scraper._miss_reason(None, []) == "no_results"
    assert scraper._miss_reason(None, [{"name": "x"}, {"name": "y"}]) == "no_match"

    with tempfile.TemporaryDirectory() as tmp:
        scraper.DATA_DIR = tmp
        path = os.path.join(tmp, "scrape_log.json")

        ww_missed = [{"item": "WW A", "reason": "no_results"}, {"item": "WW B", "reason": "no_match"}]
        co_missed = [{"item": "Coles X", "reason": "no_results"}]
        scraper._append_scrape_log("scheduled", 200, ww_missed, co_missed)
        log = json.load(open(path))
        assert len(log) == 1, log
        assert log[0]["scraped"] == 200
        assert log[0]["ww_missed"] == ww_missed
        assert log[0]["coles_missed"] == co_missed
        assert log[0]["trigger"] == "scheduled"

        # Cap: write well past SCRAPE_LOG_MAX, keep only the newest N, in order.
        for i in range(scraper.SCRAPE_LOG_MAX + 15):
            scraper._append_scrape_log("scheduled", i, [], [])
        log = json.load(open(path))
        assert len(log) == scraper.SCRAPE_LOG_MAX, len(log)
        # Last appended (scraped == MAX+14) must be the final entry.
        assert log[-1]["scraped"] == scraper.SCRAPE_LOG_MAX + 14, log[-1]
        # Oldest kept is dropped-from-front: first entry's `scraped` is the 15th write.
        assert log[0]["scraped"] == 15, log[0]

        # Corrupt file must not crash - it starts fresh.
        open(path, "w").write("{ not json")
        scraper._append_scrape_log("manual", 1, [], [])
        log = json.load(open(path))
        assert len(log) == 1 and log[0]["trigger"] == "manual", log

        # Per-store attempted counts (single-store-pinned items skip the other
        # store - dividing misses by the combined `scraped` count made rates lie).
        scraper._append_scrape_log("scheduled", 250, [], [], ww_attempted=223, coles_attempted=213)
        log = json.load(open(path))
        assert log[-1]["ww_attempted"] == 223 and log[-1]["coles_attempted"] == 213, log[-1]
        # Omitted → keys absent (old-format entries stay valid; UI falls back to `scraped`).
        scraper._append_scrape_log("scheduled", 250, [], [])
        log = json.load(open(path))
        assert "ww_attempted" not in log[-1] and "coles_attempted" not in log[-1], log[-1]

    # should_skip_item: scheduled runs skip items scraped within SKIP_FRESH_HOURS
    # (a scheduled run 18 min after a manual one re-hammered Coles into a rate ban);
    # manual runs never skip; carried-forward items keep an old last_scraped so a
    # failed item is retried next run.
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    fresh = {"last_scraped": (now - timedelta(hours=1)).isoformat()}
    stale = {"last_scraped": (now - timedelta(hours=scraper.SKIP_FRESH_HOURS + 1)).isoformat()}
    assert scraper.should_skip_item(fresh, "scheduled") is True
    assert scraper.should_skip_item(stale, "scheduled") is False
    assert scraper.should_skip_item(fresh, "manual") is False
    assert scraper.should_skip_item(None, "scheduled") is False
    assert scraper.should_skip_item({}, "scheduled") is False
    assert scraper.should_skip_item({"last_scraped": "garbage"}, "scheduled") is False
    # Archived: scheduled runs refresh only when older than ARCHIVED_REFRESH_DAYS.
    arch_fresh = {"archived": True, "last_scraped": (now - timedelta(days=1)).isoformat()}
    arch_stale = {"archived": True, "last_scraped": (now - timedelta(days=scraper.ARCHIVED_REFRESH_DAYS + 1)).isoformat()}
    assert scraper.should_skip_item(arch_fresh, "scheduled") is True
    assert scraper.should_skip_item(arch_stale, "scheduled") is False
    assert scraper.should_skip_item(arch_fresh, "manual") is False
    # retry_misses must never skip. An item missed at ONE store still got a fresh
    # last_scraped from the store that DID match, so the freshness gate would skip
    # the entire retry list and the run would scrape nothing at all.
    assert scraper.should_skip_item(fresh, "retry_misses") is False
    assert scraper.should_skip_item(arch_fresh, "retry_misses") is False

    # _last_run_misses: the exact list a retry_misses dispatch re-scrapes. Union
    # across both stores, deduped, and tolerant of the pre-reason-tracking format
    # where entries were bare strings.
    with tempfile.TemporaryDirectory() as tmp:
        scraper.DATA_DIR = tmp
        path = os.path.join(tmp, "scrape_log.json")
        assert scraper._last_run_misses() == set()          # no file at all
        json.dump([], open(path, "w"))
        assert scraper._last_run_misses() == set()          # empty log
        json.dump([
            {"ww_missed": [{"item": "Old Run"}], "coles_missed": []},
            {"ww_missed": [{"item": "A"}, {"item": "Both"}],
             "coles_missed": [{"item": "B"}, {"item": "Both"}, "Legacy String"]},
        ], open(path, "w"))
        # Only the NEWEST run counts, both stores merge, "Both" appears once.
        assert scraper._last_run_misses() == {"A", "B", "Both", "Legacy String"}
        json.dump([{"trigger": "manual"}], open(path, "w"))
        assert scraper._last_run_misses() == set()          # clean run → nothing to retry

    print("scrape_log_selfcheck: all cases passed")


if __name__ == "__main__":
    _run()
