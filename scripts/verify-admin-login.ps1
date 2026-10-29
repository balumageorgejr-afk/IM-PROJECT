# Run in a trusted, non-recorded PowerShell 7.3+ terminal.
$ErrorActionPreference = "Stop"
$exitCode = 1
$loginCredentials = $null
$loginBody = $null
$previousEncoding = $OutputEncoding
$previousArgumentPassing = $PSNativeCommandArgumentPassing
$previousCa = $env:NODE_EXTRA_CA_CERTS
$previousTls = $env:NODE_TLS_REJECT_UNAUTHORIZED
$previousRef = $env:IM101_EXPECTED_V2_REF
$locationPushed = $false
try {
    if ($PSVersionTable.PSVersion -lt [version]"7.3") {
        throw "PowerShell 7.3 or newer is required."
    }
    Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
    $locationPushed = $true
    if ([string]::IsNullOrWhiteSpace($env:NODE_EXTRA_CA_CERTS)) {
        $env:NODE_EXTRA_CA_CERTS = "$HOME\Documents\IM101-Backups\supabase-v2-ca.crt"
    }
    if (!(Test-Path -LiteralPath $env:NODE_EXTRA_CA_CERTS -PathType Leaf)) {
        throw "Trusted V2 CA file is missing."
    }
    $env:NODE_TLS_REJECT_UNAUTHORIZED = "1"
    $env:IM101_EXPECTED_V2_REF = Read-Host "V2 project reference from the dashboard (not a credential)"
    $verificationCode = @'
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
require("dotenv").config({ quiet: true });
let stage = "configuration", server, prisma;
const keys = (value, expected) =>
    assert.deepEqual(Object.keys(value).sort(), expected.slice().sort());
function checkUser(user) {
    keys(user, ["userId", "fname", "lname", "email", "role"]);
    keys(user.role, ["roleId", "roleName"]);
    assert.equal(user.role.roleName, "System Administrator");
    assert.ok(Number.isInteger(user.userId) && user.userId > 0);
    assert.ok(Number.isInteger(user.role.roleId) && user.role.roleId > 0);
}
(async () => {
    try {
        const url = new URL(process.env.DATABASE_URL);
        assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
        assert.deepEqual(url.searchParams.getAll("sslmode"), ["verify-full"]);
        assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "1");
        const ref = process.env.IM101_EXPECTED_V2_REF;
        assert.ok(/^[a-z0-9]{20}$/.test(ref || ""));
        const config = new (require("pg").Client)({
            connectionString: process.env.DATABASE_URL,
        }).connectionParameters;
        assert.ok(config.ssl && config.ssl.rejectUnauthorized !== false);
        assert.ok(config.host === `db.${ref}.supabase.co` ||
            (config.host.endsWith(".pooler.supabase.com") &&
             config.user === `postgres.${ref}`));
        process.env.JWT_SECRET = randomBytes(48).toString("hex");
        stage = "credential input";
        let text = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) text += chunk;
        const credentials = JSON.parse(text.replace(/^\uFEFF/, ""));
        text = "";
        stage = "local server startup";
        const app = require("./src/app").createApp();
        server = app.listen(0, "127.0.0.1");
        await new Promise((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        prisma = require("./src/db").getPrisma();
        const base = `http://127.0.0.1:${server.address().port}`;
        stage = "login HTTP 200";
        const login = await fetch(base + "/api/auth/login", {
            method: "POST", redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(credentials), signal: AbortSignal.timeout(30000),
        });
        assert.equal(login.status, 200);
        assert.equal(login.headers.get("cache-control"), "no-store");
        const result = await login.json();
        stage = "login fields and JWT";
        keys(result, ["success", "token", "tokenType", "expiresIn", "user"]);
        assert.equal(result.success, true);
        assert.equal(result.tokenType, "Bearer");
        assert.equal(result.expiresIn, 900);
        checkUser(result.user);
        assert.equal(result.user.email, credentials.email.trim());
        credentials.password = undefined;
        const claims = jwt.verify(result.token, process.env.JWT_SECRET, {
            algorithms: ["HS256"], issuer: "im101-api",
            audience: "im101-client", maxAge: "15m",
        });
        keys(claims, ["sub", "iss", "aud", "iat", "exp"]);
        assert.equal(claims.sub, String(result.user.userId));
        assert.equal(claims.exp - claims.iat, 900);
        stage = "profile HTTP 200";
        const me = await fetch(base + "/api/auth/me", {
            redirect: "error", headers: { Authorization: `Bearer ${result.token}` },
            signal: AbortSignal.timeout(30000),
        });
        assert.equal(me.status, 200);
        assert.equal(me.headers.get("cache-control"), "no-store");
        const profile = await me.json();
        stage = "profile fields and database role";
        keys(profile, ["success", "user"]);
        assert.equal(profile.success, true);
        checkUser(profile.user);
        assert.deepEqual(profile.user, result.user);
        result.token = undefined;
        console.log("PASS: login 200; JWT verified; profile 200; System Administrator; no password/hash fields.");
    } catch {
        console.log(`FAIL: ${stage}; details withheld. Do not share raw responses or credentials.`);
        process.exitCode = 1;
    } finally {
        if (server) {
            try { await new Promise(resolve => server.close(resolve)); }
            catch { console.log("FAIL: server cleanup; details withheld."); process.exitCode = 1; }
        }
        if (prisma) {
            try { await prisma.$disconnect(); }
            catch { console.log("FAIL: database cleanup; details withheld."); process.exitCode = 1; }
        }
        delete process.env.JWT_SECRET;
    }
})().catch(() => { console.log("FAIL: verification cleanup; details withheld."); process.exitCode = 1; });
'@
    $PSNativeCommandArgumentPassing = "Standard"
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $loginCredentials = Get-Credential -Message "Enter the existing administrator email and password privately"
    if ($null -eq $loginCredentials) { throw "Credential entry cancelled." }
    $loginBody = @{
        email = $loginCredentials.UserName
        password = $loginCredentials.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    # Withhold native diagnostics, which may contain private configuration.
    $loginBody | & node -e $verificationCode 2>$null
    if ($LASTEXITCODE -eq 0) { $exitCode = 0 }
    if ($LASTEXITCODE -ne 0) { Write-Host "Verification did not pass. Stop and review the reported stage." }
} catch {
    Write-Host "Verification could not run; details withheld. Do not print exception details."
} finally {
    $loginBody = $null
    $loginCredentials = $null
    $verificationCode = $null
    $OutputEncoding = $previousEncoding
    $PSNativeCommandArgumentPassing = $previousArgumentPassing
    $env:NODE_EXTRA_CA_CERTS = $previousCa
    $env:NODE_TLS_REJECT_UNAUTHORIZED = $previousTls
    $env:IM101_EXPECTED_V2_REF = $previousRef
    if ($locationPushed) { Pop-Location }
}
exit $exitCode
