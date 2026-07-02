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

        # Corrupt file must not crash — it starts fresh.
        open(path, "w").write("{ not json")
        scraper._append_scrape_log("manual", 1, [], [])
        log = json.load(open(path))
        assert len(log) == 1 and log[0]["trigger"] == "manual", log

    print("scrape_log_selfcheck: all cases passed")


if __name__ == "__main__":
    _run()
