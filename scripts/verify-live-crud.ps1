# Run manually only after separate approval, in a trusted non-recorded terminal.
$ErrorActionPreference = "Stop"
$exitCode = 1
$credentials = $null
$body = $null
$previousEncoding = $OutputEncoding
$previousArgumentPassing = $PSNativeCommandArgumentPassing
$previousCa = $env:NODE_EXTRA_CA_CERTS
$previousTls = $env:NODE_TLS_REJECT_UNAUTHORIZED
$locationPushed = $false
try {
    if ($PSVersionTable.PSVersion -lt [version]"7.3") { throw "PowerShell 7.3+ required." }
    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw "Interactive terminal required." }
    Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    $locationPushed = $true
    if ([string]::IsNullOrWhiteSpace($env:NODE_EXTRA_CA_CERTS)) {
        $env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
    }
    if (!(Test-Path -LiteralPath $env:NODE_EXTRA_CA_CERTS -PathType Leaf)) { throw "Trusted CA missing." }
    $env:NODE_TLS_REJECT_UNAUTHORIZED = "1"
    $projectRef = Read-Host "Intended V2 project reference from dashboard"
    Write-Host "This creates, updates and deletes three disposable records. Failures stop without automatic cleanup. Use an exclusive test window; review docs/lookup-and-live-crud.md first."
    $approval = Read-Host "After separate approval, type CREATE UPDATE DELETE DISPOSABLE RECORDS IN $projectRef"
    if ($approval -cne "CREATE UPDATE DELETE DISPOSABLE RECORDS IN $projectRef") { throw "Cancelled." }
    $credentials = Get-Credential -Message "Existing administrator email and password (private)"
    if ($null -eq $credentials) { throw "Cancelled." }
    $body = @{
        projectRef = $projectRef
        approval = $approval
        email = $credentials.UserName
        password = $credentials.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    $PSNativeCommandArgumentPassing = "Standard"
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $body | & node scripts/verify-live-crud.js 2>$null
    if ($LASTEXITCODE -eq 0) { $exitCode = 0 }
} catch {
    Write-Host "Live CRUD launcher refused or failed; details withheld. Inspect the private receipt before any retry."
} finally {
    $credentials = $null
    $body = $null
    $OutputEncoding = $previousEncoding
    $PSNativeCommandArgumentPassing = $previousArgumentPassing
    $env:NODE_EXTRA_CA_CERTS = $previousCa
    $env:NODE_TLS_REJECT_UNAUTHORIZED = $previousTls
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
