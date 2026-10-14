"""Stdlib-only publisher regression checks. No credentials, live DB or uploads."""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import snapshots  # noqa: E402


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 14, tzinfo=timezone.utc).astimezone(tz)


class Query:
    def __init__(self, rows, calls, fail_page=False):
        self.rows, self.calls, self.fail_page = rows, calls, fail_page

    def select(self, columns):
        assert "storage_path" not in columns and "created_by" not in columns
        return self

    def gte(self, column, value):
        assert column == "date" and value == "2026-10-13"
        self.rows = [row for row in self.rows if row["date"] >= value]
        return self

    def order(self, _column):
        return self

    def range(self, start, end):
        self.calls.append((start, end))
        if self.fail_page and start:
            raise RuntimeError("Second page unavailable")
        self.rows = sorted(self.rows, key=lambda row: (row["date"], row["venue_id"], row["id"]))[start:end + 1]
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


calls = []
rows = [{"id": f"menu-{i}", "venue_id": "food-rishabhs",
         "date": (datetime(2026, 10, 13) + timedelta(days=i)).date().isoformat()}
        for i in range(1105)]
client = SimpleNamespace(table=lambda table: Query(rows, calls))
with patch.dict(sys.modules, {"db": SimpleNamespace(get_client=lambda: client)}), patch.object(snapshots, "datetime", FixedDateTime):
    data, meta = snapshots._build_menus()
    assert meta == {"date_from": "2026-10-13", "date_to": "2026-10-28", "future_complete": True}
    assert len(data["food-rishabhs"]) == 1105
    assert data["food-rishabhs"][rows[-1]["date"]]["id"] == "menu-1104"
    assert calls == [(0, 499), (500, 999), (1000, 1499)]
    client.table = lambda table: Query([], [])
    empty, meta = snapshots._build_menus()
    assert empty == {} and meta["future_complete"] is True
    client.table = lambda table: Query(rows, [], fail_page=True)
    try:
        snapshots._build_menus()
    except RuntimeError as error:
        assert str(error) == "Second page unavailable"
    else:
        raise AssertionError("A partial query must not publish a falsely complete snapshot")
print("PASS: all upcoming menus beyond 14 days; 1105-row pagination; public fields; empty snapshot; partial-query failure")
