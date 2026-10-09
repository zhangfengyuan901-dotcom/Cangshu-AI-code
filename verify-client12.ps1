$ErrorActionPreference = 'Stop'
$result = [ordered]@{}
$status = Invoke-RestMethod 'https://www.piknoai.com/api/status'
if ($status.data.version -ne 'v1.0.0-rc.41-pikno.12' -or $status.data.quota_display_type -ne 'CNY') { throw 'Version or currency changed unexpectedly' }
$result.version = $status.data.version
$result.currency = $status.data.quota_display_type
$response = Invoke-WebRequest 'https://www.piknoai.com/api/pikno/catalog'
$catalog = $response.Content | ConvertFrom-Json
if (-not $catalog.success -or @($catalog.data.models).Count -ne 43) { throw 'Published catalog incomplete' }
if ($response.Content -match 'cost_cny|"actor"|"events"|"draft"') { throw 'Administrative data leaked' }
$result.catalog_count = @($catalog.data.models).Count
$result.catalog_revision = $catalog.data.revision
$result.catalog_cache_control = $response.Headers['Cache-Control']
$result.providers = @($catalog.data.models | Group-Object provider | ForEach-Object { @{ provider = $_.Name; count = $_.Count } })
$pending = @($catalog.data.models | Where-Object price_issue)
if ($pending.Count -ne 1 -or $pending[0].id -ne 'canseedream/video/nanguar' -or $pending[0].prices.Count -ne 0) { throw 'Ambiguous pricing not isolated' }
$result.pricing_review = @($pending.id)
$flare = $catalog.data.models | Where-Object id -eq 'gpt-image-2.5-flare'
if ($flare.prices[0].retail_cny -ne 0.1 -or $flare.max_images -ne 5) { throw 'Flare reference changed' }
$pricing = Invoke-RestMethod 'https://www.piknoai.com/api/pricing'
if (-not $pricing.success -or @($pricing.data).Count -ne 0) { throw 'Callable catalog unexpectedly changed' }
$result.callable_models = @($pricing.data).Count
foreach ($path in @('/api/pikno/catalog/admin', '/api/channel/', '/api/user/topup/info')) {
  $denied = Invoke-WebRequest ('https://www.piknoai.com' + $path) -SkipHttpErrorCheck
  if ($denied.StatusCode -ne 401) { throw "Unauthenticated GET unexpectedly allowed: $path" }
  $result["unauthenticated:$path"] = [int]$denied.StatusCode
}
foreach ($path in @('/api/pikno/catalog/admin/sync', '/api/pikno/catalog/admin/publish', '/api/pikno/catalog/admin/rollback', '/v1/media/uploads', '/v1/images/generations', '/media/v1/packy')) {
  $denied = Invoke-WebRequest ('https://www.piknoai.com' + $path) -Method Post -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
  if ($denied.StatusCode -ne 401) { throw "Unauthenticated POST unexpectedly allowed: $path" }
  $result["unauthenticated:$path"] = [int]$denied.StatusCode
}
$guide = Invoke-WebRequest 'https://www.piknoai.com/developer-guide.md'
if (-not $guide.Content.StartsWith('# PIKNO') -or -not $guide.Content.Contains('/v1/media/uploads')) { throw 'R2 guide missing' }
$result.r2_guide = [int]$guide.StatusCode
$result.no_payments_or_generations = $true
$result | ConvertTo-Json -Depth 5
