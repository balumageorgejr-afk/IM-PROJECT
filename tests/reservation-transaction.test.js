const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
    createReservationTransaction,
} = require("../src/reservation-transaction");

const privateFixture = "PRIVATE-synthetic-driver-and-request-detail";
function harness(options = {}) {
    const calls = [];
    const tx = {
        async $queryRaw(strings, ...values) {
            calls.push({ type: "context", strings: [...strings], values });
            assert.ok(Object.isFrozen(strings.raw));
            assert.equal(
                strings.join("?").replace(/\s+/g, " ").trim(),
                "SELECT set_config('im101.actor_id', ?, true) AS \"actorId\"",
            );
            assert.equal(values.length, 1);
            if (options.contextError) throw options.contextError;
            return Object.hasOwn(options, "contextResult")
                ? options.contextResult
                : [{ actorId: values[0] }];
        },
    };
    const run = createReservationTransaction({
        getPrisma() {
            calls.push({ type: "getPrisma" });
            if (options.getError) throw options.getError;
            return new Proxy(
                {
                    async $transaction(callback, settings) {
                        calls.push({ type: "transaction", settings });
                        if (options.beginError) throw options.beginError;
                        try {
                            const value = await callback(tx);
                            calls.push({ type: "callbackResolved" });
                            if (options.commitError) throw options.commitError;
                            return value;
                        } catch (error) {
                            calls.push({ type: "transactionRejected", error });
                            throw error;
                        }
                    },
                },
                {
                    get(target, key) {
                        assert.equal(key, "$transaction");
                        return target[key];
                    },
                },
            );
        },
    });
    return { run, tx, calls };
}
function sanitized(code) {
    return (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.code, code);
        assert.equal(
            error.message,
            "Reservation transaction could not be completed.",
        );
        assert.deepEqual(Object.keys(error), ["code"]);
        assert.equal(error.cause, undefined);
        assert.ok(!String(error.stack).includes(privateFixture));
        assert.ok(!JSON.stringify(error).includes(privateFixture));
        return true;
    };
}

test("context precedes awaited callback on the same transaction client with fixed Serializable limits", async () => {
    const { run, tx, calls } = harness();
    const value = await run({ userId: 37 }, async (client) => {
        assert.equal(client, tx);
        assert.equal(calls.at(-1).type, "context");
        await Promise.resolve();
        calls.push({ type: "operation" });
        return { result: "fixture" };
    });
    assert.deepEqual(value, { result: "fixture" });
    assert.deepEqual(
        calls.map((call) => call.type),
        [
            "getPrisma",
            "transaction",
            "context",
            "operation",
            "callbackResolved",
        ],
    );
    assert.deepEqual(calls[1].settings, {
        isolationLevel: "Serializable",
        maxWait: 10000,
        timeout: 15000,
    });
    assert.deepEqual(calls[2].values, ["37"]);
});

test("missing, malformed, nonnumeric and out-of-range actor contexts fail before accessing Prisma", async () => {
    let invoked = 0;
    const { run, calls } = harness();
    const getter = {};
    Object.defineProperty(getter, "userId", {
        get() {
            invoked++;
            throw Error(privateFixture);
        },
    });
    const hostile = new Proxy(
        {},
        {
            getOwnPropertyDescriptor() {
                throw Error(privateFixture);
            },
        },
    );
    for (const actor of [
        undefined,
        null,
        37,
        "37",
        [],
        {},
        { body: { userId: 37 } },
        { query: { userId: 37 } },
        { headers: { userId: 37 } },
        Object.create({ userId: 37 }),
        getter,
        hostile,
        ...[
            undefined,
            null,
            0,
            -0,
            -1,
            1.5,
            2147483648,
            Number.MAX_SAFE_INTEGER,
            NaN,
            Infinity,
            "37",
            true,
            [],
            {},
            1n,
        ].map((userId) => ({ userId })),
    ]) {
        await assert.rejects(
            run(actor, () => {
                invoked++;
            }),
            sanitized("INVALID_ACTOR_CONTEXT"),
        );
    }
    assert.equal(invoked, 0);
    assert.deepEqual(calls, []);
});

test("actor boundaries and sequential actors use distinct bound text values without shared actor state", async () => {
    const { run, calls } = harness();
    for (const userId of [1, 2147483647, 37, 88])
        await run({ userId }, () => undefined);
    assert.deepEqual(
        calls
            .filter((call) => call.type === "context")
            .map((call) => call.values),
        [["1"], ["2147483647"], ["37"], ["88"]],
    );
    assert.equal(calls.filter((call) => call.type === "transaction").length, 4);
});

