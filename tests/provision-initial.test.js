const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const bcrypt = require("bcryptjs");
const { runProvisioning } = require("../scripts/provision-initial");

const approvedRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const input = {
    DATABASE_URL:
        "postgresql://fixture:fixture@localhost/isolated?sslmode=verify-full",
    PROVISION_ADMIN_EMAIL: "operator@example.test",
    PROVISION_ADMIN_FIRST_NAME: "Test",
    PROVISION_ADMIN_LAST_NAME: "Operator",
    PROVISION_ADMIN_PASSWORD: "Controlled-fixture-password",
};

function fixture(initial = {}) {
    let state = { roles: [], users: [], ...structuredClone(initial) };
    const calls = {
        clients: 0,
        transactions: 0,
        disconnects: 0,
        writes: 0,
        confirmations: 0,
    };
    let failAt;
    let failure = new Error(
        "PRIVATE database credentials and raw database error",
    );
    const fail = (stage) => {
        if (failAt === stage) throw failure;
    };
    const prisma = {
        $transaction: async (work, options) => {
            calls.transactions += 1;
            assert.deepEqual(options, {
                isolationLevel: "Serializable",
                maxWait: 10000,
                timeout: 30000,
            });
            fail("transaction");
            const draft = structuredClone(state);
            const tx = {
                role: {
                    upsert: async (query) => {
                        calls.writes += 1;
                        fail("role");
                        assert.deepEqual(query.update, {});
                        assert.deepEqual(query.create, {
                            roleName: query.where.roleName,
                        });
                        assert.deepEqual(query.select, { roleId: true });
                        let role = draft.roles.find(
                            (item) => item.roleName === query.where.roleName,
                        );
                        if (!role) {
                            role = {
                                roleId: 70 + draft.roles.length,
                                ...query.create,
                            };
                            draft.roles.push(role);
                        }
                        return { roleId: role.roleId };
                    },
                },
                user: {
                    findUnique: async (query) => {
                        assert.deepEqual(query.select, { userId: true });
                        return (
                            draft.users.find(
                                (item) => item.email === query.where.email,
                            ) || null
                        );
                    },
                    findFirst: async (query) => {
                        assert.deepEqual(query.where, {
                            role: { roleName: approvedRoles[0] },
                        });
                        return (
                            draft.users.find((item) =>
                                draft.roles.some(
                                    (role) =>
                                        role.roleId === item.roleId &&
                                        role.roleName === approvedRoles[0],
                                ),
                            ) || null
                        );
                    },
                    create: async (query) => {
                        calls.writes += 1;
                        fail("user");
                        assert.deepEqual(query.select, { userId: true });
                        draft.users.push({
                            userId: 200 + draft.users.length,
                            ...query.data,
                        });
                        return { userId: 200 };
                    },
                },
            };
            await work(tx);
            fail("commit");
            state = draft;
        },
        $disconnect: async () => {
            calls.disconnects += 1;
            fail("disconnect");
        },
    };
    return {
        calls,
        state: () => structuredClone(state),
        fail: (stage, error = failure) => {
            failAt = stage;
            failure = error;
        },
        run: (overrides = {}) =>
            runProvisioning({
                args: ["admin"],
                env: { ...input },
                confirm: async (phrase) => {
                    calls.confirmations += 1;
                    return phrase;
                },
                getClient: () => {
                    calls.clients += 1;
                    fail("client");
                    return prisma;
                },
                ...overrides,
            }),
    };
}

