# All external operations are mocked; this file never starts Node or connects to a database.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../scripts/verify-admin-login.ps1'
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath, [ref]$tokens, [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count) { throw 'Verification script has PowerShell syntax errors.' }

function Read-Host { return 'abcdefghijklmnopqrst' }
function Test-Path { return $global:verifyAdminMockState.scenario -ne 'missing CA' }
function Get-Credential {
    if ($global:verifyAdminMockState.scenario -eq 'cancelled') { return $null }
    if ($global:verifyAdminMockState.scenario -eq 'prompt error') { throw 'PRIVATE-fixture-error' }
    $secure = ConvertTo-SecureString 'PRIVATE-fixture-password-雪' -AsPlainText -Force
    return [pscredential]::new('fixture@example.test', $secure)
}
function node {
    param(
        [string]$e,
        [Parameter(ValueFromPipeline)] [string]$InputObject
    )
    process {
        $global:verifyAdminMockState.nodeCalls++
        if (!$e.Contains('jwt.verify') -or $e.Contains('PRIVATE-fixture-password')) {
            throw 'Unexpected native arguments.'
        }
        $body = $InputObject | ConvertFrom-Json
        if ($body.email -ne 'fixture@example.test' -or
            $body.password -ne 'PRIVATE-fixture-password-雪') {
            throw 'Mock standard input mismatch.'
        }
        if ($env:NODE_TLS_REJECT_UNAUTHORIZED -ne '1' -or
            $env:IM101_EXPECTED_V2_REF -ne 'abcdefghijklmnopqrst') {
            throw 'Temporary environment mismatch.'
        }
        if ($global:verifyAdminMockState.scenario -eq 'native failure') {
            $global:LASTEXITCODE = 1
            'FAIL: mocked verification; details withheld.'
        } else {
            $global:LASTEXITCODE = 0
            'PASS: mocked verification.'
        }
    }
}

$global:verifyAdminMockState = @{ scenario = ''; nodeCalls = 0 }
Set-Location -LiteralPath $PSScriptRoot
foreach ($scenario in @('success', 'native failure', 'cancelled', 'prompt error', 'missing CA')) {
    $global:verifyAdminMockState.scenario = $scenario
    $global:verifyAdminMockState.nodeCalls = 0
    $env:NODE_EXTRA_CA_CERTS = 'fixture-ca-path'
    $env:NODE_TLS_REJECT_UNAUTHORIZED = 'previous-tls-value'
    $env:IM101_EXPECTED_V2_REF = 'previous-reference'
    $previousLocation = (Get-Location).Path
    $previousEncoding = $OutputEncoding
    $previousArguments = $PSNativeCommandArgumentPassing
    $output = (& $scriptPath 6>&1 | Out-String)
    $expectedExit = if ($scenario -eq 'success') { 0 } else { 1 }
    if ($LASTEXITCODE -ne $expectedExit) { throw "Exit code mismatch: $scenario" }
    $expectedCalls = if ($scenario -in @('success', 'native failure')) { 1 } else { 0 }
    if ($global:verifyAdminMockState.nodeCalls -ne $expectedCalls) { throw "Native call mismatch: $scenario" }
    if ($output.Contains('PRIVATE-') -or $output.Contains('fixture@example.test')) {
        throw 'Private fixture leaked to output.'
    }
    if ($env:NODE_EXTRA_CA_CERTS -ne 'fixture-ca-path' -or
        $env:NODE_TLS_REJECT_UNAUTHORIZED -ne 'previous-tls-value' -or
        $env:IM101_EXPECTED_V2_REF -ne 'previous-reference' -or
        (Get-Location).Path -ne $previousLocation -or
        $OutputEncoding -ne $previousEncoding -or
        $PSNativeCommandArgumentPassing -ne $previousArguments) {
        throw "Cleanup mismatch: $scenario"
    }
}
Write-Output 'PASS: mocked PowerShell prompts, stdin, exit codes, redaction, and restoration.'
exit 0
