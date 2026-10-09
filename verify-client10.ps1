$ErrorActionPreference = 'Stop'
$result = [ordered]@{}
$statusResponse = Invoke-RestMethod 'https://www.piknoai.com/api/status'
if ($statusResponse.data.version -ne 'v1.0.0-rc.41-pikno.10') { throw 'Unexpected public version' }
if ($statusResponse.data.quota_display_type -ne 'CNY') { throw 'Currency changed' }
$result.version = $statusResponse.data.version
$result.currency = $statusResponse.data.quota_display_type
$guide = Invoke-WebRequest 'https://www.piknoai.com/developer-guide.md'
if (-not $guide.Content.StartsWith('# PIKNO') -or -not $guide.Content.Contains('/v1/media/uploads')) { throw 'Public guide missing' }
$result.api_guide = [int]$guide.StatusCode
$page = Invoke-WebRequest 'https://www.piknoai.com/developer'
if (-not $page.Content.Contains('PIKNO')) { throw 'Guide page missing' }
$result.api_guide_page = [int]$page.StatusCode
foreach ($path in @('/api/channel/', '/api/user/topup/info')) {
    $response = Invoke-WebRequest ('https://www.piknoai.com' + $path) -SkipHttpErrorCheck
    if ($response.StatusCode -ne 401) { throw "Unexpected unauthenticated response: $path $($response.StatusCode)" }
    $result["unauthenticated:$path"] = [int]$response.StatusCode
}
foreach ($path in @('/v1/media/uploads', '/v1/images/generations', '/media/v1/packy')) {
    $response = Invoke-WebRequest ('https://www.piknoai.com' + $path) -Method Post -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
    if ($response.StatusCode -ne 401) { throw "Unexpected unauthenticated response: $path $($response.StatusCode)" }
    $result["unauthenticated:$path"] = [int]$response.StatusCode
}
$result.no_payments_or_generations = $true
$result | ConvertTo-Json