test("role provisioning is repeatable and preserves all existing records and IDs", async () => {
    const existing = { roleId: 851, roleName: approvedRoles[0] };
    const unrelated = { roleId: 91, roleName: "Existing custom role" };
    const f = fixture({
        roles: [existing, unrelated],
        users: [{ userId: 900, email: "existing@example.test", roleId: 91 }],
    });
    assert.equal(
        (
            await f.run({
                args: ["roles"],
                env: { DATABASE_URL: input.DATABASE_URL },
            })
        ).success,
        true,
    );
    const first = f.state();
    assert.equal((await f.run({ args: ["roles"] })).success, true);
    assert.deepEqual(f.state(), first);
    assert.equal(first.roles.length, 4);
    assert.deepEqual(
        first.roles.find((role) => role.roleName === approvedRoles[0]),
        existing,
    );
    assert.deepEqual(
        first.roles.find((role) => role.roleId === 91),
        unrelated,
    );
    for (const role of approvedRoles)
        assert.equal(
            first.roles.filter((item) => item.roleName === role).length,
            1,
        );
    assert.deepEqual(first.users, [
        { userId: 900, email: "existing@example.test", roleId: 91 },
    ]);
    assert.equal(f.calls.disconnects, 2);
});
test("administrator creation hashes the exact password and uses the actual role ID", async () => {
    const f = fixture({ roles: [{ roleId: 867, roleName: approvedRoles[0] }] });
    const password = "  Controlled fixture password  ";
    const result = await f.run({
        env: {
            ...input,
            PROVISION_ADMIN_EMAIL: ` ${input.PROVISION_ADMIN_EMAIL} `,
            PROVISION_ADMIN_PASSWORD: password,
        },
    });
    assert.deepEqual(result, {
        success: true,
        message: "Initial administrator created; approved roles initialized.",
    });
    const account = f.state().users[0];
    assert.equal(account.email, input.PROVISION_ADMIN_EMAIL);
    assert.equal(account.fname, input.PROVISION_ADMIN_FIRST_NAME);
    assert.equal(account.lname, input.PROVISION_ADMIN_LAST_NAME);
    assert.equal(account.roleId, 867);
    assert.equal(account.isActive, true);
    assert.equal(bcrypt.getRounds(account.passwordHash), 12);
    assert.equal(await bcrypt.compare(password, account.passwordHash), true);
    assert.equal(
        await bcrypt.compare(password.trim(), account.passwordHash),
        false,
    );
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.equal(JSON.stringify(result).includes(account.passwordHash), false);
});
test("duplicate email is refused without changing the existing account or roles", async () => {
    const original = {
        userId: 81,
        email: input.PROVISION_ADMIN_EMAIL,
        passwordHash: "existing-private-hash",
        roleId: 999,
    };
    const f = fixture({ users: [original] });
    const before = f.state();
    const result = await f.run();
    assert.equal(result.success, false);
    assert.match(result.message, /Email already exists/);
    assert.deepEqual(f.state(), before);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.disconnects, 1);
});
test("an existing administrator, including an inactive one, blocks another initial account", async () => {
    const f = fixture({
        roles: [{ roleId: 92, roleName: approvedRoles[0] }],
        users: [
            {
                userId: 1,
                email: "other@example.test",
                roleId: 92,
                isActive: false,
            },
        ],
    });
    const before = f.state();
    const result = await f.run();
    assert.equal(result.success, false);
    assert.match(result.message, /administrator already exists/);
    assert.deepEqual(f.state(), before);
    assert.equal(f.calls.writes, 0);
});
test("confirmation is required for either mode before creating any database client", async () => {
    for (const mode of ["roles", "admin"]) {
        const f = fixture();
        let requested;
        const result = await f.run({
            args: [mode],
            confirm: async (phrase) => {
                requested = phrase;
                return "yes";
            },
        });
        assert.equal(result.success, false);
        assert.equal(
            requested,
            mode === "admin"
                ? "CREATE FIRST ADMINISTRATOR"
                : "INITIALIZE ROLES",
        );
        assert.equal(f.calls.clients, 0);
        assert.equal(f.calls.writes, 0);
    }
});
test("required fields, email shape, field lengths, and password byte limits are validated before confirmation", async () => {
    const invalid = [
        ...[
            "PROVISION_ADMIN_EMAIL",
            "PROVISION_ADMIN_FIRST_NAME",
            "PROVISION_ADMIN_LAST_NAME",
            "PROVISION_ADMIN_PASSWORD",
        ].flatMap((key) => [
            { [key]: undefined },
            { [key]: "" },
            { [key]: "   " },
        ]),
        { PROVISION_ADMIN_EMAIL: "not-an-email" },
        { PROVISION_ADMIN_EMAIL: "x".repeat(151) + "@example.test" },
        { PROVISION_ADMIN_FIRST_NAME: "x".repeat(61) },
        { PROVISION_ADMIN_LAST_NAME: "x".repeat(61) },
        { PROVISION_ADMIN_FIRST_NAME: "bad\nname" },
        { PROVISION_ADMIN_PASSWORD: "short" },
        { PROVISION_ADMIN_PASSWORD: "x".repeat(73) },
        { PROVISION_ADMIN_PASSWORD: "é".repeat(37) },
        { PROVISION_ADMIN_PASSWORD: "long\0invalid-password" },
    ];
    for (const override of invalid) {
        const f = fixture();
        assert.equal(
            (await f.run({ env: { ...input, ...override } })).success,
            false,
        );
        assert.equal(f.calls.confirmations, 0);
        assert.equal(f.calls.clients, 0);
    }
});
test("a 72-byte UTF-8 password is accepted without truncation", async () => {
    const f = fixture();
    const password = "é".repeat(36);
    assert.equal(
        (await f.run({ env: { ...input, PROVISION_ADMIN_PASSWORD: password } }))
            .success,
        true,
    );
    assert.equal(
        await bcrypt.compare(password, f.state().users[0].passwordHash),
        true,
    );
});
test("missing, invalid, or insecure configuration and unknown arguments cannot open a database client", async () => {
    for (const override of [
        { env: {} },
        { env: { ...input, DATABASE_URL: "PRIVATE-invalid-database-url" } },
        { env: { ...input, DATABASE_URL: "https://example.test" } },
        { env: { ...input, NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
        {
            env: {
                ...input,
                DATABASE_URL: input.DATABASE_URL.replace(
                    "verify-full",
                    "no-verify",
                ),
            },
        },
        { args: [] },
        { args: ["admin", "--yes"] },
        { args: ["register"] },
    ]) {
        const f = fixture();
        const result = await f.run(override);
        assert.equal(result.success, false);
        assert.equal(result.message.includes("PRIVATE"), false);
        assert.equal(f.calls.confirmations, 0);
        assert.equal(f.calls.clients, 0);
    }
});
test("database failures are sanitized, cleaned up, and do not commit partial records", async () => {
    for (const stage of ["client", "transaction", "role", "user", "commit"]) {
        const f = fixture();
        f.fail(stage);
        const result = await f.run();
        assert.equal(result.success, false);
        assert.deepEqual(f.state(), { roles: [], users: [] });
        assert.equal(f.calls.disconnects, stage === "client" ? 0 : 1);
        assert.equal(result.message.includes("PRIVATE"), false);
    }
});
test("unique and serialization conflicts have safe errors without automatic retries", async () => {
    for (const code of ["P2002", "P2034"]) {
        const f = fixture();
        f.fail(
            "commit",
            Object.assign(new Error("PRIVATE-conflict-details"), { code }),
        );
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(result.message.includes("PRIVATE"), false);
        assert.equal(f.calls.transactions, 1);
        assert.deepEqual(f.state(), { roles: [], users: [] });
    }
});
test("cleanup failure reports that a write may already have completed", async () => {
    const f = fixture();
    f.fail("disconnect");
    const result = await f.run({ args: ["roles"] });
    assert.equal(result.success, false);
    assert.match(result.message, /may have completed/);
    assert.equal(f.state().roles.length, 3);
    assert.equal(result.message.includes("PRIVATE"), false);
});
test("the actual CLI refuses noninteractive writes and never echoes credentials", () => {
    const result = spawnSync(
        process.execPath,
        ["scripts/provision-initial.js", "admin"],
        {
            env: {
                ...process.env,
                ...input,
                NODE_TLS_REJECT_UNAUTHORIZED: "1",
            },
            encoding: "utf8",
            timeout: 10000,
        },
    );
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cancelled/);
    for (const value of [
        input.DATABASE_URL,
        input.PROVISION_ADMIN_EMAIL,
        input.PROVISION_ADMIN_PASSWORD,
    ]) {
        assert.equal((result.stdout + result.stderr).includes(value), false);
    }
});

test("known TLS, transaction, and schema failures give safe actionable errors without retry", async () => {
    for (const [code, expected] of [
        ["P1011", /TLS verification failed/],
        ["P2028", /transaction failed or expired/],
        ["P2000", /schema or column mismatch/],
        ["P2021", /schema or column mismatch/],
        ["P2022", /schema or column mismatch/],
    ]) {
        const f = fixture();
        f.fail(
            "transaction",
            Object.assign(
                new Error("PRIVATE credentials certificate contents"),
                { code },
            ),
        );
        const result = await f.run({ args: ["roles"] });
        assert.equal(result.success, false);
        assert.match(result.message, expected);
        assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
        assert.equal(f.calls.transactions, 1);
        assert.equal(f.calls.disconnects, 1);
        assert.equal(f.calls.writes, 0);
    }
});

test("real Prisma role upserts tolerate round trips beyond the default transaction timeout", async () => {
    const { PrismaClient } = require("@prisma/client");
    const queries = [];
    let commits = 0;
    let rollbacks = 0;
    const connection = {
        provider: "postgres",
        adapterName: "isolated-provisioning-regression",
        queryRaw: async (query) => {
            queries.push(query);
            await new Promise((resolve) => setTimeout(resolve, 650));
            // Simulate an empty table on each upsert's initial existence check.
            const exists = /OFFSET/.test(query.sql) && !/LIMIT/.test(query.sql);
            return {
                columnNames: ["role_id"],
                columnTypes: [0],
                rows: exists ? [] : [[73]],
            };
        },
        executeRaw: async () => 0,
    };
    const prisma = new PrismaClient({
        adapter: {
            ...connection,
            connect: async () => ({
                ...connection,
                startTransaction: async () => ({
                    ...connection,
                    options: { usePhantomQuery: false },
                    commit: async () => {
                        commits += 1;
                    },
                    rollback: async () => {
                        rollbacks += 1;
                    },
                }),
                dispose: async () => {},
            }),
        },
    });
    const result = await runProvisioning({
        args: ["roles"],
        env: input,
        confirm: async (phrase) => phrase,
        getClient: () => prisma,
    });
    assert.equal(result.success, true);
    assert.equal(commits, 1);
    assert.equal(rollbacks, 0);
    assert.equal(
        queries.filter((query) => /^INSERT/.test(query.sql)).length,
        3,
    );
    assert.ok(queries.length * 650 > 5000);
    for (const role of approvedRoles) {
        assert.ok(
            queries.some(
                (query) =>
                    /^INSERT/.test(query.sql) && query.args.includes(role),
            ),
        );
    }
});

test("ambiguous TLS modes and malformed Unicode are rejected before confirmation", async () => {
    for (const override of [
        { DATABASE_URL: input.DATABASE_URL + "&sslmode=no-verify" },
        { DATABASE_URL: input.DATABASE_URL + "&sslmode=disable" },
        { PROVISION_ADMIN_EMAIL: "bad\uD800@example.test" },
        { PROVISION_ADMIN_FIRST_NAME: "bad\u0085name" },
        { PROVISION_ADMIN_LAST_NAME: "bad\uDFFFname" },
        { PROVISION_ADMIN_PASSWORD: "Controlled-password-\uD800" },
    ]) {
        const f = fixture();
        assert.equal(
            (await f.run({ env: { ...input, ...override } })).success,
            false,
        );
        assert.equal(f.calls.confirmations, 0);
        assert.equal(f.calls.clients, 0);
    }
});

test("existing approved roles keep every ID and value during admin creation and role reruns", async () => {
    const roles = approvedRoles.map((roleName, i) => ({
        roleId: 801 + i,
        roleName,
    }));
    const f = fixture({ roles });
    assert.equal((await f.run()).success, true);
    assert.deepEqual(f.state().roles, roles);
    assert.equal(f.state().users[0].roleId, 801);
    const before = f.state();
    assert.equal((await f.run({ args: ["roles"] })).success, true);
    assert.deepEqual(f.state(), before);
    assert.equal((await f.run()).success, false);
    assert.deepEqual(f.state(), before);
});

test("concurrent initial administrators handle a Serializable commit conflict without retry", async () => {
    // Model two overlapping snapshots and PostgreSQL SSI's losing commit.
    // This is an application response test, not a PostgreSQL SSI implementation test.
    let arrivals = 0;
    let release;
    const bothReading = new Promise((resolve) => {
        release = resolve;
    });
    const committed = [];
    let transactions = 0;
    let disconnects = 0;
    const client = {
        $transaction: async (work, options) => {
            transactions += 1;
            assert.equal(options.isolationLevel, "Serializable");
            let candidate;
            await work({
                user: {
                    findUnique: async () => null,
                    findFirst: async () => {
                        arrivals += 1;
                        if (arrivals === 2) release();
                        await bothReading;
                        return null;
                    },
                    create: async ({ data }) => {
                        candidate = data;
                        return { userId: 1 };
                    },
                },
                role: { upsert: async () => ({ roleId: 801 }) },
            });
            if (committed.length) {
                throw Object.assign(
                    new Error("PRIVATE serialization details"),
                    { code: "P2034" },
                );
            }
            committed.push(candidate);
        },
        $disconnect: async () => {
            disconnects += 1;
        },
    };
    const run = (email) =>
        runProvisioning({
            args: ["admin"],
            env: { ...input, PROVISION_ADMIN_EMAIL: email },
            confirm: async (phrase) => phrase,
            getClient: () => client,
        });
    const results = await Promise.all([
        run("first@example.test"),
        run("second@example.test"),
    ]);
    assert.equal(results.filter((result) => result.success).length, 1);
    assert.match(
        results.find((result) => !result.success).message,
        /Concurrent provisioning conflict/,
    );
    assert.equal(committed.length, 1);
    assert.equal(transactions, 2);
    assert.equal(disconnects, 2);
    assert.equal(JSON.stringify(results).includes("PRIVATE"), false);
});

test("the installed PostgreSQL driver demonstrates why duplicate sslmode must be refused", () => {
    const { Client } = require("pg");
    const client = new Client({
        connectionString: input.DATABASE_URL + "&sslmode=no-verify",
    });
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, false);
});