test("actor ID is captured before asynchronous work and is not reread from a changed profile", async () => {
    const { run, calls } = harness();
    const actor = { userId: 37 };
    const pending = run(actor, () => undefined);
    actor.userId = 88;
    await pending;
    assert.deepEqual(calls.find((call) => call.type === "context").values, [
        "37",
    ]);
});

test("invalid callbacks and dependencies fail closed with sanitized configuration diagnostics", async () => {
    for (const getPrisma of [undefined, null, 1, {}])
        assert.throws(
            () => createReservationTransaction({ getPrisma }),
            sanitized("INVALID_TRANSACTION_CONFIGURATION"),
        );
    const { run, calls } = harness();
    for (const callback of [undefined, null, 1, {}])
        await assert.rejects(
            run({ userId: 37 }, callback),
            sanitized("INVALID_TRANSACTION_OPERATION"),
        );
    assert.deepEqual(calls, []);
});

test("context failures and missing or mismatched acknowledgements prevent callback execution", async () => {
    const options = [
        { contextError: Error(privateFixture) },
        ...[
            undefined,
            null,
            [],
            [{}],
            [{ actorId: 37 }],
            [{ actorId: "88" }],
            [{ actorId: "37" }, { actorId: "37" }],
        ].map((contextResult) => ({ contextResult })),
    ];
    for (const option of options) {
        const { run, calls } = harness(option);
        let invoked = false;
        await assert.rejects(
            run({ userId: 37 }, () => {
                invoked = true;
            }),
            sanitized("ACTOR_CONTEXT_FAILED"),
        );
        assert.equal(invoked, false);
        assert.equal(calls.at(-1).type, "transactionRejected");
        assert.equal(
            calls.filter((call) => call.type === "transaction").length,
            1,
        );
    }
});

test("sync throws and async callback rejections reject the transaction without leaking original errors or retrying", async () => {
    for (const callback of [
        () => {
            throw Error(privateFixture);
        },
        async () => {
            throw { message: privateFixture };
        },
    ]) {
        const { run, calls } = harness();
        await assert.rejects(
            run({ userId: 37 }, callback),
            sanitized("TRANSACTION_CALLBACK_FAILED"),
        );
        assert.equal(calls.at(-1).type, "transactionRejected");
        assert.equal(calls.filter((call) => call.type === "context").length, 1);
        assert.ok(!calls.some((call) => call.type === "callbackResolved"));
    }
});

test("acquisition, serialization, timeout and uncertain completion failures are sanitized and never retried", async () => {
    for (const option of [
        { getError: Error(privateFixture) },
        { beginError: Error(privateFixture) },
        {
            commitError: Object.assign(Error(privateFixture), {
                code: "P2034",
            }),
        },
        {
            commitError: Object.assign(Error(privateFixture), {
                code: "P2028",
            }),
        },
        {
            commitError: {
                message: privateFixture,
                connection: privateFixture,
            },
        },
    ]) {
        const { run, calls } = harness(option);
        let invoked = 0;
        await assert.rejects(
            run({ userId: 37 }, () => {
                invoked++;
            }),
            sanitized(
                option.commitError?.code === "P2034"
                    ? "RESERVATION_CONFLICT"
                    : "TRANSACTION_FAILED",
            ),
        );
        assert.equal(
            calls.filter((call) => call.type === "getPrisma").length,
            1,
        );
        assert.ok(invoked <= 1);
        assert.ok(
            calls.filter((call) => call.type === "transaction").length <= 1,
        );
    }
});

test("gateway imports no live connection or environment and logs nothing; SQL identifiers and local scope are fixed", async () => {
    const source = fs.readFileSync("src/reservation-transaction.js", "utf8");
    const forbidden = () => {
        throw Error("UNEXPECTED_EXTERNAL_ACCESS");
    };
    const context = vm.createContext({
        module: { exports: {} },
        require: (name) => {
            assert.equal(name, "./reservation-errors");
            return require("../src/reservation-errors");
        },
        console: new Proxy({}, { get: forbidden }),
        fetch: forbidden,
        process: new Proxy({}, { get: forbidden }),
    });
    vm.runInContext(source, context);
    const { tx, calls } = harness();
    const run = context.module.exports.createReservationTransaction({
        getPrisma: () => ({ $transaction: async (callback) => callback(tx) }),
    });
    await run({ userId: 37 }, (client) => {
        assert.equal(client, tx);
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].values, ["37"]);
    assert.ok(!source.includes("$queryRawUnsafe"));
    assert.ok(!source.includes("$executeRawUnsafe"));
});
