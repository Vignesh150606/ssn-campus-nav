"""Stdlib-only bootstrap tests; no backend dependencies, credentials or network."""
import ast
import contextlib
import importlib.util
import io
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("publish_snapshots_cli.py")
spec = importlib.util.spec_from_file_location("bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
source = (bootstrap.BACKEND / "data_access.py").read_text(encoding="utf-8")
tree = ast.parse(source)
serializers = "\n\n".join(ast.get_source_segment(source, node) for node in tree.body
                            if isinstance(node, ast.FunctionDef) and node.name in
                            ("_serialize_event", "_segment_row_to_legacy_shape"))
inputs = {
    "version": 123, "updated_at": "2026-10-06T00:00:00Z", "date_from": "2026-10-05", "date_to": "2026-10-20",
    "events": [{"id": "event-1", "name": "Fixture", "location_id": "v1", "contact_info": "PRIVATE",
                "review_notes": "PRIVATE", "created_by": "PRIVATE", "category_id": "c1",
                "event_categories": {"name": "Workshop"}, "venues": {"id": "v1", "name": "Venue", "lat": 12.7, "lng": 80.2},
                "event_images": [{"url": "https://images.invalid/poster.png", "is_poster": True, "sort_order": 0}]}],
    "closures": [{"id": "r1", "name": "Road", "closed": False, "lat_min": 12, "lat_max": 13, "lng_min": 80, "lng_max": 81}],
    "menus": [{"id": "m1", "venue_id": "v1", "date": "2026-10-06", "description": "Menu"}],
}

scratch = bootstrap.BACKEND.parent / "output/local-nav-check"
scratch.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(dir=scratch) as directory:
    backend = Path(directory) / "backend"
    backend.mkdir()
    (backend / "data_access.py").write_text(serializers, encoding="utf-8")
    queries, uploads = [], []

    def run(args, **kwargs):
        if args[1:3] == ["db", "query"]:
            query = Path(args[args.index("--file") + 1]).read_text(encoding="utf-8")
            assert "where e.status='verified'" in query
            assert "'contact_info'" in query and "'review_notes'" in query
            assert "created_by" not in query.split("from public.venue_menus")[0].split("'menus'")[1]
            assert "SUPABASE_ACCESS_TOKEN" not in kwargs["env"]
            queries.append(query)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"rows": [{"snapshot_inputs": inputs}]}))
        if args[1:3] == ["storage", "cp"]:
            uploads.append({"object": args[4].removeprefix("ss:///snapshots/")})
            return SimpleNamespace(returncode=0, stdout="Fixture upload complete")
        assert args[0] == "pwsh", "Test must never run a real upload"
        manifest = json.loads(Path(args[args.index("-ManifestPath") + 1]).read_text())
        uploads.extend(manifest)
        assert all(item["cacheControl"] == "max-age=60" for item in manifest)
        return SimpleNamespace(returncode=0, stdout="Fixture upload complete")

    output = io.StringIO()
    with patch.object(bootstrap, "BACKEND", backend), patch.object(bootstrap.shutil, "which", return_value="supabase"), \
         patch.object(bootstrap.subprocess, "run", side_effect=run), contextlib.redirect_stdout(output):
        bootstrap.publish_with_cli("a" * 20, ["schedule", "closures", "menus", "posters"], dry_run=True)
        assert len(queries) == 1 and not uploads
        assert "PRIVATE" not in output.getvalue()
        folder = backend.parent / "output/local-nav-check/snapshot-bootstrap"
        documents = {name: json.loads((folder / f"{name}.json").read_text()) for name in ("schedule", "closures", "menus", "posters")}
        assert all(doc["schema"] == 1 and doc["version"] == 123 for doc in documents.values())
        assert "PRIVATE" not in json.dumps(documents)
        event = documents["schedule"]["data"][0]
        assert event["category"] == "Workshop" and event["location"]["id"] == "v1"
        assert event["poster_url"] == "https://images.invalid/poster.png"
        assert documents["closures"]["data"][0]["bbox"]["lat_min"] == 12
        assert documents["menus"]["data"]["v1"]["2026-10-06"]["id"] == "m1"
        bootstrap.publish_with_cli("a" * 20, ["closures", "menus"])
        assert [item["object"] for item in uploads] == ["closures.json", "menus.json"]
        try:
            bootstrap.publish_with_cli("invalid", ["schedule"])
            raise AssertionError("Invalid project accepted")
        except ValueError:
            pass
print("PASS: CLI bootstrap dry-run/no writes, public serialization/privacy, menu/closure shape, selected upload manifest and invalid project")
