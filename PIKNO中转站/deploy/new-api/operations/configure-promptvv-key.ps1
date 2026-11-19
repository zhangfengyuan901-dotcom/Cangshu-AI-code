[CmdletBinding()]
param(
    [switch]$UseSavedKey,
    [switch]$Upload
)
$ErrorActionPreference = 'Stop'
$secretDirectory = Join-Path $env:LOCALAPPDATA 'PIKNO-Deployment-Secrets'
$secretFile = Join-Path $secretDirectory 'promptvv-api-key.dpapi'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')

if (-not (Test-Path -LiteralPath $secretDirectory)) {
    New-Item -ItemType Directory -Path $secretDirectory | Out-Null
}
$directoryInfo = Get-Item -LiteralPath $secretDirectory
if ($directoryInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'SECRET_DIRECTORY_LINK_REJECTED'
}
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($currentSid)
foreach ($sid in @($currentSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
if (-not $UseSavedKey) {
    Set-Acl -LiteralPath $secretDirectory -AclObject $acl
} else {
    $existingAcl = Get-Acl -LiteralPath $secretDirectory
    $allowedSids = @($currentSid.Value, $systemSid.Value)
    foreach ($rule in $existingAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowedSids) {
            throw 'SECRET_DIRECTORY_PERMISSION_REVIEW_REQUIRED'
        }
    }
}

if ($UseSavedKey) {
    if (-not (Test-Path -LiteralPath $secretFile)) { throw 'SAVED_KEY_NOT_FOUND' }
    if ((Get-Item -LiteralPath $secretFile).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'SECRET_FILE_LINK_REJECTED'
    }
    $secureKey = Get-Content -LiteralPath $secretFile -Raw | ConvertTo-SecureString
} else {
    $secureKey = Read-Host 'Paste PromptVV API Key (input is hidden)' -AsSecureString
}
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ($plainKey.Length -lt 16 -or $plainKey.Length -gt 512 -or $plainKey -match '\s' -or
        $plainKey -match "[^!-~]" -or $plainKey.Contains("'") -or $plainKey.Contains('"') -or $plainKey.Contains([char]92)) {
        throw 'API_KEY_FORMAT_INVALID'
    }
    if (-not $UseSavedKey) {
        $encrypted = ConvertFrom-SecureString -SecureString $secureKey
        $temporary = Join-Path $secretDirectory ([Guid]::NewGuid().ToString('N') + '.tmp')
        [IO.File]::WriteAllText($temporary, $encrypted, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $secretFile -Force
        $fileAcl = [System.Security.AccessControl.FileSecurity]::new()
        $fileAcl.SetAccessRuleProtection($true, $false)
        $fileAcl.SetOwner($currentSid)
        foreach ($sid in @($currentSid, $systemSid)) {
            $fileAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
        }
        Set-Acl -LiteralPath $secretFile -AclObject $fileAcl
    }
    if ($Upload) {
        $payload = @{key=$plainKey} | ConvertTo-Json -Compress
        $responseText = $payload | & python (Join-Path $PSScriptRoot 'upload-promptvv-secret.py')
        if ($LASTEXITCODE -ne 0) { throw 'SECRET_UPLOAD_FAILED_SENSITIVE_OUTPUT_WITHHELD' }
        $response = $responseText | ConvertFrom-Json
        if ($response.success -ne $true) { throw 'SECRET_UPLOAD_NOT_CONFIRMED' }
        [pscustomobject]@{saved_encrypted=$true;uploaded=$true;key_configured=$true;activated=$false} | ConvertTo-Json -Compress
    } else {
        Write-Host 'Saved with Windows account encryption. The key was not uploaded.'
    }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plainKey = $null
    $payload = $null
    if ($secureKey) { $secureKey.Dispose() }
}
