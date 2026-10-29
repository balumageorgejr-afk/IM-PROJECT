const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { rootCertificates } = require("node:tls");
const {
    facilityTypes,
    equipmentCategories,
    provisionLookups,
    validateConfirmation,
    readOperatorInput,
    runLookupCommand,
} = require("../scripts/provision-lookups");
const projectRef = "abcdefghijklmnopqrst";
const env = {
    DATABASE_URL: `postgresql://postgres:PRIVATE@db.${projectRef}.supabase.co/postgres?sslmode=verify-full`,
    NODE_EXTRA_CA_CERTS: "mock-only",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
};
function fixture(options = {}) {
    const initial = [
        ["Classroom", "Existing campus type"],
        ["Furniture", "Existing campus category"],
    ];
    let state = structuredClone(initial),
        draft;
    const calls = [];
    const client = {
        on: () => {},
        connect: async () => {
            if (options.fail === "connect")
                throw Object.assign(new Error("PRIVATE"), {
                    code: options.errorCode,
                });
        },
        end: async () => {
            if (options.fail === "end" || options.endFail)
                throw new Error("PRIVATE");
        },
        query: async (sql, values) => {
            calls.push(sql);
            if (
                options.fail === sql ||
                (options.fail === "insert" && values) ||
                (options.fail === "category" &&
                    sql.includes("equipment_categories")) ||
                (options.rollbackFail && sql === "ROLLBACK")
            )
                throw Object.assign(new Error("PRIVATE"), {
                    code: options.errorCode,
                });
            if (sql.startsWith("BEGIN")) draft = structuredClone(state);
            else if (sql === "COMMIT") {
                state = draft;
                if (options.lostCommitAcknowledgement)
                    throw new Error("PRIVATE");
            } else if (sql === "ROLLBACK") draft = undefined;
            else {
                assert.match(
                    sql,
                    /^INSERT INTO public\.(facility_types \(type_name\)|equipment_categories \(category_name\)) VALUES \(\$1\) ON CONFLICT \((type_name|category_name)\) DO NOTHING$/,
                );
                assert.equal(values.length, 1);
                const index = sql.includes("facility_types") ? 0 : 1;
                const exists = draft[index].includes(values[0]);
                if (!exists) draft[index].push(values[0]);
                return { rowCount: options.badCount ? 2 : exists ? 0 : 1 };
            }
            return {
                command:
                    options.badCommand === sql ? "PRIVATE" : sql.split(" ")[0],
            };
        },
    };
    return {
        client,
        calls,
        state: () => state,
        initial,
        run: (overrides = {}) =>
            provisionLookups({
                projectRef,
                approval: `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`,
                env,
                readCa: () => rootCertificates[0],
                createClient: (config) => {
                    calls.push("client");
                    assert.equal(config.ssl.rejectUnauthorized, true);
                    assert.equal(config.connectionString, undefined);
                    return client;
                },
                ...overrides,
            }),
    };
}
test("fixed suggested list is immutable, unique and within actual column limits", () => {
    for (const list of [facilityTypes, equipmentCategories]) {
        assert.ok(Object.isFrozen(list));
        assert.equal(new Set(list).size, list.length);
        for (const name of list)
            assert.ok(
                name.trim() === name && name.length > 0 && name.length <= 50,
            );
    }
});
test("lookup inserts are idempotent and preserve existing values", async () => {
    const f = fixture();
    assert.equal((await f.run()).success, true);
    const first = structuredClone(f.state());
    assert.equal((await f.run()).success, true);
    assert.deepEqual(f.state(), first);
    for (const [index, list] of [
        facilityTypes,
        equipmentCategories,
    ].entries()) {
        for (const value of [...list, ...f.initial[index]])
            assert.equal(f.state()[index].filter((v) => v === value).length, 1);
    }
    assert.ok(
        f.calls.every(
            (sql) => !/UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE/.test(sql),
        ),
    );
});
test("approval, identity and TLS failures never create a client", async () => {
    for (const overrides of [
        { approval: "" },
        { projectRef: "other" },
        {
            env: {
                ...env,
                DATABASE_URL: env.DATABASE_URL.replace(
                    projectRef,
                    "wrong-project",
                ),
            },
        },
        {
            env: {
                ...env,
                DATABASE_URL: env.DATABASE_URL.replace(
                    "verify-full",
                    "require",
                ),
            },
        },
        { env: { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
        { readCa: () => "not a CA" },
    ]) {
        const f = fixture();
        assert.equal((await f.run(overrides)).success, false);
        assert.deepEqual(f.calls, []);
    }
});
test("insert and commit failures roll back, do not retry, and withhold private errors", async () => {
    for (const fail of ["insert", "COMMIT", "end"]) {
        const f = fixture({ fail });
        const result = await f.run();
        assert.equal(result.success, false);
        assert.doesNotMatch(result.message, /PRIVATE/);
        if (fail !== "end") {
            assert.deepEqual(f.state(), f.initial);
            assert.equal(f.calls.filter((sql) => sql === "ROLLBACK").length, 1);
        }
        if (fail === "COMMIT") assert.equal(result.outcome, "COMMIT_UNCERTAIN");
    }
});
test("lost commit acknowledgement reports uncertainty even when rows committed", async () => {
    const f = fixture({ lostCommitAcknowledgement: true });
    const result = await f.run();
    assert.equal(result.success, false);
    assert.equal(result.outcome, "COMMIT_UNCERTAIN");
    assert.notDeepEqual(f.state(), f.initial);
    assert.equal(f.calls.filter((call) => call === "COMMIT").length, 1);
});
test("default preview and piped apply cannot connect even with real env present", () => {
    for (const args of [[], ["--apply"], ["--unknown"]]) {
        const result = spawnSync(
            process.execPath,
            ["scripts/provision-lookups.js", ...args],
            {
                encoding: "utf8",
                env: { ...process.env, DATABASE_URL: "invalid-private-value" },
            },
        );
        assert.equal(result.status, args.length ? 1 : 0);
        assert.doesNotMatch(
            result.stdout + result.stderr,
            /invalid-private-value/,
        );
        if (!args.length) assert.match(result.stdout, /Offline preview only/);
    }
});

test("exact confirmation: wrapping preserves text; spaces, real newlines and truncation refuse", () => {
    const complete = `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`;
    assert.doesNotThrow(() => validateConfirmation(projectRef, complete));
    // Visual soft wrapping adds no character to readline's returned string.
    assert.doesNotThrow(() =>
        validateConfirmation(
            projectRef,
            [complete.slice(0, 24), complete.slice(24)].join(""),
        ),
    );
    for (const [approval, code] of [
        [undefined, "CONFIRMATION_REQUIRED"],
        ["", "CONFIRMATION_REQUIRED"],
        [complete + " ", "CONFIRMATION_WHITESPACE"],
        [" " + complete, "CONFIRMATION_WHITESPACE"],
        [complete.slice(0, -1), "CONFIRMATION_INCOMPLETE"],
        ["APPROVE SUGGESTED LOOKUPS IN ", "CONFIRMATION_INCOMPLETE"],
        [complete.replace(" IN ", "\nIN "), "CONFIRMATION_CONTROL_CHARACTERS"],
        [complete + "\r", "CONFIRMATION_CONTROL_CHARACTERS"],
        [complete.toLowerCase(), "CONFIRMATION_MISMATCH"],
        [complete + "x", "CONFIRMATION_MISMATCH"],
    ])
        assert.throws(
            () => validateConfirmation(projectRef, approval),
            (error) => error.code === code,
        );
});

test("real readline preserves full phrases, CRLF, trailing spaces and the first submitted truncated line", async () => {
    const { PassThrough } = require("node:stream");
    const { createInterface } = require("node:readline/promises");
    const { setImmediate } = require("node:timers/promises");
    const complete = `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`;
    for (const [line, expected, reason] of [
        [complete + "\r\n", complete, null],
        [complete + " \r\n", complete + " ", "CONFIRMATION_WHITESPACE"],
        [
            complete.slice(0, 18) + "\r\n" + complete.slice(18) + "\r\n",
            complete.slice(0, 18),
            "CONFIRMATION_INCOMPLETE",
        ],
    ]) {
        const input = new PassThrough(),
            output = new PassThrough();
        const pending = readOperatorInput({
            mode: "--apply",
            createPrompt: () =>
                createInterface({
                    input,
                    output,
                    terminal: false,
                    crlfDelay: Infinity,
                }),
        });
        input.write(projectRef + "\r\n");
        await setImmediate();
        input.write(line);
        const actual = await pending;
        assert.equal(actual.approval, expected);
        if (reason)
            assert.throws(
                () => validateConfirmation(actual.projectRef, actual.approval),
                (error) => error.code === reason,
            );
        else
            assert.doesNotThrow(() =>
                validateConfirmation(actual.projectRef, actual.approval),
            );
        input.destroy();
        output.destroy();
    }
});

test("closed input cancels a pending question without echoing input or opening a client", async () => {
    const { PassThrough } = require("node:stream");
    const { createInterface } = require("node:readline/promises");
    const input = new PassThrough(),
        output = new PassThrough();
    const pending = readOperatorInput({
        mode: "--apply",
        createPrompt: () => createInterface({ input, output, terminal: false }),
    });
    input.end();
    await assert.rejects(
        pending,
        (error) => error.code === "INPUT_CANCELLED_OR_CLOSED",
    );
    output.destroy();
});

test("every shared local configuration refusal has a sanitized code before client creation", async () => {
    const cases = [
        [{ DATABASE_URL: undefined }, "DATABASE_URL_FORMAT"],
        [{ DATABASE_URL: "not a URL PRIVATE" }, "DATABASE_URL_FORMAT"],
        [
            {
                DATABASE_URL: env.DATABASE_URL.replace(
                    "postgres:PRIVATE",
                    "%XX:PRIVATE",
                ),
            },
            "DATABASE_URL_FORMAT",
        ],
        [
            { DATABASE_URL: env.DATABASE_URL.replace("postgresql:", "https:") },
            "DATABASE_URL_SHAPE",
        ],
        [{ DATABASE_URL: env.DATABASE_URL + "#PRIVATE" }, "DATABASE_URL_SHAPE"],
        [
            { DATABASE_URL: env.DATABASE_URL.replace("/postgres?", "/other?") },
            "DATABASE_URL_SHAPE",
        ],
        [
            { DATABASE_URL: env.DATABASE_URL.replace(":PRIVATE@", "@") },
            "DATABASE_URL_SHAPE",
        ],
        [
            {
                DATABASE_URL: env.DATABASE_URL.replace(
                    "/postgres?",
                    ":6543/postgres?",
                ),
            },
            "DATABASE_URL_SHAPE",
        ],
        [
            { DATABASE_URL: env.DATABASE_URL + "&sslmode=verify-full" },
            "DATABASE_URL_SHAPE",
        ],
        [
            { DATABASE_URL: env.DATABASE_URL + "&sslcert=PRIVATE" },
            "DATABASE_URL_SHAPE",
        ],
        [
            { DATABASE_URL: env.DATABASE_URL.replace("sslmode", "other") },
            "TLS_CONFIGURATION",
        ],
        [
            {
                DATABASE_URL: env.DATABASE_URL.replace(
                    "verify-full",
                    "require",
                ),
            },
            "TLS_CONFIGURATION",
        ],
        [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "TLS_CONFIGURATION"],
        [
            {
                DATABASE_URL: env.DATABASE_URL.replace(
                    projectRef,
                    "wrong-project",
                ),
            },
            "V2_PROJECT_IDENTITY",
        ],
        [
            {
                DATABASE_URL: env.DATABASE_URL.replace(
                    "postgres:PRIVATE",
                    "other:PRIVATE",
                ),
            },
            "V2_PROJECT_IDENTITY",
        ],
        [{ NODE_EXTRA_CA_CERTS: undefined }, "CA_PATH_REQUIRED"],
    ];
    for (const [patch, code] of cases) {
        const f = fixture();
        const result = await f.run({ env: { ...env, ...patch } });
        assert.equal(result.code, `CONFIGURATION/${code}`);
        assert.equal(result.outcome, "REFUSED_BEFORE_BEGIN");
        assert.deepEqual(f.calls, []);
        assert.doesNotMatch(
            JSON.stringify(result),
            /PRIVATE|postgresql:|\.supabase\.co/,
        );
    }
    for (const [readCa, code] of [
        [
            () => {
                throw new Error("PRIVATE");
            },
            "CA_READ",
        ],
        [() => "PRIVATE invalid certificate", "CA_CERTIFICATE"],
    ]) {
        const f = fixture();
        const result = await f.run({ readCa });
        assert.equal(result.code, `CONFIGURATION/${code}`);
        assert.deepEqual(f.calls, []);
    }
});

test("client setup, connection, BEGIN and both insert phases report distinct stages and outcomes", async () => {
    const f = fixture();
    const setup = await f.run({
        createClient: () => {
            throw new Error("PRIVATE");
        },
    });
    assert.equal(setup.code, "CLIENT_SETUP/DETAILS_WITHHELD");
    for (const [options, code, outcome, rollback] of [
        [
            { fail: "connect", errorCode: "28P01" },
            "DATABASE_CONNECTION/DATABASE_AUTHENTICATION",
            "REFUSED_BEFORE_BEGIN",
            "NOT_REQUESTED",
        ],
        [
            { fail: "BEGIN ISOLATION LEVEL SERIALIZABLE", errorCode: "42501" },
            "TRANSACTION_BEGIN/DATABASE_PERMISSION",
            "BEGIN_UNCONFIRMED",
            "CONFIRMED",
        ],
        [
            { fail: "insert", errorCode: "42P01" },
            "FACILITY_TYPES_INSERT/DATABASE_SCHEMA",
            "FAILED_BEFORE_COMMIT",
            "CONFIRMED",
        ],
        [
            { fail: "category", errorCode: "40001" },
            "EQUIPMENT_CATEGORIES_INSERT/SERIALIZATION_CONFLICT",
            "FAILED_BEFORE_COMMIT",
            "CONFIRMED",
        ],
        [
            { badCount: true },
            "FACILITY_TYPES_INSERT/INSERT_CARDINALITY",
            "FAILED_BEFORE_COMMIT",
            "CONFIRMED",
        ],
    ]) {
        const f = fixture(options);
        const result = await f.run();
        assert.equal(result.code, code);
        assert.equal(result.outcome, outcome);
        assert.equal(result.rollback, rollback);
        assert.ok(!f.calls.includes("COMMIT"));
        assert.deepEqual(f.state(), f.initial);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
});

test("rollback and cleanup failures preserve the original code and COMMIT uncertainty", async () => {
    for (const options of [
        { fail: "insert", rollbackFail: true },
        { fail: "insert", badCommand: "ROLLBACK" },
        { fail: "COMMIT", rollbackFail: true },
        { lostCommitAcknowledgement: true, rollbackFail: true },
        { badCommand: "COMMIT" },
    ]) {
        const f = fixture(options);
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(
            result.outcome,
            options.fail === "insert"
                ? "FAILED_BEFORE_COMMIT"
                : "COMMIT_UNCERTAIN",
        );
        if (options.rollbackFail || options.badCommand === "ROLLBACK") {
            assert.equal(result.rollback, "FAILED");
            assert.match(result.rollbackCode, /^TRANSACTION_ROLLBACK\//);
        }
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
    const f = fixture({ fail: "end" });
    const result = await f.run();
    assert.equal(result.outcome, "COMMITTED_CLEANUP_FAILED");
    assert.equal(result.cleanup, "FAILED");
    assert.equal(result.code, "CONNECTION_CLEANUP/DETAILS_WITHHELD");
});

test("driver classifications never print raw errors, SQLSTATEs, inherited properties or arbitrary error codes", async () => {
    for (const [code, reason] of [
        ["CERT_HAS_EXPIRED", "TLS_CERTIFICATE_EXPIRED"],
        ["CERT_NOT_YET_VALID", "TLS_CERTIFICATE_NOT_YET_VALID"],
        ["ERR_TLS_CERT_ALTNAME_INVALID", "TLS_HOSTNAME"],
        ...[
            "DEPTH_ZERO_SELF_SIGNED_CERT",
            "SELF_SIGNED_CERT_IN_CHAIN",
            "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
            "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        ].map((code) => [code, "TLS_CERTIFICATE_UNTRUSTED"]),
        ["28P01", "DATABASE_AUTHENTICATION"],
        ["28000", "DATABASE_AUTHENTICATION"],
        ["42501", "DATABASE_PERMISSION"],
        ["42P01", "DATABASE_SCHEMA"],
        ["42703", "DATABASE_SCHEMA"],
        ["42P10", "DATABASE_CONFLICT_CONSTRAINT"],
        ["23502", "DATABASE_NOT_NULL"],
        ["23503", "DATABASE_FOREIGN_KEY"],
        ["23505", "DATABASE_UNIQUENESS"],
        ["23514", "DATABASE_CHECK"],
        ["22001", "DATABASE_VALUE_LENGTH"],
        ["40001", "SERIALIZATION_CONFLICT"],
        ["40P01", "DEADLOCK"],
        ["55P03", "LOCK_TIMEOUT"],
        ["57014", "STATEMENT_CANCELLED"],
        ["25P02", "TRANSACTION_ABORTED"],
        ["25006", "DATABASE_READ_ONLY"],
        ["53300", "DATABASE_CONNECTION_LIMIT"],
        ["57P01", "DATABASE_SHUTDOWN"],
        ["ENOTFOUND", "NETWORK_DNS"],
        ["EAI_AGAIN", "NETWORK_DNS"],
        ["ECONNREFUSED", "NETWORK_CONNECTION"],
        ["ECONNRESET", "NETWORK_CONNECTION"],
        ["EPIPE", "NETWORK_CONNECTION"],
        ["ETIMEDOUT", "NETWORK_TIMEOUT"],
        ["toString", "DETAILS_WITHHELD"],
        ["__proto__", "DETAILS_WITHHELD"],
        ["PRIVATE-unknown-code", "DETAILS_WITHHELD"],
        [undefined, "DETAILS_WITHHELD"],
    ]) {
        const result = await fixture({
            fail: "connect",
            errorCode: code,
        }).run();
        assert.equal(result.code, `DATABASE_CONNECTION/${reason}`);
        assert.doesNotMatch(
            JSON.stringify(result),
            /PRIVATE|SELECT|INSERT|postgresql:/,
        );
    }
});

test("offline command modes, input errors and environment loading cannot create a client", async () => {
    let reads = 0,
        loads = 0,
        clients = 0;
    const base = {
        args: ["--check-config"],
        env: { ...env },
        isTTY: true,
        readInput: async () => {
            reads++;
            return {
                projectRef,
                approval: `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`,
            };
        },
        loadEnv: () => {
            loads++;
            return {};
        },
        readCa: () => rootCertificates[0],
        createClient: () => {
            clients++;
            throw new Error("PRIVATE must never connect");
        },
    };
    assert.equal((await runLookupCommand(base)).success, true);
    assert.equal(clients, 0);
    for (const [patch, code] of [
        [{ args: ["--unknown"] }, "CLI_VALIDATION/ARGUMENTS"],
        [
            { args: ["--apply"], isTTY: false },
            "CLI_VALIDATION/INTERACTIVE_TERMINAL_REQUIRED",
        ],
        [
            {
                readInput: async () => {
                    throw new Error("PRIVATE");
                },
            },
            "OPERATOR_INPUT/DETAILS_WITHHELD",
        ],
        [
            { readInput: async () => ({ projectRef: "truncated" }) },
            "INPUT_VALIDATION/PROJECT_REFERENCE_FORMAT",
        ],
        [
            {
                args: ["--apply"],
                readInput: async () => ({ projectRef, approval: "APPROVE" }),
            },
            "INPUT_VALIDATION/CONFIRMATION_INCOMPLETE",
        ],
        [
            {
                loadEnv: () => {
                    throw new Error("PRIVATE");
                },
            },
            "ENVIRONMENT_LOADING/DETAILS_WITHHELD",
        ],
        [
            {
                loadEnv: () => ({
                    error: { code: "EACCES", message: "PRIVATE" },
                }),
            },
            "ENVIRONMENT_LOADING/ENVIRONMENT_READ",
        ],
        [
            { loadEnv: () => ({ error: { code: "ENOENT" } }), env: {} },
            "ENVIRONMENT_LOADING/ENVIRONMENT_READ",
        ],
        [
            { env: { ...env, NODE_EXTRA_CA_CERTS: undefined } },
            "CONFIGURATION/CA_PATH_REQUIRED",
        ],
    ]) {
        const result = await runLookupCommand({ ...base, ...patch });
        assert.equal(result.code, code);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
    assert.equal(
        (
            await runLookupCommand({
                ...base,
                loadEnv: () => ({ error: { code: "ENOENT" } }),
            })
        ).success,
        true,
    );
    reads = 0;
    loads = 0;
    assert.equal((await runLookupCommand({ ...base, args: [] })).success, true);
    assert.equal(reads, 0);
    assert.equal(loads, 0);
    assert.equal(clients, 0);
});

test("apply command accepts a complete phrase and loads environment, but rejects whitespace/truncation before loading", async () => {
    const complete = `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`;
    for (const approval of [complete, complete + " ", complete.slice(0, -3)]) {
        const f = fixture();
        let loads = 0,
            clients = 0;
        const commandEnv = {};
        const result = await runLookupCommand({
            args: ["--apply"],
            isTTY: true,
            env: commandEnv,
            readInput: async () => ({ projectRef, approval }),
            loadEnv: () => {
                loads++;
                Object.assign(commandEnv, env);
                return {};
            },
            readCa: () => rootCertificates[0],
            createClient: () => {
                clients++;
                return f.client;
            },
        });
        assert.equal(result.success, approval === complete);
        assert.equal(loads, approval === complete ? 1 : 0);
        assert.equal(clients, approval === complete ? 1 : 0);
    }
});

test("cleanup failures never erase pre-COMMIT errors or uncertain COMMIT codes", async () => {
    for (const [options, code, outcome] of [
        [
            { fail: "connect", endFail: true },
            "DATABASE_CONNECTION/DETAILS_WITHHELD",
            "REFUSED_BEFORE_BEGIN",
        ],
        [
            { fail: "category", rollbackFail: true, endFail: true },
            "EQUIPMENT_CATEGORIES_INSERT/DETAILS_WITHHELD",
            "FAILED_BEFORE_COMMIT",
        ],
        [
            { fail: "COMMIT", endFail: true },
            "TRANSACTION_COMMIT/DETAILS_WITHHELD",
            "COMMIT_UNCERTAIN",
        ],
    ]) {
        const result = await fixture(options).run();
        assert.equal(result.code, code);
        assert.equal(result.outcome, outcome);
        assert.equal(result.cleanup, "FAILED");
        assert.equal(result.cleanupCode, "CONNECTION_CLEANUP/DETAILS_WITHHELD");
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    }
});
