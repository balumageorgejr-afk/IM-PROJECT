# Mock-only: never starts Node, reads configuration, or connects to a database.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../scripts/reset-admin-password.ps1'
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count) { throw 'Recovery script has PowerShell syntax errors.' }
$source = Get-Content -LiteralPath $scriptPath -Raw
$scriptDirectory = (Split-Path -Parent (Resolve-Path -LiteralPath $scriptPath).Path).Replace("'", "''")
$source = $source.Replace('$PSScriptRoot', "'$scriptDirectory'")
# Test process has redirected handles. Remove only that terminal guard in the
# in-memory test copy, never the production script, and capture its exit code.
$source = $source.Replace(' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected', '')
$source = $source.Replace('exit $exitCode', '$global:recoveryMock.exitCode = $exitCode')
$code = [scriptblock]::Create($source)
function Test-Path { return $global:recoveryMock.scenario -ne 'missing CA' }
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if ($global:recoveryMock.scenario -eq 'prompt error') { throw 'PRIVATE-error' }
    if ($Prompt.StartsWith('V2 project')) { return 'abcdefghijklmnopqrst' }
    if ($Prompt.StartsWith('Exact existing')) { return 'fixture@example.test' }
    if ($Prompt.StartsWith('Type exactly')) {
        if ($global:recoveryMock.scenario -eq 'cancel') { return 'no' }
        return 'RESET PASSWORD fixture@example.test IN abcdefghijklmnopqrst'
    }
    if (!$AsSecureString) { throw 'Password was not requested privately.' }
    $global:recoveryMock.securePrompts++
    return ConvertTo-SecureString 'PRIVATE-recovery-password-雪' -AsPlainText -Force
}
function node {
    param([string]$Path, [Parameter(ValueFromPipeline)] [string]$InputObject)
    process {
        $global:recoveryMock.nodeCalls++
        if (!$Path.EndsWith('reset-admin-password.js') -or $Path.Contains('PRIVATE-')) { throw 'Unexpected arguments.' }
        $body = $InputObject | ConvertFrom-Json
        if ($body.email -ne 'fixture@example.test' -or
            $body.password -cne 'PRIVATE-recovery-password-雪' -or
            $body.confirmation -cne $body.password -or
            $body.projectRef -ne 'abcdefghijklmnopqrst' -or
            $body.approval -cne 'RESET PASSWORD fixture@example.test IN abcdefghijklmnopqrst' -or
            $OutputEncoding.WebName -ne 'utf-8') { throw 'Private stdin contract failed.' }
        $global:LASTEXITCODE = if ($global:recoveryMock.scenario -eq 'native failure') { 1 } else { 0 }
        'Mock native status; no database used.'
    }
}
foreach ($scenario in @('success', 'cancel', 'missing CA', 'prompt error', 'native failure')) {
    $global:recoveryMock = @{ scenario = $scenario; nodeCalls = 0; securePrompts = 0; exitCode = -1 }
    $env:NODE_EXTRA_CA_CERTS = 'fixture-ca-path'
    $beforeLocation = (Get-Location).Path
    $beforeEncoding = $OutputEncoding
    $output = (& $code 6>&1 | Out-String)
    $expectedCalls = if ($scenario -in @('success', 'native failure')) { 1 } else { 0 }
    $expectedExit = if ($scenario -eq 'success') { 0 } else { 1 }
    if ($global:recoveryMock.nodeCalls -ne $expectedCalls -or $global:recoveryMock.exitCode -ne $expectedExit) { throw "Unexpected execution: $scenario" }
    if ($scenario -eq 'success' -and $global:recoveryMock.securePrompts -ne 2) { throw 'Both passwords must be private.' }
    $expectedStage = switch ($scenario) {
        'cancel' { 'WRAPPER/APPROVAL_CANCELLED' }
        'missing CA' { 'WRAPPER/CA_PATH_REQUIRED' }
        'prompt error' { 'WRAPPER/PRIVATE_PROMPTS' }
        default { $null }
    }
    if ($null -ne $expectedStage -and !$output.Contains($expectedStage)) { throw 'Sanitized wrapper stage missing.' }
    if ($output.Contains('PRIVATE-')) { throw 'Private fixture leaked.' }
    if ($env:NODE_EXTRA_CA_CERTS -ne 'fixture-ca-path' -or (Get-Location).Path -ne $beforeLocation -or $OutputEncoding -ne $beforeEncoding) { throw 'Restoration failed.' }
}
Write-Output 'PASS: mocked recovery private prompts, approval, stdin, failure and cleanup.'
exit 0
