const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rootCertificates, checkServerIdentity } = require("node:tls");
const bcrypt = require("bcryptjs");
const { spawnSync } = require("node:child_process");
const {
    resetAdminPassword,
    validateInput,
    connectionConfig,
} = require("../scripts/reset-admin-password");
const projectRef = "abcdefghijklmnopqrst";
const email = "admin@example.test";
const password = " private-recovery-password ";
const input = {
    email,
    projectRef,
    password,
    confirmation: password,
    approval: `RESET PASSWORD ${email} IN ${projectRef}`,
};
const env = {
    DATABASE_URL: `postgresql://postgres:private-db-password@db.${projectRef}.supabase.co/postgres?sslmode=verify-full`,
    NODE_EXTRA_CA_CERTS: "mock-ca-only",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
};
const readCa = () => rootCertificates[0];

async function fixture(options = {}) {
    const calls = [];
    let pending = false;
    let committed = false;
    let savedHash;
    let closed = false;
    const user = {
        user_id: 7,
        email,
        is_active: true,
        role_name: "System Administrator",
        ...options.user,
    };
    const result = await resetAdminPassword({
        input: { ...input, ...options.input },
        env: { ...env, ...options.env },
        readCa: options.readCa || readCa,
        hash: options.hash || bcrypt.hash,
        createClient: (config) => {
            calls.push("create");
            assert.equal(config.ssl.rejectUnauthorized, true);
            assert.equal(config.ssl.checkServerIdentity, checkServerIdentity);
            assert.equal(config.connectionString, undefined);
            return {
                on: (event, handler) => {
                    assert.equal(event, "error");
                    handler(new Error("PRIVATE-error"));
                },
                connect: async () => {
                    calls.push("connect");
                    if (options.fail === "connect")
                        throw Object.assign(new Error("PRIVATE-error"), {
                            code: options.errorCode,
                        });
                },
                query: async (sql, params) => {
                    const operation = sql.split(" ")[0];
                    calls.push(operation);
                    if (
                        operation === options.fail ||
                        (operation === "ROLLBACK" && options.rollbackFail)
                    )
                        throw Object.assign(new Error("PRIVATE-error"), {
                            code: options.errorCode,
                        });
                    if (operation === "SELECT") {
                        assert.match(
                            sql,
                            /WHERE u.email = \$1 FOR UPDATE OF u, r/,
                        );
                        assert.deepEqual(params, [email]);
                        assert.ok(!sql.includes("password_hash"));
                        return {
                            rows: options.missing ? [] : [user],
                            rowCount: options.missing
                                ? 0
                                : (options.count ?? 1),
                        };
                    }
                    if (operation === "UPDATE") {
                        assert.match(sql, /SET password_hash = \$1\s+WHERE/);
                        assert.match(sql, /AND u.is_active = true/);
                        assert.match(sql, /AND EXISTS/);
                        assert.deepEqual(params.slice(1), [
                            7,
                            email,
                            "System Administrator",
                        ]);
                        savedHash = params[0];
                        pending = true;
                        return {
                            rows: [
                                { user_id: options.wrongReturnedId ? 8 : 7 },
                            ],
                            rowCount: options.updatedCount ?? 1,
                        };
                    }
                    if (operation === "ROLLBACK") pending = false;
                    if (operation === "COMMIT") {
                        committed = pending;
                        pending = false;
                        if (options.commitAcknowledgementLost)
                            throw new Error("PRIVATE-error");
                    }
                    return {};
                },
                end: async () => {
                    closed = true;
                    if (options.cleanupFail) throw new Error("PRIVATE-error");
                },
            };
        },
    });
    for (const secret of [
        password,
        "PRIVATE-error",
        "private-db-password",
        "postgresql://",
        savedHash,
    ].filter(Boolean)) {
        assert.ok(!JSON.stringify(result).includes(secret));
    }
    return { result, calls, committed, pending, closed, savedHash };
}

test("validates exact email, approval, Unicode, password confirmation and boundaries", () => {
    for (const change of [
        { email: " " + email },
        { email: email + " " },
        { email: "bad" },
        { email: "\ud800@example.test" },
        { projectRef: "wrong" },
        { approval: "yes" },
        { approval: input.approval.toLowerCase() },
        { password: "x".repeat(14) },
        { password: "x".repeat(73) },
        { password: "雪".repeat(25) },
        { password: "\ud800".repeat(15) },
        { password: " ".repeat(15) },
        { password: "a".repeat(15) + "\0" },
        { confirmation: "mismatched" },
        { password: null },
    ])
        assert.throws(() => validateInput({ ...input, ...change }));
    for (const value of [
        "x".repeat(15),
        "x".repeat(72),
        "雪".repeat(24),
        "😀".repeat(15),
        password,
    ]) {
        assert.doesNotThrow(() =>
            validateInput({ ...input, password: value, confirmation: value }),
        );
    }
});

