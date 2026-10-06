"""One-time snapshot bootstrap using an authenticated Supabase CLI.

Standard library only: no .env, API-key export, backend dependency installation
or application imports. Reuses the actual pure event/road serializers; the
existing Render publisher remains responsible for subsequent admin updates.
"""
import ast
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import urlopen

BACKEND = Path(__file__).resolve().parent.parent


def pure_serializer(name):
    """Load only a pure function, never import the credential-backed DB layer."""
    tree = ast.parse((BACKEND / "data_access.py").read_text(encoding="utf-8"))
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
    namespace = {}
    # Only the named, repository-owned function AST executes; never DB output.
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(BACKEND / "data_access.py"), "exec"), namespace)  # noqa: S102
    return namespace[name]


def publish_with_cli(project_ref, names, dry_run=False, api_base=None):
    if not project_ref or not re.fullmatch(r"[a-z]{20}", project_ref):
        raise ValueError("--via-cli requires a valid --project-ref")
    if api_base:
        url = urlparse(api_base)
        if url.scheme != "https" or not url.netloc or url.username or url.password or url.query or url.fragment:
            raise ValueError("--api-base must be a public HTTPS URL without credentials")
    executable = shutil.which("supabase.exe") or shutil.which("supabase.cmd") or shutil.which("supabase")
    if not executable:
        raise RuntimeError("Supabase CLI is not installed")
    environment = os.environ.copy()
    environment.pop("SUPABASE_ACCESS_TOKEN", None)  # use the user's refreshed native login

    def cli(*args):
        completed = subprocess.run([executable, *args], env=environment, capture_output=True, text=True,
                                   cwd=out, encoding="utf-8", timeout=120, check=False)
        if completed.returncode:
            # Do not echo DB rows, CLI debug output, tokens or credentials.
            raise RuntimeError(f"Supabase CLI {args[0]} failed (exit {completed.returncode})")
        return completed.stdout

    sql = """
    select json_build_object(
      'version', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      'updated_at', current_timestamp,
      'events', coalesce((select json_agg(raw order by created_at) from (
        select e.created_at, (to_jsonb(e) - array['contact_info','created_by','reviewed_by','review_notes','reject_reason','submitted_by'])
          || jsonb_build_object(
            'event_categories', case when c.id is null then null else jsonb_build_object('name', c.name) end,
            'venues', case when v.id is null then null else jsonb_build_object('id',v.id,'name',v.name,'lat',v.lat,'lng',v.lng) end,
            'event_images', coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'url',i.url,'is_poster',i.is_poster,'sort_order',i.sort_order)) from public.event_images i where i.event_id=e.id),'[]'::jsonb)
          ) as raw
        from public.events e left join public.event_categories c on c.id=e.category_id
          left join public.venues v on v.id=e.location_id where e.status='verified'
      ) items), '[]'::json),
      'closures', coalesce((select json_agg(r order by id) from public.road_segments r), '[]'::json),
      'menus', coalesce((select json_agg(m) from (select id,venue_id,date,image_url,description,created_at,updated_at
        from public.venue_menus where date between (current_timestamp at time zone 'UTC')::date - 1 and (current_timestamp at time zone 'UTC')::date + 14) m), '[]'::json),
      'date_from', (current_timestamp at time zone 'UTC')::date - 1,
      'date_to', (current_timestamp at time zone 'UTC')::date + 14
    ) as snapshot_inputs;
    """
    serialize_event = pure_serializer("_serialize_event")
    serialize_road = pure_serializer("_segment_row_to_legacy_shape")
    out = BACKEND.parent / "output" / "local-nav-check" / "snapshot-bootstrap"
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out) as temporary:
        query = Path(temporary) / "read.sql"
        query.write_text(sql, encoding="utf-8")
        response = json.loads(cli("db", "query", "--linked", "--project-ref", project_ref,
                                  "--file", str(query), "--output", "json"))
    inputs = response["rows"][0]["snapshot_inputs"]
    events = [serialize_event(row) for row in inputs["events"]]
    for event in events:
        for key in ("contact_info", "created_by", "reviewed_by", "review_notes", "reject_reason", "submitted_by"):
            event.pop(key, None)
    menus = {}
    for row in inputs["menus"]:
        menus.setdefault(row["venue_id"], {})[row["date"][:10]] = row
    datasets = {"schedule": events, "closures": [serialize_road(r) for r in inputs["closures"]],
                "menus": menus, "posters": [{"event_id": e["id"], "poster_url": e.get("poster_url") or "",
                                              "photo_urls": e.get("photo_urls") or []}
                                             for e in events if e.get("poster_url") or e.get("photo_urls")]}
    metadata = {"schedule": {"qr_ids": []}, "menus": {"date_from": inputs["date_from"], "date_to": inputs["date_to"]},
                "closures": {}, "posters": {}}
    # Build/validate every selected JSON before attempting any upload.
    def write(name):
        envelope = {"schema": 1, "version": inputs["version"], "updated_at": inputs["updated_at"],
                    "meta": metadata[name], "data": datasets[name]}
        body = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > 2_097_152:
            raise ValueError(f"{name} exceeds the bucket's 2 MB limit")
        path = out / f"{name}.json"
        path.write_bytes(body)
        return path, len(body)
    files = {name: write(name) for name in names}
    if dry_run:
        for name, (_, size) in files.items():
            print(f"{name}: staged {size} bytes (no upload)")
        return 0
    uploads = []
    if api_base and "schedule" in names:
        for event in events:
            identifier = event["id"]
            if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", identifier):
                continue
            try:
                with urlopen(f"{api_base.rstrip('/')}/api/events/{quote(identifier, safe='')}/qr", timeout=45) as response:
                    image = response.read(2_097_153)
                if len(image) > 2_097_152 or not image.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Invalid QR image")
                path = out / f"qr-{identifier}.png"
                path.write_bytes(image)
                uploads.append({"path": str(path), "object": f"qr/{identifier}.png",
                                "contentType": "image/png", "cacheControl": "max-age=86400"})
                metadata["schedule"]["qr_ids"].append(identifier)
            except Exception:
                print(f"QR unavailable for {identifier}; existing API fallback retained")
        files["schedule"] = write("schedule")
    if os.name == "nt":
        # Bun's CLI Storage transport resets on this Windows network; .NET's
        # normal verified HTTPS path works. Keys stay private inside the child.
        uploads.extend({"path": str(path), "object": f"{name}.json", "contentType": "application/json",
                        "cacheControl": "max-age=60"} for name, (path, _) in files.items())
        with tempfile.TemporaryDirectory(dir=out) as temporary:
            manifest = Path(temporary) / "uploads.json"
            manifest.write_text(json.dumps(uploads), encoding="utf-8")
            result = subprocess.run(["pwsh", "-NoProfile", "-File", str(BACKEND / "scripts" / "upload_snapshots_cli.ps1"),
                                     "-ProjectRef", project_ref, "-ManifestPath", str(manifest)],
                                    cwd=out, env=environment, capture_output=True, text=True, encoding="utf-8",
                                    timeout=max(120, len(uploads) * 35), check=False)
        if result.returncode:
            raise RuntimeError("Windows snapshot upload/check failed; verify CLI login and Storage connectivity/policies")
        print(result.stdout.strip())
    else:
        uploads.extend({"path": str(path), "object": f"{name}.json", "contentType": "application/json",
                        "cacheControl": "max-age=60"} for name, (path, _) in files.items())
        for upload in uploads:
            cli("storage", "cp", Path(upload["path"]).name, f"ss:///snapshots/{upload['object']}", "--linked",
                "--project-ref", project_ref, "--experimental", "--content-type", upload["contentType"],
                "--cache-control", upload["cacheControl"])
            print(f"Published {upload['object']}")
    return 0
