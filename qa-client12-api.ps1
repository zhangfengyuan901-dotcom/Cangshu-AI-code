# Only an isolated disposable local container; never point this at production.
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:4181'
$qaPassword = [Guid]::NewGuid().ToString('N') + 'Qa!8'
function JsonPost($path, $body, $headers = @{}) {
  Invoke-RestMethod ($base + $path) -Method Post -ContentType 'application/json' -Headers $headers -Body ($body | ConvertTo-Json -Depth 8)
}
$setup = JsonPost '/api/setup' @{ username = 'qa_root'; password = $qaPassword; confirmPassword = $qaPassword }
if (-not $setup.success) { throw 'Isolated QA initialization failed' }
$rootLogin = JsonPost '/api/user/login' @{ username = 'qa_root'; password = $qaPassword }
if (-not $rootLogin.success -or -not $rootLogin.data.access_token) { throw 'QA login failed' }
$rootHeaders = @{ Authorization = 'Bearer ' + $rootLogin.data.access_token; 'New-Api-User' = [string]$rootLogin.data.user.id }
$created = JsonPost '/api/user/' @{ username = 'qa_customer'; password = $qaPassword; role = 1 } $rootHeaders
if (-not $created.success) { throw 'QA customer creation failed' }
$customerLogin = JsonPost '/api/user/login' @{ username = 'qa_customer'; password = $qaPassword }
if (-not $customerLogin.success -or -not $customerLogin.data.access_token) { throw 'QA customer login failed' }
$customerHeaders = @{ Authorization = 'Bearer ' + $customerLogin.data.access_token; 'New-Api-User' = [string]$customerLogin.data.user.id }
$result = [ordered]@{}
foreach ($principal in @('guest', 'customer')) {
  $headers = @{}
  $expected = 401
  if ($principal -eq 'customer') { $headers = $customerHeaders; $expected = 403 }
  foreach ($action in @('', '/sync', '/publish', '/rollback')) {
    $params = @{ Uri = $base + '/api/pikno/catalog/admin' + $action; Headers = $headers; SkipHttpErrorCheck = $true }
    if ($action) { $params.Method = 'Post'; $params.Body = '{}'; $params.ContentType = 'application/json' }
    $denied = Invoke-WebRequest @params
    if ($denied.StatusCode -ne $expected) { throw "QA authorization failed: $principal $action HTTP $($denied.StatusCode)" }
    $result["${principal}:$action"] = [int]$denied.StatusCode
  }
}
$admin = Invoke-RestMethod ($base + '/api/pikno/catalog/admin') -Headers $rootHeaders
if (-not $admin.success -or $admin.data.published) { throw 'Initial QA state unexpected' }
$draft = JsonPost '/api/pikno/catalog/admin/sync' @{} $rootHeaders
if (-not $draft.success -or $draft.data.draft.models.Count -lt 3 -or $draft.data.published) { throw 'Sync did not isolate draft' }
$publicBefore = Invoke-RestMethod ($base + '/api/pikno/catalog')
if ($publicBefore.data.models.Count -ne 0) { throw 'Unpublished draft leaked' }
$conflict = Invoke-WebRequest ($base + '/api/pikno/catalog/admin/publish') -Headers $rootHeaders -Method Post -ContentType 'application/json' -Body '{"revision":"stale"}' -SkipHttpErrorCheck
if ($conflict.StatusCode -ne 409) { throw 'Stale publication accepted' }
$published = JsonPost '/api/pikno/catalog/admin/publish' @{ revision = $draft.data.revision } $rootHeaders
if (-not $published.success -or $published.data.draft) { throw 'Publication failed' }
$public = Invoke-WebRequest ($base + '/api/pikno/catalog')
if ($public.Content -match 'cost_cny|"actor"|"events"') { throw 'Public catalog leaked administrative fields' }
$result.root_sync_publish = $true
$result.published_models = ($public.Content | ConvertFrom-Json).data.models.Count
$result.stale_publish = 409
$result.public_cost_redacted = $true
$result | ConvertTo-Json -Depth 3
