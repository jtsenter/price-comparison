"""Self-check for _append_scrape_log (scrape-miss summary backend).

Run: python scripts/scrape_log_selfcheck.py
Asserts the log appends, keeps per-store missed lists, and caps at SCRAPE_LOG_MAX.
Writes to a throwaway temp dir, not the real docs/data.
"""
import json
import os
import tempfile

import scraper


def _run():
    with tempfile.TemporaryDirectory() as tmp:
        scraper.DATA_DIR = tmp
        path = os.path.join(tmp, "scrape_log.json")

        scraper._append_scrape_log("scheduled", 200, ["WW A", "WW B"], ["Coles X"])
        log = json.load(open(path))
        assert len(log) == 1, log
        assert log[0]["scraped"] == 200
        assert log[0]["ww_missed"] == ["WW A", "WW B"]
        assert log[0]["coles_missed"] == ["Coles X"]
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
