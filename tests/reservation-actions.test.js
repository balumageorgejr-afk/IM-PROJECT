const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

test("reservation transition HTTP security with transaction-only mocked procedures", async (t) => {
    const secret = randomBytes(48).toString("hex");
    const roles = [
        "System Administrator",
        "Facility/Maintenance Staff",
        "Faculty / Student Organization Representative",
    ];
    let user, calls, failure, ack;
    function reset() {
        user = {
            userId: 37,
            fname: "Fixture",
            lname: "Reviewer",
            email: "reviewer@example.test",
            isActive: true,
            role: { roleId: 91, roleName: roles[0] },
        };
        calls = [];
        failure = null;
        ack = [{ p_result_id: 707 }];
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
            assert.ok(
                [
                    "CALL im101_private.approve_reservation(?::integer, NULL::integer)",
                    "CALL im101_private.reject_reservation(?::integer, NULL::integer)",
                    "CALL im101_private.cancel_reservation(?::integer, NULL::integer)",
                ].includes(sql),
            );
            assert.deepEqual(values, [707]);
            if (failure) throw failure;
            return ack;
        },
        reservation: {
            async findFirst(query) {
                assert.deepEqual(query.where, {
                    reservationId: 707,
                    ...(user.role.roleName === roles[0]
                        ? {}
                        : { requestedBy: 37 }),
                });
                assert.equal(Object.keys(query.select).length, 9);
                return {
                    reservationId: 707,
                    facilityId: 71,
                    requestedBy: user.role.roleName === roles[0] ? 88 : 37,
                    approvedBy: calls.at(-1).sql.includes("reject_reservation")
                        ? null
                        : 37,
                    statusId: calls.at(-1).sql.includes("cancel_reservation")
                        ? 53
                        : calls.at(-1).sql.includes("reject_reservation")
                          ? 41
                          : 29,
                    purpose: "Fixture",
                    startDatetime: new Date("2027-01-15T00:00:00Z"),
                    endDatetime: new Date("2027-01-15T01:00:00Z"),
                    createdAt: new Date("2026-10-26T00:00:00Z"),
                    passwordHash: "PRIVATE-fixture",
                };
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
            return callback(tx);
        },
    };
    const server = createApp({
        getPrisma: () => prisma,
        jwtSecret: secret,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const bearer = () =>
        "Bearer " +
        jwt.sign({}, secret, {
            subject: "37",
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: "15m",
        });
    async function request(
        path = "707/approve",
        body = {},
        authorization = bearer(),
        contentType = "application/json",
    ) {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/reservations/${path}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": contentType,
                    ...(authorization ? { Authorization: authorization } : {}),
                },
                body: JSON.stringify(body),
            },
        );
        const result = await response.json();
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.ok(!JSON.stringify(result).includes("PRIVATE"));
        return { status: response.status, body: result };
    }
    await t.test(
        "administrator approval calls fixed procedure with exact ID and projected response",
        async () => {
            reset();
            const response = await request();
            assert.equal(response.status, 200);
            assert.equal(response.body.reservation.reservationId, 707);
            assert.ok(
                !Object.hasOwn(response.body.reservation, "passwordHash"),
            );
            assert.equal(calls.length, 3);
        },
    );
    await t.test(
        "administrator rejection preserves a null approver in the projected result",
        async () => {
            reset();
            const result = await request("707/reject");
            assert.equal(result.status, 200);
            assert.equal(result.body.reservation.statusId, 41);
            assert.equal(result.body.reservation.approvedBy, null);
            for (const role of roles.slice(1)) {
                reset();
                user.role.roleName = role;
                assert.equal((await request("707/reject")).status, 403);
                assert.deepEqual(calls, []);
            }
        },
    );
    await t.test(
        "all approved roles can request cancellation with scoped response reads",
        async () => {
            for (const role of roles) {
                reset();
                user.role.roleName = role;
                const response = await request("707/cancel");
                assert.equal(response.status, 200);
                assert.equal(response.body.reservation.statusId, 53);
                assert.equal(response.body.reservation.approvedBy, 37);
            }
            reset();
            user.role.roleName = "Unknown";
            assert.equal((await request("707/cancel")).status, 403);
            assert.deepEqual(calls, []);
            reset();
            user.role.roleName = roles[1];
            failure = {
                code: "P2010",
                meta: { code: "R4041" },
                message: "PRIVATE-fixture",
            };
            assert.equal((await request("707/cancel")).status, 404);
        },
    );
    await t.test(
        "staff representative and unsupported roles cannot approve",
        async () => {
            for (const role of [...roles.slice(1), "Unknown"]) {
                reset();
                user.role.roleName = role;
                assert.equal((await request()).status, 403);
                assert.deepEqual(calls, []);
            }
        },
    );
    await t.test(
        "missing invalid authentication inactive and deleted users cannot transition",
        async () => {
            for (const auth of [null, "Bearer invalid"]) {
                reset();
                assert.equal((await request(undefined, {}, auth)).status, 401);
                assert.deepEqual(calls, []);
            }
            for (const state of ["inactive", "deleted"]) {
                reset();
                if (state === "inactive") user.isActive = false;
                else user = null;
                assert.equal((await request()).status, 401);
                assert.deepEqual(calls, []);
            }
        },
    );
    await t.test(
        "IDs transition payloads and query overrides are strictly rejected before transaction",
        async () => {
            for (const id of [
                "0",
                "-1",
                "01",
                "1.5",
                "2147483648",
                "abc",
                "1e2",
            ]) {
                reset();
                assert.equal((await request(id + "/approve")).status, 400);
                assert.deepEqual(calls, []);
            }
            for (const body of [
                null,
                [],
                true,
                { requestedBy: 37 },
                { approvedBy: 37 },
                { statusId: 29 },
                { purpose: "edited" },
            ]) {
                reset();
                assert.equal((await request(undefined, body)).status, 400);
                assert.deepEqual(calls, []);
            }
            reset();
            assert.equal((await request("707/approve?actor=37")).status, 400);
            assert.deepEqual(calls, []);
        },
    );
    await t.test(
        "non-JSON transition bodies cannot bypass strict field rejection",
        async () => {
            for (const action of ["approve", "reject", "cancel"]) {
                reset();
                assert.equal(
                    (
                        await request(
                            "707/" + action,
                            { requestedBy: 37 },
                            undefined,
                            "text/plain",
                        )
                    ).status,
                    400,
                );
                assert.deepEqual(calls, []);
            }
        },
    );
    await t.test(
        "business refusals serialization and unknown failures remain sanitized with no retry",
        async () => {
            for (const [code, status] of [
                ["R4031", 403],
                ["R4041", 404],
                ["R4091", 409],
                ["R5031", 503],
                ["40001", 409],
                ["40P01", 409],
                ["PRIVATE", 500],
            ]) {
                reset();
                failure = {
                    code: "P2010",
                    meta: { code },
                    message: "PRIVATE-fixture",
                };
                assert.equal((await request()).status, status);
                assert.equal(calls.filter((call) => call.options).length, 1);
            }
        },
    );
    await t.test(
        "mismatched result ID is rejected before reading a reservation",
        async () => {
            reset();
            ack = [{ p_result_id: 708 }];
            assert.equal((await request()).status, 500);
        },
    );
});
