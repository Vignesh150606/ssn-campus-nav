# One-time Windows bootstrap transport. Never print or persist CLI API keys.
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z]{20}$')][string]$ProjectRef,
    [Parameter(Mandatory)][string]$ManifestPath
)
$ErrorActionPreference = 'Stop'
$client = $null
$keys = $null
$keyOutput = $null
try {
    if (Test-Path Env:SUPABASE_ACCESS_TOKEN) { Remove-Item Env:SUPABASE_ACCESS_TOKEN }
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    # Capture stdout privately. This is the same privileged lookup performed by
    # `supabase storage cp --linked`; no credential file or .env is read here.
    $keyOutput = & supabase projects api-keys --project-ref $ProjectRef --reveal --output json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'CLI authentication failed' }
    $keys = ($keyOutput -join "`n") | ConvertFrom-Json
    $serviceKey = ($keys | Where-Object name -eq 'service_role' | Select-Object -First 1).api_key
    $anonKey = ($keys | Where-Object name -eq 'anon' | Select-Object -First 1).api_key
    if (-not $serviceKey -or -not $anonKey) { throw 'Required project keys unavailable' }
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(30)
    $base = "https://$ProjectRef.supabase.co/storage/v1"
    foreach ($file in $manifest) {
        if ($file.object -notmatch '^(schedule|closures|menus|posters)\.json$|^qr/[A-Za-z0-9._-]{1,120}\.png$') {
            throw 'Invalid snapshot object'
        }
        $body = [IO.File]::ReadAllBytes($file.path)
        if ($body.Length -gt 2097152) { throw 'Object exceeds bucket limit' }
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/object/snapshots/$($file.object)")
        $request.Headers.Add('apikey', $serviceKey)
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $serviceKey)
        $request.Headers.Add('x-upsert', 'true')
        $request.Headers.CacheControl = [System.Net.Http.Headers.CacheControlHeaderValue]::Parse($file.cacheControl)
        $request.Content = [System.Net.Http.ByteArrayContent]::new($body)
        $request.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new($file.contentType)
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            try {
                if (-not $response.IsSuccessStatusCode) { throw "Upload HTTP $([int]$response.StatusCode)" }
                Write-Output "Published $($file.object): $($body.Length) bytes"
            } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
    # Equivalent to the anonymous-write check documented in snapshots_bucket.sql.
    $probe = "__anonymous_write_probe__$([Guid]::NewGuid().ToString('N')).json"
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/object/snapshots/$probe")
    $request.Headers.Add('apikey', $anonKey)
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $anonKey)
    $request.Content = [System.Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json')
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $deniedByRls = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() -match 'row-level security'
        $response.Dispose()
    } finally { $request.Dispose() }
    if ($status -ge 200 -and $status -lt 300) {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Delete, "$base/object/snapshots")
        $request.Headers.Add('apikey', $serviceKey)
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $serviceKey)
        $request.Content = [System.Net.Http.StringContent]::new((@{prefixes=@($probe)} | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json')
        try { $cleanup = $client.SendAsync($request).GetAwaiter().GetResult(); $cleanup.Dispose() }
        finally { $request.Dispose() }
        throw 'Anonymous write unexpectedly succeeded; review Storage policies'
    }
    if ($status -notin @(400,401,403) -or -not $deniedByRls) { throw "Write protection inconclusive: HTTP $status" }
    Write-Output "Anonymous Storage write rejected by RLS: HTTP $status"
} catch {
    # Exception details can contain headers or API response internals.
    [Console]::Error.WriteLine('Snapshot upload/check failed; no credentials have been printed. Check CLI login and Storage connectivity/policies.')
    exit 1
} finally {
    if ($client) { $client.Dispose() }
    $serviceKey = $null; $anonKey = $null; $keys = $null; $keyOutput = $null
}
