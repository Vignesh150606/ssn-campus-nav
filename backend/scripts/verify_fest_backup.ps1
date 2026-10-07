# Fixture-only checks: no CLI authentication, database reads or restore writes.
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $repo ('output/local-nav-check/backup-fixture-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$files = @('content.json', 'schedule.json', 'closures.json', 'menus.json', 'posters.json')
try {
    $tables = @{}
    foreach ($table in @('event_categories', 'venues', 'events', 'event_images', 'road_segments', 'venue_menus')) { $tables[$table] = @() }
    $content = @{ format = 1; project_ref = 'abcdefghijklmnopqrst'; tables = $tables }
    [IO.File]::WriteAllText((Join-Path $directory 'content.json'), ($content | ConvertTo-Json -Depth 10), $utf8)
    foreach ($name in @('schedule', 'closures', 'menus', 'posters')) {
        [IO.File]::WriteAllText((Join-Path $directory "$name.json"), '{"schema":1,"data":[]}', $utf8)
    }
    $manifest = @{ format = 1; project_ref = 'abcdefghijklmnopqrst'; files = @(foreach ($name in $files) {
        $file = Join-Path $directory $name
        @{ name = $name; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }) }
    [IO.File]::WriteAllText((Join-Path $directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
    & powershell -NoProfile -File (Join-Path $PSScriptRoot 'backup_fest_data.ps1') -VerifyOnly -BackupPath $directory
    if ($LASTEXITCODE -ne 0) { throw 'Valid fixture failed backup verification' }
    [IO.File]::WriteAllText((Join-Path $directory 'schedule.json'), '{"schema":1,"data":["tampered"]}', $utf8)
    $old = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $null = & powershell -NoProfile -File (Join-Path $PSScriptRoot 'backup_fest_data.ps1') -VerifyOnly -BackupPath $directory 2>$null
    } finally { $ErrorActionPreference = $old }
    if ($LASTEXITCODE -eq 0) { throw 'Tampered fixture incorrectly accepted' }
    Write-Output 'PASS: valid content recovery accepted; tampered snapshot rejected; no database/Render requests.'
} finally {
    foreach ($name in ($files + @('manifest.json'))) {
        $file = Join-Path $directory $name
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    Remove-Item -LiteralPath $directory
}
