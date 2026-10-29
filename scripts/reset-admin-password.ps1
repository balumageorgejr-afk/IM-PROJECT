# Operator-only recovery. Run in a trusted, non-recorded PowerShell 7 terminal.
$ErrorActionPreference = 'Stop'
$exitCode = 1
$password = $null
$confirmation = $null
$body = $null
$previousEncoding = $OutputEncoding
$previousCa = $env:NODE_EXTRA_CA_CERTS
$locationPushed = $false
$stage = 'TERMINAL_REQUIREMENTS'
try {
    if ($PSVersionTable.PSVersion -lt [version]'7.3' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        throw 'Interactive PowerShell 7.3+ required.'
    }
    Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    $locationPushed = $true
    $stage = 'CA_PATH_REQUIRED'
    if ([string]::IsNullOrWhiteSpace($env:NODE_EXTRA_CA_CERTS)) {
        $env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
    }
    if (!(Test-Path -LiteralPath $env:NODE_EXTRA_CA_CERTS -PathType Leaf)) { throw 'Missing CA.' }
    $stage = 'PRIVATE_PROMPTS'
    $projectRef = Read-Host 'V2 project reference independently obtained from its Supabase dashboard'
    $email = Read-Host 'Exact existing System Administrator email (case-sensitive; no trimming)'
    $password = Read-Host 'New password (at least 15 characters; at most 72 UTF-8 bytes)' -AsSecureString
    $confirmation = Read-Host 'Confirm new password' -AsSecureString
    $phrase = "RESET PASSWORD $email IN $projectRef"
    Write-Host 'This changes only the existing active System Administrator password in the selected V2 project.'
    $approval = Read-Host "Type exactly $phrase to authorize the database update; anything else cancels"
    $stage = 'APPROVAL_CANCELLED'
    if ($approval -cne $phrase) { throw 'Cancelled.' }
    $stage = 'PRIVATE_INPUT_HANDOFF'
    # Plaintext exists briefly in local memory and the anonymous stdin pipe only.
    $body = @{
        email = $email
        projectRef = $projectRef
        password = [pscredential]::new('unused', $password).GetNetworkCredential().Password
        confirmation = [pscredential]::new('unused', $confirmation).GetNetworkCredential().Password
        approval = $approval
    } | ConvertTo-Json -Compress
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    # Suppress native diagnostics which may include private connection information.
    $stage = 'NATIVE_COMMAND'
    $body | & node (Join-Path $PSScriptRoot 'reset-admin-password.js') 2>$null
    if ($LASTEXITCODE -eq 0) { $exitCode = 0 }
} catch {
    Write-Host "FAIL [WRAPPER/$stage]: recovery cancelled or could not run; details withheld. Verify privately before retrying."
} finally {
    $body = $null
    if ($null -ne $password) { $password.Dispose() }
    if ($null -ne $confirmation) { $confirmation.Dispose() }
    $password = $confirmation = $null
    $OutputEncoding = $previousEncoding
    $env:NODE_EXTRA_CA_CERTS = $previousCa
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