test("rejects mismatched project, weak/overridden TLS, missing/invalid CA before client creation", async () => {
    for (const url of [
        env.DATABASE_URL.replace(projectRef, "zyxwvutsrqponmlkjihg"),
        env.DATABASE_URL.replace("verify-full", "require"),
        env.DATABASE_URL + "&sslmode=verify-full",
        env.DATABASE_URL + "&sslrootcert=private-file",
        env.DATABASE_URL + "&host=localhost",
        env.DATABASE_URL.replace("/postgres?", "/other?"),
        env.DATABASE_URL.replace("/postgres?", ":6543/postgres?"),
        "invalid",
    ]) {
        const f = await fixture({ env: { DATABASE_URL: url } });
        assert.equal(f.result.success, false);
        assert.deepEqual(f.calls, []);
    }
    for (const option of [
        { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
        { env: { NODE_EXTRA_CA_CERTS: "" } },
        { readCa: () => "invalid" },
        {
            readCa: () => {
                throw new Error("PRIVATE-error");
            },
        },
        { input: { approval: "no" } },
        {
            hash: async () => {
                throw new Error("PRIVATE-error");
            },
        },
    ]) {
        const f = await fixture(option);
        assert.equal(f.result.success, false);
        assert.deepEqual(f.calls, []);
    }
});

test("accepts only matching direct or session pooler configuration with explicit verified TLS", () => {
    const pooler = {
        ...env,
        DATABASE_URL: `postgresql://postgres.${projectRef}:fixture@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
    };
    assert.equal(
        connectionConfig(pooler, projectRef, readCa).user,
        `postgres.${projectRef}`,
    );
    assert.throws(() =>
        connectionConfig(
            {
                ...pooler,
                DATABASE_URL: pooler.DATABASE_URL.replace(projectRef, "wrong"),
            },
            projectRef,
            readCa,
        ),
    );
    assert.equal(
        connectionConfig(env, projectRef, readCa).ssl.ca,
        rootCertificates[0],
    );
});

test("refuses missing, inactive, unauthorized, ambiguous or mismatched accounts without UPDATE", async () => {
    for (const options of [
        { missing: true },
        { count: 2 },
        { user: { is_active: false } },
        { user: { role_name: "Faculty" } },
        { user: { role_name: "system administrator" } },
        { user: { email: "Admin@example.test" } },
        { user: { user_id: -1 } },
    ]) {
        const f = await fixture(options);
        assert.equal(f.result.success, false);
        assert.equal(f.committed, false);
        assert.ok(!f.calls.includes("UPDATE"));
        assert.ok(f.calls.includes("ROLLBACK"));
        assert.ok(f.closed);
    }
});

test("successful reset hashes untrimmed password at bcrypt cost 12 and commits only selected row", async () => {
    const f = await fixture();
    assert.equal(f.result.success, true);
    assert.equal(f.committed, true);
    assert.ok(f.closed);
    assert.equal(bcrypt.getRounds(f.savedHash), 12);
    assert.equal(await bcrypt.compare(password, f.savedHash), true);
    assert.equal(await bcrypt.compare(password.trim(), f.savedHash), false);
    assert.deepEqual(f.calls, [
        "create",
        "connect",
        "BEGIN",
        "SELECT",
        "UPDATE",
        "COMMIT",
    ]);
});

test("transaction failures roll back, close and never retry; ambiguous commit/cleanup is reported", async () => {
    for (const fail of ["connect", "BEGIN", "SELECT", "UPDATE", "COMMIT"]) {
        const f = await fixture({ fail });
        assert.equal(f.result.success, false);
        assert.ok(f.closed);
        assert.equal(f.committed, false);
        assert.equal(f.calls.filter((x) => x === fail).length, 1);
        if (["SELECT", "UPDATE", "COMMIT"].includes(fail))
            assert.ok(f.calls.includes("ROLLBACK"));
        if (fail === "COMMIT") assert.match(f.result.message, /uncertain/);
    }
    for (const options of [
        { updatedCount: 0 },
        { updatedCount: 2 },
        { wrongReturnedId: true },
    ]) {
        const f = await fixture(options);
        assert.equal(f.result.success, false);
        assert.equal(f.pending, false);
        assert.equal(f.committed, false);
        assert.ok(f.calls.includes("ROLLBACK"));
    }
    const rollback = await fixture({ fail: "UPDATE", rollbackFail: true });
    assert.match(rollback.result.message, /rollback could not be confirmed/);
    assert.ok(rollback.closed);
    const cleanup = await fixture({ cleanupFail: true });
    assert.equal(cleanup.committed, true);
    assert.equal(cleanup.result.success, false);
    assert.match(cleanup.result.message, /may have completed/);
});

test("PowerShell launcher prompts and stdin are exercised with mock-only native command", (t) => {
    const executable = process.env.VERIFY_ADMIN_TEST_PWSH || "pwsh";
    const result = spawnSync(
        executable,
        ["-NoProfile", "-File", "tests/reset-admin-password.mock.ps1"],
        { encoding: "utf8" },
    );
    if (result.error?.code === "ENOENT") {
        t.skip(
            "PowerShell unavailable; set VERIFY_ADMIN_TEST_PWSH to run wrapper mocks.",
        );
        return;
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: mocked recovery/);
});

test("sanitized diagnostics distinguish input, configuration, account and transaction causes", async () => {
    const cases = [
        [
            { input: { password: "short" } },
            "INPUT_VALIDATION/PASSWORD_REQUIREMENTS",
        ],
        [
            { input: { confirmation: "different" } },
            "INPUT_VALIDATION/PASSWORD_CONFIRMATION",
        ],
        [{ input: { email: ` ${email}` } }, "INPUT_VALIDATION/EMAIL_FORMAT"],
        [
            { input: { projectRef: "wrong" } },
            "INPUT_VALIDATION/PROJECT_REFERENCE_FORMAT",
        ],
        [{ input: { approval: "no" } }, "INPUT_VALIDATION/APPROVAL_REQUIRED"],
        [
            { env: { DATABASE_URL: "invalid" } },
            "CONFIGURATION/DATABASE_URL_FORMAT",
        ],
        [
            { env: { DATABASE_URL: env.DATABASE_URL + "&pgbouncer=true" } },
            "CONFIGURATION/DATABASE_URL_SHAPE",
        ],
        [
            {
                env: {
                    DATABASE_URL: env.DATABASE_URL.replace(
                        projectRef,
                        "zyxwvutsrqponmlkjihg",
                    ),
                },
            },
            "CONFIGURATION/V2_PROJECT_IDENTITY",
        ],
        [
            {
                env: {
                    DATABASE_URL: env.DATABASE_URL.replace(
                        "verify-full",
                        "require",
                    ),
                },
            },
            "CONFIGURATION/TLS_CONFIGURATION",
        ],
        [
            {
                readCa: () => {
                    throw new Error("PRIVATE-error");
                },
            },
            "CONFIGURATION/CA_READ",
        ],
        [{ readCa: () => "invalid" }, "CONFIGURATION/CA_CERTIFICATE"],
        [
            { fail: "connect", errorCode: "CERT_HAS_EXPIRED" },
            "DATABASE_CONNECTION/TLS_CERTIFICATE_EXPIRED",
        ],
        [
            { fail: "connect", errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" },
            "DATABASE_CONNECTION/TLS_HOSTNAME",
        ],
        [
            { fail: "connect", errorCode: "28P01" },
            "DATABASE_CONNECTION/DATABASE_AUTHENTICATION",
        ],
        [
            { fail: "connect", errorCode: "ENOTFOUND" },
            "DATABASE_CONNECTION/NETWORK_DNS",
        ],
        [{ missing: true }, "ACCOUNT_LOOKUP/ACCOUNT_NOT_FOUND"],
        [
            { user: { email: "Admin@example.test" } },
            "ACCOUNT_LOOKUP/ACCOUNT_EMAIL_MISMATCH",
        ],
        [{ user: { is_active: false } }, "ACCOUNT_LOOKUP/ACCOUNT_INACTIVE"],
        [
            { user: { role_name: "Faculty" } },
            "ACCOUNT_LOOKUP/ACCOUNT_ROLE_REFUSED",
        ],
        [
            { fail: "SELECT", errorCode: "42501" },
            "ACCOUNT_LOOKUP/DATABASE_PERMISSION",
        ],
        [
            { fail: "SELECT", errorCode: "42P01" },
            "ACCOUNT_LOOKUP/DATABASE_SCHEMA",
        ],
        [{ fail: "SELECT", errorCode: "55P03" }, "ACCOUNT_LOOKUP/LOCK_TIMEOUT"],
        [
            { fail: "UPDATE", errorCode: "40001" },
            "PASSWORD_UPDATE/SERIALIZATION_CONFLICT",
        ],
        [{ updatedCount: 0 }, "PASSWORD_UPDATE/UPDATE_CARDINALITY"],
        [{ fail: "BEGIN" }, "TRANSACTION_BEGIN/DETAILS_WITHHELD"],
        [
            { fail: "connect", errorCode: "PRIVATE-error" },
            "DATABASE_CONNECTION/DETAILS_WITHHELD",
        ],
        [
            { fail: "connect", errorCode: "toString" },
            "DATABASE_CONNECTION/DETAILS_WITHHELD",
        ],
    ];
    for (const [options, code] of cases) {
        const f = await fixture(options);
        assert.equal(f.result.success, false);
        assert.equal(f.result.code, code);
        assert.ok(f.result.message.includes(`[${code}]`));
        assert.ok(!f.calls.includes("COMMIT"));
    }
});

test("lost commit acknowledgement can mean the password was changed despite failure", async () => {
    const f = await fixture({ commitAcknowledgementLost: true });
    assert.equal(f.result.success, false);
    assert.equal(f.committed, true);
    assert.match(f.result.message, /commit outcome uncertain/);
    assert.ok(f.calls.includes("ROLLBACK"));
    assert.ok(f.closed);
    assert.equal(f.calls.filter((x) => x === "COMMIT").length, 1);
});
