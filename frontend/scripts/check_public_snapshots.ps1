# Public, read-only Storage check; never contacts Render or uses credentials.
param(
    [Parameter(Mandatory)][string]$SnapshotBase,
    [string]$ExpectEvent, [string]$AbsentEvent, [string]$ExpectName,
    [string]$ExpectClosed, [string]$ExpectOpen
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$uri = [Uri]$SnapshotBase
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
    $uri.AbsolutePath -notmatch '^/storage/v1/object/public/[^/]+/?$') { throw 'Use a credential-free public HTTPS Storage bucket URL' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$directory = Join-Path $repo ('output/local-nav-check/public-check-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($directory) | Out-Null
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(8)
$client.MaxResponseContentBufferSize = 2000000
try {
    foreach ($name in @('schedule', 'closures', 'menus', 'posters')) {
        $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "$($SnapshotBase.TrimEnd('/'))/$name.json")
        $request.Headers.CacheControl = [Net.Http.Headers.CacheControlHeaderValue]::Parse('no-cache')
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try {
                if (-not $response.IsSuccessStatusCode) { throw "$name unavailable: HTTP $([int]$response.StatusCode)" }
                [IO.File]::WriteAllBytes((Join-Path $directory "$name.json"), $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
                $headers = @{}
                foreach ($header in $response.Headers) { $headers[$header.Key] = ($header.Value -join ', ') }
                [IO.File]::WriteAllText((Join-Path $directory "$name.headers.json"), ($headers | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
            } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
    $arguments = @((Join-Path $PSScriptRoot 'check_public_snapshots.mjs'), $SnapshotBase, '--from-dir', $directory)
    foreach ($pair in @(@('--expect-event', $ExpectEvent), @('--absent-event', $AbsentEvent), @('--expect-name', $ExpectName), @('--expect-closed', $ExpectClosed), @('--expect-open', $ExpectOpen))) {
        if ($pair[1]) { $arguments += @($pair[0], $pair[1]) }
    }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Public content check failed' }
} finally {
    $client.Dispose()
    # Only remove the exact files created by this invocation; no recursive delete.
    foreach ($name in @('schedule', 'closures', 'menus', 'posters')) {
        foreach ($extension in @('json', 'headers.json')) {
            $file = Join-Path $directory "$name.$extension"
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
    }
    Remove-Item -LiteralPath $directory
}
