const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const { EventEmitter } = require("node:events");
const jwt = require("jsonwebtoken");
const { spawnSync } = require("node:child_process");

const script = fs.readFileSync("scripts/verify-admin-login.ps1", "utf8");
const code = script.match(/\$verificationCode = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const ref = "abcdefghijklmnopqrst";
const password = "PRIVATE-fixture-password-雪";
const privateError = "PRIVATE-raw-database-error";

test("PowerShell wrapper with mocked prompts and Node", (t) => {
    const executable = process.env.VERIFY_ADMIN_TEST_PWSH || "pwsh";
    const version = spawnSync(
        executable,
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
        { encoding: "utf8" },
    );
    if (version.error?.code === "ENOENT") {
        t.skip(
            "PowerShell 7 not available; set VERIFY_ADMIN_TEST_PWSH to run wrapper mocks.",
        );
        return;
    }
    assert.equal(version.status, 0);
    const result = spawnSync(
        executable,
        ["-NoProfile", "-File", "tests/verify-admin-login.mock.ps1"],
        { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: mocked PowerShell/);
});

// No real environment, dotenv, database, server sockets, or HTTP requests.
async function verify(options = {}) {
    const output = [];
    const calls = { requests: [], closes: 0, disconnects: 0, starts: 0 };
    const processMock = {
        env: {
            DATABASE_URL: `postgresql://postgres:fixture@db.${ref}.supabase.co/postgres?sslmode=verify-full`,
            NODE_TLS_REJECT_UNAUTHORIZED: "1",
            IM101_EXPECTED_V2_REF: ref,
            ...options.env,
        },
        stdin: Readable.from([
            options.input ??
                JSON.stringify({ email: "admin@example.test", password }),
        ]),
    };
    const user = {
        userId: 7,
        fname: "Fixture",
        lname: "Administrator",
        email: "admin@example.test",
        role: { roleId: 1, roleName: "System Administrator" },
    };
    const server = new EventEmitter();
    server.address = () => ({ port: 12345 });
    server.close = (done) => {
        calls.closes++;
        if (options.serverCleanupFailure) throw new Error(privateError);
        done();
    };
    const modules = {
        "node:assert/strict": assert,
        "node:crypto": require("node:crypto"),
        jsonwebtoken: jwt,
        dotenv: { config: () => {} },
        // Real pg parsing only: Client is never connected.
        pg: require("pg"),
        "./src/app": {
            createApp: () => ({
                listen: (port, host) => {
                    assert.equal(port, 0);
                    assert.equal(host, "127.0.0.1");
                    calls.starts++;
                    queueMicrotask(() =>
                        server.emit(
                            options.startupFailure ? "error" : "listening",
                            new Error(privateError),
                        ),
                    );
                    return server;
                },
            }),
        },
        "./src/db": {
            getPrisma: () => ({
                $disconnect: async () => {
                    calls.disconnects++;
                    if (options.cleanupFailure) throw new Error(privateError);
                },
            }),
        },
    };
    const execute = new Function(
        "mocks",
        "const { require, process, URL, AbortSignal, console, fetch } = mocks;\n" +
            code.replace("(async () => {", "return (async () => {"),
    );
    await execute({
        require: (name) => {
            assert.ok(
                Object.hasOwn(modules, name),
                `Unexpected module ${name}`,
            );
            return modules[name];
        },
        process: processMock,
        URL,
        AbortSignal,
        console: { log: (line) => output.push(line) },
        fetch: async (url, request) => {
            calls.requests.push(url);
            assert.equal(request.redirect, "error");
            assert.ok(request.signal instanceof AbortSignal);
            let body;
            if (url.endsWith("/login")) {
                assert.equal(request.method, "POST");
                assert.equal(JSON.parse(request.body).password, password);
                body = {
                    success: true,
                    token: jwt.sign({}, processMock.env.JWT_SECRET, {
                        algorithm: "HS256",
                        issuer: "im101-api",
                        audience: "im101-client",
                        subject: "7",
                        expiresIn: 900,
                        ...options.sign,
                    }),
                    tokenType: "Bearer",
                    expiresIn: 900,
                    user: structuredClone(user),
                };
                if (options.badSignature) body.token += "tampered";
                options.login?.(body);
            } else {
                assert.equal(url, "http://127.0.0.1:12345/api/auth/me");
                jwt.verify(
                    request.headers.Authorization.slice(7),
                    processMock.env.JWT_SECRET,
                );
                body = { success: true, user: structuredClone(user) };
                options.profile?.(body);
            }
            if (options.httpFailure) throw new Error(privateError);
            return {
                status: options.status ?? 200,
                headers: { get: () => options.cacheControl ?? "no-store" },
                json: async () => body,
            };
        },
    });
    assert.equal(processMock.env.JWT_SECRET, undefined);
    for (const secret of [password, privateError, "postgresql://", "eyJ"]) {
        assert.ok(!output.join("\n").includes(secret));
    }
    return {
        calls,
        output: output.join("\n"),
        exitCode: processMock.exitCode ?? 0,
    };
}

test("verification succeeds with mock HTTP and real JWT validation, then cleans up", async () => {
    const result = await verify();
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /^PASS:/);
    assert.equal(result.calls.requests.length, 2);
    assert.equal(result.calls.closes, 1);
    assert.equal(result.calls.disconnects, 1);
});

test("accepts the matching Supabase pooler identity", async () => {
    const result = await verify({
        env: {
            DATABASE_URL: `postgresql://postgres.${ref}:fixture@aws-0-ap-southeast-1.pooler.supabase.com/postgres?sslmode=verify-full`,
        },
    });
    assert.equal(result.exitCode, 0);
});

test("refuses invalid V2/TLS settings before starting a server", async () => {
    const urls = [
        "postgresql://fixture:fixture@localhost/postgres?sslmode=verify-full",
        `postgresql://postgres:fixture@db.${ref}.supabase.co/postgres?sslmode=require`,
        `postgresql://postgres:fixture@db.${ref}.supabase.co/postgres?sslmode=verify-full&sslmode=verify-full`,
        "postgresql://postgres.wrong:fixture@aws-0.pooler.supabase.com/postgres?sslmode=verify-full",
        "https://example.test/?sslmode=verify-full",
    ];
    const environments = urls.map((DATABASE_URL) => ({ DATABASE_URL }));
    environments.push(
        { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        { IM101_EXPECTED_V2_REF: "wrong" },
    );
    for (const env of environments) {
        const result = await verify({ env });
        assert.equal(result.exitCode, 1);
        assert.match(result.output, /FAIL: configuration;/);
        assert.equal(result.calls.starts, 0);
        assert.equal(result.calls.requests.length, 0);
    }
});

test("rejects JWT, response, role, and HTTP failures with sanitized output and cleanup", async () => {
    const failures = [
        { badSignature: true },
        { sign: { issuer: "wrong" } },
        { sign: { audience: "wrong" } },
        { sign: { subject: "8" } },
        { sign: { expiresIn: 60 } },
        { sign: { expiresIn: -1 } },
        { sign: { algorithm: "HS384" } },
        { status: 401 },
        { cacheControl: "public" },
        { httpFailure: true },
        { login: (body) => (body.user.passwordHash = password) },
        { login: (body) => (body.user.role.roleName = "Faculty") },
        { login: (body) => (body.user.email = "wrong@example.test") },
        { profile: (body) => (body.user.role.roleName = "Faculty") },
        { profile: (body) => (body.user.fname = "Changed") },
        { profile: (body) => (body.user.password = password) },
        { cleanupFailure: true },
        { serverCleanupFailure: true },
    ];
    for (const options of failures) {
        const result = await verify(options);
        assert.equal(result.exitCode, 1);
        assert.match(result.output, /FAIL:/);
        assert.equal(result.calls.closes, 1);
        assert.equal(result.calls.disconnects, 1);
    }
});

test("credential parse and server startup failures are sanitized", async () => {
    const input = await verify({ input: privateError });
    assert.match(input.output, /FAIL: credential input;/);
    assert.equal(input.calls.starts, 0);
    const startup = await verify({ startupFailure: true });
    assert.match(startup.output, /FAIL: local server startup;/);
    assert.equal(startup.calls.closes, 1);
    assert.equal(startup.calls.requests.length, 0);
});
