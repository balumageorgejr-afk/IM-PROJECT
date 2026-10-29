const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const { reservationErrorCode } = require("../src/reservation-errors");

test("only allowlisted SQLSTATE diagnostics are mapped without copying private errors", () => {
    for (const [code, expected] of Object.entries({
        R4001: "RESERVATION_INPUT",
        R4011: "RESERVATION_AUTHENTICATION",
        R4031: "RESERVATION_ACCESS",
        R4041: "RESERVATION_NOT_FOUND",
        R4091: "RESERVATION_CONFLICT",
        R5031: "RESERVATION_CONFIGURATION",
        40001: "RESERVATION_CONFLICT",
        "40P01": "RESERVATION_CONFLICT",
    })) {
        for (const error of [
            { code },
            { meta: { code } },
            { meta: { driverAdapterError: { cause: { originalCode: code } } } },
        ])
            assert.equal(reservationErrorCode(error), expected);
    }
    assert.equal(reservationErrorCode({ code: "PRIVATE-fixture" }), null);
    assert.equal(
        reservationErrorCode(
            new Proxy(
                {},
                {
                    get() {
                        throw Error("PRIVATE-fixture");
                    },
                },
            ),
        ),
        null,
    );
});

test("reservation creation uses existing HTTP authentication, trusted actor, parameterized CALL, and confirmed commit", async (t) => {
    const secret = randomBytes(48).toString("hex");
    const roles = [
        "System Administrator",
        "Facility/Maintenance Staff",
        "Faculty / Student Organization Representative",
    ];
    let user, calls, failure, ack, committed;
    const row = {
        reservationId: 707,
        facilityId: 71,
        requestedBy: 37,
        approvedBy: null,
        statusId: 17,
        purpose: "Fixture purpose",
        startDatetime: new Date("2027-01-15T01:00:00Z"),
        endDatetime: new Date("2027-01-15T02:00:00Z"),
        createdAt: new Date("2026-10-26T00:00:00Z"),
        passwordHash: "PRIVATE-fixture",
    };
    function reset() {
        user = {
            userId: 37,
            fname: "Fixture",
            lname: "Writer",
            email: "writer@example.test",
            isActive: true,
            role: { roleId: 91, roleName: roles[0] },
        };
        calls = [];
        failure = null;
        ack = [{ p_reservation_id: 707 }];
        committed = false;
    }
    reset();
    const tx = {
        async $queryRaw(strings, ...values) {
            const sql = strings.join("?").replace(/\s+/g, " ").trim();
            calls.push({ sql, values });
            assert.ok(Object.isFrozen(strings.raw));
            if (sql.startsWith("SELECT set_config")) {
                assert.deepEqual(values, ["37"]);
                return [{ actorId: "37" }];
            }
            assert.equal(
                sql,
                "CALL im101_private.create_reservation(?::integer, ?::text, ?::timestamptz, ?::timestamptz, NULL::integer)",
            );
            if (failure?.stage === "call") throw failure.error;
            return ack;
        },
        reservation: {
            async findFirst(query) {
                calls.push({ query });
                assert.deepEqual(query.where, {
                    reservationId: 707,
                    requestedBy: 37,
                });
                assert.deepEqual(
                    Object.keys(query.select).sort(),
                    Object.keys(row)
                        .filter((key) => key !== "passwordHash")
                        .sort(),
                );
                return { ...row };
            },
        },
    };
    const prisma = {
        user: {
            async findUnique() {
                return user;
            },
        },
        async $transaction(callback, options) {
            calls.push({ options });
            const result = await callback(tx);
            if (failure?.stage === "commit") throw failure.error;
            committed = true;
            return result;
        },
    };
    const server = createApp({
        getPrisma: () => prisma,
        jwtSecret: secret,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const token = () =>
        jwt.sign({}, secret, {
            subject: "37",
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: "15m",
        });
    const payload = {
        facilityId: 71,
        purpose: "  Fixture purpose  ",
        startDatetime: "2027-01-15T09:00:00+08:00",
        endDatetime: "2027-01-15T10:00:00+08:00",
    };
    async function request(
        body = payload,
        authorization = "Bearer " + token(),
        suffix = "",
    ) {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/reservations${suffix}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(authorization ? { Authorization: authorization } : {}),
                },
                body: JSON.stringify(body),
            },
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        const result = await response.json();
        assert.ok(!JSON.stringify(result).includes("PRIVATE"));
        return { status: response.status, body: result };
    }
    await t.test(
        "each approved role creates own Pending request and receives only approved fields after commit",
        async () => {
            for (const role of roles) {
                reset();
                user.role.roleName = role;
                const result = await request();
                assert.equal(result.status, 201);
                assert.equal(committed, true);
                assert.equal(result.body.reservation.requestedBy, 37);
                assert.equal(result.body.reservation.approvedBy, null);
                assert.equal(result.body.reservation.statusId, 17);
                assert.ok(
                    !Object.hasOwn(result.body.reservation, "passwordHash"),
                );
                assert.deepEqual(calls[0].options, {
                    isolationLevel: "Serializable",
                    maxWait: 10000,
                    timeout: 15000,
                });
                assert.deepEqual(calls[2].values, [
                    71,
                    "Fixture purpose",
                    "2027-01-15T01:00:00.000Z",
                    "2027-01-15T02:00:00.000Z",
                ]);
            }
        },
    );
    await t.test(
        "missing invalid authentication inactive deleted and unsupported users never open transactions",
        async () => {
            for (const authorization of [null, "Bearer invalid"]) {
                reset();
                assert.equal(
                    (await request(payload, authorization)).status,
                    401,
                );
                assert.deepEqual(calls, []);
            }
            for (const state of ["inactive", "deleted", "unsupported"]) {
                reset();
                if (state === "inactive") user.isActive = false;
                if (state === "deleted") user = null;
                if (state === "unsupported") user.role.roleName = "Unknown";
                assert.equal(
                    (await request()).status,
                    state === "unsupported" ? 403 : 401,
                );
                assert.deepEqual(calls, []);
            }
        },
    );
    await t.test(
        "forbidden fields malformed data and query actor overrides fail before a transaction",
        async () => {
            for (const patch of [
                { requestedBy: 88 },
                { approvedBy: 88 },
                { statusId: 29 },
                { reservationId: 1 },
                { createdAt: "fixture" },
                { equipment: [] },
                { facilityId: "71" },
                { purpose: "" },
                { endDatetime: payload.startDatetime },
            ]) {
                reset();
                assert.equal(
                    (await request({ ...payload, ...patch })).status,
                    400,
                );
                assert.deepEqual(calls, []);
            }
            reset();
            assert.equal(
                (await request(payload, undefined, "?requestedBy=88")).status,
                400,
            );
            assert.deepEqual(calls, []);
        },
    );
    await t.test(
        "database refusals map only fixed HTTP errors and never report creation success",
        async () => {
            for (const [code, status] of [
                ["R4001", 400],
                ["R4011", 401],
                ["R4031", 403],
                ["R4041", 404],
                ["R4091", 409],
                ["R5031", 503],
                ["PRIVATE", 500],
            ]) {
                reset();
                failure = {
                    stage: "call",
                    error: {
                        code: "P2010",
                        meta: { code },
                        message: "PRIVATE-fixture",
                    },
                };
                assert.equal((await request()).status, status);
                assert.equal(committed, false);
            }
        },
    );
    await t.test(
        "invalid acknowledgements and lost COMMIT responses stop without retries or cleanup writes",
        async () => {
            for (const result of [
                [],
                [{ p_reservation_id: "707" }],
                [{ p_reservation_id: 0 }],
                null,
            ]) {
                reset();
                ack = result;
                assert.equal((await request()).status, 500);
                assert.equal(committed, false);
            }
            reset();
            failure = {
                stage: "commit",
                error: Error("PRIVATE-lost-response"),
            };
            assert.equal((await request()).status, 500);
            assert.equal(calls.filter((call) => call.options).length, 1);
        },
    );
});
