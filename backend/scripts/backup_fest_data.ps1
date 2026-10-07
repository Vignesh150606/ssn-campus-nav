# Read-only recovery export using the user's native Supabase CLI login.
# No .env, API keys, admin password hashes or live Render requests.
param(
    [ValidatePattern('^[a-z]{20}$')][string]$ProjectRef,
    [switch]$VerifyOnly,
    [string]$BackupPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$backupRoot = Join-Path $repo 'backups'
$tables = @('event_categories', 'venues', 'events', 'event_images', 'road_segments', 'venue_menus')

function Test-Backup([string]$Directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.format -ne 1 -or $manifest.project_ref -notmatch '^[a-z]{20}$') { throw 'Invalid backup manifest' }
    $expected = @('content.json', 'schedule.json', 'closures.json', 'menus.json', 'posters.json')
    if (@($manifest.files).Count -ne $expected.Count) { throw 'Incomplete backup manifest' }
    foreach ($name in $expected) {
        $entry = @($manifest.files | Where-Object name -eq $name)
        if ($entry.Count -ne 1) { throw "Missing/duplicate file: $name" }
        $file = Join-Path $Directory $name
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry[0].sha256) { throw "Backup hash mismatch: $name" }
        if ((Get-Item -LiteralPath $file).Length -ne $entry[0].bytes) { throw "Backup size mismatch: $name" }
        $json = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        if ($name -eq 'content.json') {
            if ($json.format -ne 1 -or $json.project_ref -ne $manifest.project_ref) { throw 'Invalid content export' }
            foreach ($table in $tables) {
                $property = $json.tables.PSObject.Properties[$table]
                if (-not $property -or $property.Value -isnot [Array]) { throw "Invalid table export: $table" }
            }
            if ($json.tables.PSObject.Properties['admins']) { throw 'This content export must not contain admin credentials' }
        } elseif ($json.schema -ne 1 -or -not $json.PSObject.Properties['data']) { throw "Invalid snapshot: $name" }
    }
    Write-Output 'PASS: recovery files, hashes and content table shapes verified.'
}

if ($VerifyOnly) {
    if (-not $BackupPath) { throw '-VerifyOnly requires -BackupPath' }
    Test-Backup ([IO.Path]::GetFullPath($BackupPath))
    exit 0
}
if (-not $ProjectRef) { throw 'Provide -ProjectRef; existing Supabase CLI login is required.' }
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) { throw 'Supabase CLI unavailable' }
if (Test-Path Env:SUPABASE_ACCESS_TOKEN) { Remove-Item Env:SUPABASE_ACCESS_TOKEN }
$directory = Join-Path $backupRoot ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$queryFile = Join-Path $directory 'read.sql'
$client = $null
try {
    # One statement gives a consistent database snapshot. Includes pending and
    # rejected events for recovery, so this directory is PRIVATE, not deployable.
    $sql = @'
select json_build_object('exported_at', current_timestamp, 'tables', json_build_object(
  'event_categories', coalesce((select json_agg(t order by id) from public.event_categories t), '[]'::json),
  'venues', coalesce((select json_agg(t order by id) from public.venues t), '[]'::json),
  'events', coalesce((select json_agg(t order by id) from public.events t), '[]'::json),
  'event_images', coalesce((select json_agg(t order by id) from public.event_images t), '[]'::json),
  'road_segments', coalesce((select json_agg(t order by id) from public.road_segments t), '[]'::json),
  'venue_menus', coalesce((select json_agg(t order by id) from public.venue_menus t), '[]'::json)
)) as recovery;
'@
    [IO.File]::WriteAllText($queryFile, $sql, [Text.UTF8Encoding]::new($false))
    # Capture privately; stdout can contain unpublished event data and contacts.
    # Windows PowerShell treats benign native stderr ("Initialising login
    # role...") as an ErrorRecord. Check the exit code, not that progress line.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $raw = & supabase db query --linked --project-ref $ProjectRef --file $queryFile --output json 2>$null
    } finally { $ErrorActionPreference = $previousPreference }
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated read-only content export failed' }
    $result = ($raw -join "`n") | ConvertFrom-Json
    $recovery = $result.rows[0].recovery
    if (-not $recovery.tables) { throw 'Content export is empty/invalid' }
    $content = @{ format = 1; project_ref = $ProjectRef; exported_at = $recovery.exported_at; tables = $recovery.tables }
    [IO.File]::WriteAllText((Join-Path $directory 'content.json'), ($content | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    $client = [Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(15)
    $client.MaxResponseContentBufferSize = 2097152
    foreach ($name in @('schedule', 'closures', 'menus', 'posters')) {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "https://$ProjectRef.supabase.co/storage/v1/object/public/snapshots/$name.json")
        $request.Headers.CacheControl = [Net.Http.Headers.CacheControlHeaderValue]::Parse('no-cache')
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try {
                if (-not $response.IsSuccessStatusCode) { throw "Public snapshot $name unavailable: HTTP $([int]$response.StatusCode)" }
                [IO.File]::WriteAllBytes((Join-Path $directory "$name.json"), $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
            } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
    $files = foreach ($name in @('content.json', 'schedule.json', 'closures.json', 'menus.json', 'posters.json')) {
        $file = Join-Path $directory $name
        @{ name = $name; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $manifest = @{ format = 1; project_ref = $ProjectRef; created_at = (Get-Date).ToUniversalTime().ToString('o');
        scope = 'Content recovery only; not a full database, auth or Storage-object backup'; files = @($files) }
    [IO.File]::WriteAllText((Join-Path $directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Test-Backup $directory
    foreach ($table in $tables) { Write-Output "$table records: $(@($recovery.tables.$table).Count)" }
    Write-Output "Private recovery export: $directory"
} finally {
    if ($client) { $client.Dispose() }
    if (Test-Path -LiteralPath $queryFile) { Remove-Item -LiteralPath $queryFile }
    $raw = $null; $result = $null; $recovery = $null
}
