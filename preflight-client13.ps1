# Read-only checks. No generation, configuration writes, or credential output.
$ErrorActionPreference = 'Stop'
$privatePath = Join-Path $PSScriptRoot 'private'
$upstreams = Get-Content (Join-Path $privatePath 'upstreams.json') -Raw | ConvertFrom-Json
$sanbao = Get-Content (Join-Path $privatePath 'sanbao-release-key.json') -Raw | ConvertFrom-Json
$packy = Get-Content (Join-Path $privatePath 'packy.json') -Raw | ConvertFrom-Json
$canseeJournal = Get-Content (Join-Path $privatePath 'release-probe-20261008/canseedream.json') -Raw | ConvertFrom-Json
$admin = Get-Content (Join-Path $privatePath 'admin-session.json') -Raw | ConvertFrom-Json
$results = [ordered]@{ checked_at = [DateTime]::UtcNow.ToString('o'); paid_requests = 0 }
function Probe($url, $key, $extraHeaders = @{}) {
  if ([string]::IsNullOrWhiteSpace($key)) { return @{ http = 0; available = $false } }
  $headers = @{ Authorization = 'Bearer ' + $key }
  foreach ($name in $extraHeaders.Keys) { $headers[$name] = $extraHeaders[$name] }
  try {
    $response = Invoke-WebRequest -Uri $url -Headers $headers -Method Get -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 25
    $body = $null
    try { $body = $response.Content | ConvertFrom-Json } catch { }
    return @{ http = [int]$response.StatusCode; body = $body }
  } catch { return @{ http = 0; error = 'Connection failed' } }
}
$probe = Probe 'https://sanbaobeauty.com/openapi/v1/me' $sanbao.apiKey
$results.sanbao = @{ credential_present = [bool]$sanbao.apiKey; http = $probe.http; credits = $probe.body.user.credits }
if ($packy.baseUrl -ne 'https://cf.api.fan') { throw 'Unexpected Packy endpoint; credential not sent' }
$probe = Probe 'https://cf.api.fan/v1/models' $packy.apiKey
$results.packy = @{ credential_present = [bool]$packy.apiKey; http = $probe.http; flare_listed = [bool]($probe.body.data | Where-Object id -eq 'gpt-image-2.5-flare') }
if (-not $canseeJournal.taskId) { throw 'No existing CanSeeDream task to query safely' }
$probe = Probe ('https://see.ximeiedu.org/api/v3/contents/generations/tasks/' + [Uri]::EscapeDataString($canseeJournal.taskId)) $upstreams.canseedream.videoApiKey
$results.canseedream = @{ credential_present = [bool]$upstreams.canseedream.videoApiKey; http = $probe.http; previous_task_status = $probe.body.status }
$probe = Probe 'https://www.piknoai.com/api/user/self' $admin.accessToken @{ 'New-Api-User' = [string]$admin.userId }
$results.pikno_admin_session = @{ http = $probe.http; authenticated = ($probe.http -eq 200 -and $probe.body.success -eq $true) }
$results | ConvertTo-Json -Depth 5
