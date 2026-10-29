const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const names = ["Pending", "Approved", "Rejected", "Cancelled"];
const statuses = [
    { statusId: 819, statusName: "Pending" },
    { statusId: 41, statusName: "Approved" },
    { statusId: 70012, statusName: "Rejected" },
    { statusId: 2147483647, statusName: "Cancelled" },
];

test("Reservation statuses use injected database reads and real local HTTP/JWT/RBAC", async (t) => {
    const secret = randomBytes(48).toString("hex");
    let user, rows, calls, failure, extraFields;
    const forbidden = [];
    function reset() {
        user = {
            userId: 37,
            fname: "Fixture",
            lname: "Reader",
            email: "reader@example.test",
            isActive: true,
            role: { roleId: 901, roleName: roles[0] },
        };
        rows = structuredClone(statuses);
        calls = [];
        failure = null;
        extraFields = false;
    }
    reset();
    const prisma = new Proxy(
        {},
        {
            get: (target, model) => {
                if (
                    model === "$transaction" ||
                    model === "$queryRaw" ||
                    model === "$executeRaw"
                ) {
                    return () => {
                        forbidden.push(String(model));
                        throw new Error(
                            "PRIVATE-unexpected-database-operation",
                        );
                    };
                }
                return new Proxy(
                    {},
                    {
                        get: (delegate, method) => async (query) => {
                            const operation = `${String(model)}.${String(method)}`;
                            if (
                                ![
                                    "user.findUnique",
                                    "reservationStatus.findMany",
                                ].includes(operation)
                            ) {
                                forbidden.push(operation);
                                throw new Error(
                                    "PRIVATE-unexpected-database-operation",
                                );
                            }
                            calls.push({
                                operation,
                                query: structuredClone(query),
                            });
                            if (failure === model)
                                throw Object.assign(
                                    new Error(
                                        "PRIVATE-SQL-and-database-credentials",
                                    ),
                                    {
                                        code: "PRIVATE-driver-code",
                                        detail: "PRIVATE-driver-details",
                                    },
                                );
                            if (model === "user") {
                                assert.deepEqual(query.where, { userId: 37 });
                                return user;
                            }
                            assert.deepEqual(query, {
                                where: { statusName: { in: names } },
                                select: { statusId: true, statusName: true },
                                orderBy: { statusId: "asc" },
                            });
                            return rows
                                .filter((row) =>
                                    query.where.statusName.in.includes(
                                        row.statusName,
                                    ),
                                )
                                .slice()
                                .sort((a, b) => a.statusId - b.statusId)
                                .map((row) =>
                                    extraFields
                                        ? { ...row }
                                        : Object.fromEntries(
                                              Object.keys(query.select).map(
                                                  (field) => [
                                                      field,
                                                      row[field],
                                                  ],
                                              ),
                                          ),
                                );
                        },
                    },
                );
            },
        },
    );
    const app = createApp({ jwtSecret: secret, getPrisma: () => prisma });
    const server = app.listen(0, "127.0.0.1");
    t.after(async () => {
        await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api/reservation-statuses`;
    const token = (claims = {}, options = {}) =>
        jwt.sign(claims, secret, {
            algorithm: "HS256",
            subject: "37",
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: "15m",
            ...options,
        });
    const bearer = `Bearer ${token()}`;
    async function request({
        authorization = bearer,
        path = "",
        headers = {},
    } = {}) {
        const response = await fetch(base + path, {
            headers: {
                ...(authorization ? { Authorization: authorization } : {}),
                ...headers,
            },
            signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.ok(!text.includes("PRIVATE-"));
        assert.ok(!text.includes(secret));
        assert.ok(!text.includes(bearer.slice(7)));
        return { status: response.status, body: JSON.parse(text) };
    }
    function rejected(result, status) {
        assert.equal(result.status, status);
        assert.deepEqual(result.body, {
            success: false,
            message:
                status === 401 ? "Authentication required." : "Access denied.",
        });
        assert.equal(
            calls.filter(
                (call) => call.operation === "reservationStatus.findMany",
            ).length,
            0,
        );
    }
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            await run();
            assert.deepEqual(forbidden, []);
        });
    }
    for (const [index, roleName] of roles.entries()) {
        await scenario(
            `${roleName} reads all four statuses using actual nonstandard IDs`,
            async () => {
                user.role = { roleId: 901 + index, roleName };
                const result = await request();
                assert.equal(result.status, 200);
                assert.deepEqual(result.body, {
                    success: true,
                    reservationStatuses: statuses
                        .slice()
                        .sort((a, b) => a.statusId - b.statusId),
                });
                assert.deepEqual(
                    calls.map((call) => call.operation),
                    ["user.findUnique", "reservationStatus.findMany"],
                );
            },
        );
    }
    await scenario(
        "empty lookup returns 200 with an empty list and no inserted defaults",
        async () => {
            rows = [];
            assert.deepEqual(await request(), {
                status: 200,
                body: { success: true, reservationStatuses: [] },
            });
            assert.deepEqual(rows, []);
        },
    );
    await scenario(
        "each partial lookup returns only the actual matching records",
        async () => {
            for (const partial of [
                [statuses[0]],
                [statuses[2], statuses[1]],
                [statuses[3], statuses[1], statuses[0]],
            ]) {
                rows = structuredClone(partial);
                assert.deepEqual(await request(), {
                    status: 200,
                    body: {
                        success: true,
                        reservationStatuses: partial
                            .slice()
                            .sort((a, b) => a.statusId - b.statusId),
                    },
                });
                assert.deepEqual(rows, partial);
            }
        },
    );
    await scenario(
        "unrelated, differently cased and padded names are excluded",
        async () => {
            rows.push(
                ...[
                    "Draft",
                    "Completed",
                    "pending",
                    " Approved ",
                    "Available",
                ].map((statusName, i) => ({ statusId: i + 2, statusName })),
            );
            const before = structuredClone(rows);
            assert.deepEqual(
                (await request()).body.reservationStatuses,
                statuses.slice().sort((a, b) => a.statusId - b.statusId),
            );
            assert.deepEqual(rows, before);
            rows = [{ statusId: 933, statusName: "Completed" }];
            assert.deepEqual(await request(), {
                status: 200,
                body: { success: true, reservationStatuses: [] },
            });
        },
    );
    await scenario(
        "only the two approved fields are selected and serialized",
        async () => {
            rows = [
                {
                    statusId: 867,
                    statusName: "Pending",
                    passwordHash: "PRIVATE-field",
                    reservations: [{ purpose: "PRIVATE-purpose" }],
                },
            ];
            extraFields = true;
            assert.deepEqual(await request(), {
                status: 200,
                body: {
                    success: true,
                    reservationStatuses: [
                        { statusId: 867, statusName: "Pending" },
                    ],
                },
            });
        },
    );
    await scenario(
        "missing, malformed, forged and expired tokens cannot query statuses",
        async () => {
            for (const authorization of [
                null,
                "Bearer invalid",
                "Basic fixture",
                `Bearer ${jwt.sign({}, randomBytes(48).toString("hex"), { subject: "37" })}`,
                `Bearer ${token({}, { expiresIn: -1 })}`,
            ]) {
                rejected(await request({ authorization }), 401);
            }
            assert.equal(calls.length, 0);
        },
    );
    await scenario(
        "inactive and deleted users cannot query statuses",
        async () => {
            user.isActive = false;
            rejected(await request(), 401);
            user = null;
            rejected(await request(), 401);
            assert.equal(calls.length, 2);
        },
    );
    await scenario(
        "unknown roles and role spoofing cannot query statuses",
        async () => {
            for (const roleName of [
                "Guest",
                "system administrator",
                "System Administrator ",
            ]) {
                user.role = { roleId: 1, roleName };
                rejected(
                    await request({
                        authorization: `Bearer ${token({ role: roles[0], roleName: roles[0], roleId: 1 })}`,
                        headers: { "X-Role": roles[0] },
                    }),
                    403,
                );
            }
        },
    );
    await scenario(
        "the same token follows current database role and active-state changes",
        async () => {
            assert.equal((await request()).status, 200);
            calls = [];
            user.role.roleName = "Guest";
            rejected(await request(), 403);
            user.role.roleName = roles[1];
            assert.equal((await request()).status, 200);
            calls = [];
            user.isActive = false;
            rejected(await request(), 401);
        },
    );
    await scenario(
        "lookup and authentication failures return sanitized 500 responses",
        async () => {
            for (const stage of ["reservationStatus", "user"]) {
                calls = [];
                failure = stage;
                assert.deepEqual(await request(), {
                    status: 500,
                    body: { success: false, message: "Internal server error." },
                });
                if (stage === "user") assert.equal(calls.length, 1);
            }
        },
    );
    await scenario(
        "unsupported filters cannot change the fixed lookup query",
        async () => {
            for (const path of [
                "?statusName=Draft",
                "?limit=1",
                "?orderBy=desc",
                "?requestedBy=99",
            ]) {
                assert.deepEqual(await request({ path }), {
                    status: 400,
                    body: {
                        success: false,
                        message: "Invalid reservation status query.",
                    },
                });
            }
            assert.equal(
                calls.filter(
                    (call) => call.operation === "reservationStatus.findMany",
                ).length,
                0,
            );
        },
    );
    await scenario(
        "no write endpoints or reservation operations are exposed",
        async () => {
            const before = structuredClone(rows);
            for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
                const response = await fetch(base, {
                    method,
                    headers: { Authorization: bearer },
                    signal: AbortSignal.timeout(5000),
                });
                await response.text();
                assert.equal(response.status, 404);
            }
            assert.deepEqual(calls, []);
            assert.deepEqual(rows, before);
            assert.deepEqual(forbidden, []);
        },
    );
});
