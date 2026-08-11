"""Self-check: the archived sweep is a PHASE of a run, not a run of its own.

Run: python scripts/pipeline_row_selfcheck.py

Two symptoms of the same bug: the scrape log grew a second 36-item row that read
like a broken scrape, and the progress bar hit 100% then restarted at 0. Both
come from the archived phase failing to recognise the run it belongs to. The
assertions below pin the three things that must agree - the bar's offset, which
items the sweep re-scrapes, and whether its results merge or append.
"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_spec = importlib.util.spec_from_file_location(
    "scraper", os.path.join(os.path.dirname(__file__), "scraper.py"))
scraper = importlib.util.module_from_spec(_spec)
sys.modules["scraper"] = scraper
_spec.loader.exec_module(scraper)

_tmp = tempfile.mkdtemp()
scraper.DATA_DIR = _tmp
LOG = os.path.join(_tmp, "scrape_log.json")


def write_log(entries):
    with open(LOG, "w") as f:
        json.dump(entries, f)


def read_log():
    with open(LOG) as f:
        return json.load(f)


def main_entry(**over):
    e = {
        "date": (datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat(),
        "trigger": "manual", "scraped": 293,
        "ww_missed": [{"item": "A", "reason": "no_match"}],
        "coles_missed": [],
        "ww_attempted": 236, "coles_attempted": 239,
        "archived": 36, "total": 293, "duration_s": 1007.0,
    }
    e.update(over)
    return e


ok = 0

# 1. A recent main run IS this pipeline's head; the bar offsets from its total.
write_log([main_entry()])
assert scraper._pipeline_head() is not None, "a 4-minute-old manual run is the same pipeline"
assert scraper._pipeline_offset() == 293, scraper._pipeline_offset()
ok += 1

# 2. An OLD main run is not. A standalone archived scrape hours later must start
#    its own row and its own bar, exactly as before.
write_log([main_entry(date=(datetime.now(timezone.utc) - timedelta(hours=5)).isoformat())])
assert scraper._pipeline_head() is None, "a 5-hour-old run is not the same pipeline"
assert scraper._pipeline_offset() == 0
ok += 1

# 3. Neither is an archived row, a retry, or a partial - or two sweeps in a row
#    would chain onto each other and the counts would compound.
for bad in ({"trigger": "scrape_archived"}, {"trigger": "retry_misses"}, {"partial": True}):
    write_log([main_entry(**bad)])
    assert scraper._pipeline_head() is None, bad
ok += 1

# 4. THE ONE ROW. The sweep folds into the head instead of appending.
write_log([main_entry()])
scraper._append_scrape_log(
    "scrape_archived", 12,
    [{"item": "Z", "reason": "no_results"}], [{"item": "Y", "reason": "no_match"}],
    ww_attempted=11, coles_attempted=12, archived=12, duration_s=158.0, total=12)
log = read_log()
assert len(log) == 1, f"the sweep must not add a row, got {len(log)}"
row = log[0]
assert row["trigger"] == "manual", "the merged row stays the run it belongs to"
assert row["scraped"] == 293 + 12, row["scraped"]
assert row["ww_attempted"] == 236 + 11 and row["coles_attempted"] == 239 + 12
assert row["archived"] == 36 + 12, row["archived"]
assert abs(row["duration_s"] - (1007.0 + 158.0)) < 0.05, row["duration_s"]
assert [m["item"] for m in row["ww_missed"]] == ["A", "Z"], row["ww_missed"]
assert [m["item"] for m in row["coles_missed"]] == ["Y"], row["coles_missed"]
ok += 1

# 5. The merged row keeps the pipeline's START time. Stamping it with the sweep's
#    finish would sort the run as if it happened when its last phase ended.
started = main_entry()["date"]
write_log([main_entry(date=started)])
scraper._append_scrape_log("scrape_archived", 5, [], [], duration_s=10.0)
assert read_log()[0]["date"] == started
ok += 1

# 6. With no head, the sweep appends normally - a standalone archived run is
#    still a run and must still be recorded.
write_log([main_entry(date=(datetime.now(timezone.utc) - timedelta(hours=9)).isoformat())])
scraper._append_scrape_log("scrape_archived", 36, [], [], archived=36, duration_s=158.0)
log = read_log()
assert len(log) == 2 and log[-1]["trigger"] == "scrape_archived", [e["trigger"] for e in log]
ok += 1

# 7. An empty log is not a pipeline head, and must not throw.
write_log([])
assert scraper._pipeline_head() is None and scraper._pipeline_offset() == 0
ok += 1

print(f"pipeline_row_selfcheck: {ok}/7 OK")
