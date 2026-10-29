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
const fields = [
    "reservationId",
    "facilityId",
    "requestedBy",
    "approvedBy",
    "statusId",
    "purpose",
    "startDatetime",
    "endDatetime",
    "createdAt",
];
const select = Object.fromEntries(fields.map((field) => [field, true]));
function row(reservationId, requestedBy) {
    return {
        reservationId,
        facilityId: 71,
        requestedBy,
        approvedBy: reservationId % 2 === 0 ? 901 : null,
        statusId: 19 + (reservationId % 4),
        purpose: `Fixture event ${reservationId}`,
        startDatetime: new Date("2027-01-15T09:00:00+08:00"),
        endDatetime: new Date("2027-01-15T10:00:00+08:00"),
        createdAt: new Date("2026-10-25T00:00:00.000Z"),
    };
}
const initial = [
    row(402, 37),
    row(7, 88),
    row(900, 37),
    row(55, 37),
    row(101, 88),
];
const publicRow = (record) =>
    JSON.parse(
        JSON.stringify(
            Object.fromEntries(fields.map((field) => [field, record[field]])),
        ),
    );
const sorted = (records) =>
    records
        .slice()
        .sort((a, b) => a.reservationId - b.reservationId)
        .map(publicRow);

test("Reservation reads enforce database ownership predicates with mocked Prisma and real HTTP/JWT/RBAC", async (t) => {
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
        rows = structuredClone(initial);
        calls = [];
        failure = null;
        extraFields = false;
    }
    reset();
    const prisma = new Proxy(
        {},
        {
            get: (target, model) => {
                if (String(model).startsWith("$"))
                    return () => {
                        forbidden.push(String(model));
                        throw new Error("PRIVATE-forbidden-database-operation");
                    };
                return new Proxy(
                    {},
                    {
                        get: (delegate, method) => async (query) => {
                            const operation = `${String(model)}.${String(method)}`;
                            if (
                                ![
                                    "user.findUnique",
                                    "reservation.findMany",
                                    "reservation.findFirst",
                                    "reservationStatus.findMany",
                                    "building.findMany",
                                    "facility.findMany",
                                    "equipment.findMany",
                                ].includes(operation)
                            ) {
                                forbidden.push(operation);
                                throw new Error(
                                    "PRIVATE-forbidden-database-operation",
                                );
                            }
                            calls.push({
                                operation,
                                query: structuredClone(query),
                            });
                            if (failure === operation)
                                throw Object.assign(
                                    new Error(
                                        "PRIVATE-SQL-credentials-and-driver-message",
                                    ),
                                    {
                                        code: "P2021",
                                        meta: {
                                            detail: "PRIVATE-driver-detail",
                                        },
                                    },
                                );
                            if (operation === "user.findUnique")
                                return user?.userId === query.where.userId
                                    ? user
                                    : null;
                            if (model === "reservation") {
                                assert.deepEqual(query.select, select);
                                const scope =
                                    user.role.roleName === roles[0]
                                        ? {}
                                        : { requestedBy: user.userId };
                                let matching;
                                if (method === "findFirst") {
                                    assert.ok(
                                        Number.isInteger(
                                            query.where.reservationId,
                                        ) &&
                                            query.where.reservationId > 0 &&
                                            query.where.reservationId <=
                                                2147483647,
                                    );
                                    assert.deepEqual(query, {
                                        where: {
                                            reservationId:
                                                query.where.reservationId,
                                            ...scope,
                                        },
                                        select,
                                    });
                                    matching = rows.filter(
                                        (item) =>
                                            item.reservationId ===
                                            query.where.reservationId,
                                    );
                                } else {
                                    // Assert the ownership restriction is in the SQL-facing query,
                                    // not merely an HTTP response filter after unscoped pagination.
                                    assert.deepEqual(query.where, scope);
                                    assert.deepEqual(query.orderBy, {
                                        reservationId: "asc",
                                    });
                                    assert.ok(
                                        Number.isInteger(query.skip) &&
                                            query.skip >= 0 &&
                                            query.skip <= 2147483647,
                                    );
                                    assert.ok(
                                        Number.isInteger(query.take) &&
                                            query.take >= 2 &&
                                            query.take <= 101,
                                    );
                                    assert.deepEqual(
                                        Object.keys(query).sort(),
                                        [
                                            "where",
                                            "select",
                                            "orderBy",
                                            "skip",
                                            "take",
                                        ].sort(),
                                    );
                                    matching = rows;
                                }
                                matching = matching
                                    .filter(
                                        (item) =>
                                            query.where.requestedBy ===
                                                undefined ||
                                            item.requestedBy ===
                                                query.where.requestedBy,
                                    )
                                    .slice()
                                    .sort(
                                        (a, b) =>
                                            a.reservationId - b.reservationId,
                                    );
                                const project = (item) =>
                                    extraFields
                                        ? structuredClone(item)
                                        : Object.fromEntries(
                                              fields.map((field) => [
                                                  field,
                                                  item[field],
                                              ]),
                                          );
                                if (method === "findFirst")
                                    return matching[0]
                                        ? project(matching[0])
                                        : null;
                                return matching
                                    .slice(query.skip, query.skip + query.take)
                                    .map(project);
                            }
                            if (model === "reservationStatus") {
                                assert.deepEqual(query, {
                                    where: {
                                        statusName: {
                                            in: [
                                                "Pending",
                                                "Approved",
                                                "Rejected",
                                                "Cancelled",
                                            ],
                                        },
                                    },
                                    select: {
                                        statusId: true,
                                        statusName: true,
                                    },
                                    orderBy: { statusId: "asc" },
                                });
                                return [
                                    { statusId: 17, statusName: "Pending" },
                                    { statusId: 99, statusName: "Approved" },
                                ];
                            }
                            assert.equal(query.take, 21);
                            assert.equal(query.skip, 0);
                            return [];
                        },
                    },
                );
            },
        },
    );
    const app = createApp({
        jwtSecret: secret,
        getPrisma: () => {
            if (failure === "factory")
                throw new Error("PRIVATE-connection-configuration");
            return prisma;
        },
    });
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
    const base = `http://127.0.0.1:${server.address().port}`;
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
    async function request(
        path = "",
        { authorization = bearer, headers = {}, body, absolute = false } = {},
    ) {
        const response = await fetch(
            base + (absolute ? path : "/api/reservations" + path),
            {
                headers: {
                    ...(authorization ? { Authorization: authorization } : {}),
                    ...headers,
                },
                signal: AbortSignal.timeout(5000),
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
        );
        const text = await response.text();
        assert.ok(!text.includes("PRIVATE-"));
        assert.ok(!text.includes(secret));
        assert.ok(!text.includes(bearer.slice(7)));
        if (path !== "/api/health")
            assert.equal(response.headers.get("cache-control"), "no-store");
        return { status: response.status, body: JSON.parse(text) };
    }
    const reservationCalls = () =>
        calls.filter((call) => call.operation.startsWith("reservation."));
    function missing(result) {
        assert.deepEqual(result, {
            status: 404,
            body: { success: false, message: "Reservation not found." },
        });
    }
    function rejected(result, status) {
        assert.deepEqual(result, {
            status,
            body: {
                success: false,
                message:
                    status === 401
                        ? "Authentication required."
                        : "Access denied.",
            },
        });
        assert.deepEqual(reservationCalls(), []);
    }
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            await run();
            assert.deepEqual(forbidden, []);
        });
    }

    await scenario(
        "administrator lists all owners and can view another user's reservation",
        async () => {
            assert.deepEqual(await request(), {
                status: 200,
                body: {
                    success: true,
                    reservations: sorted(rows),
                    pagination: { page: 1, limit: 20, hasMore: false },
                },
            });
            assert.deepEqual(reservationCalls()[0].query, {
                where: {},
                select,
                orderBy: { reservationId: "asc" },
                skip: 0,
                take: 21,
            });
            assert.deepEqual(await request("/7"), {
                status: 200,
                body: {
                    success: true,
                    reservation: publicRow(
                        rows.find((item) => item.reservationId === 7),
                    ),
                },
            });
            assert.deepEqual(reservationCalls()[1].query.where, {
                reservationId: 7,
            });
        },
    );
    for (const [index, roleName] of roles.slice(1).entries()) {
        await scenario(
            `${roleName} lists and views only their own records with predicates in both database queries`,
            async () => {
                user.role = { roleId: 731 + index, roleName };
                assert.deepEqual(await request(), {
                    status: 200,
                    body: {
                        success: true,
                        reservations: sorted(
                            rows.filter((item) => item.requestedBy === 37),
                        ),
                        pagination: { page: 1, limit: 20, hasMore: false },
                    },
                });
                assert.deepEqual(reservationCalls()[0].query.where, {
                    requestedBy: 37,
                });
                assert.equal((await request("/402")).status, 200);
                assert.deepEqual(reservationCalls()[1].query.where, {
                    reservationId: 402,
                    requestedBy: 37,
                });
                missing(await request("/7"));
                assert.deepEqual(reservationCalls()[2].query.where, {
                    reservationId: 7,
                    requestedBy: 37,
                });
                missing(await request("/1999"));
            },
        );
        await scenario(
            `${roleName} cannot forge requester or administrator claims, headers or filters`,
            async () => {
                user.role.roleName = roleName;
                const authorization = `Bearer ${token({ roleName: roles[0], roleId: 1, requestedBy: 88, userId: 88 })}`;
                const result = await request("?page=1&limit=100", {
                    authorization,
                    headers: {
                        "X-Role": roles[0],
                        "X-User-Id": "88",
                        "X-Requested-By": "88",
                    },
                });
                assert.deepEqual(
                    result.body.reservations,
                    sorted(rows.filter((item) => item.requestedBy === 37)),
                );
                missing(await request("/7", { authorization }));
                calls = [];
                for (const path of [
                    "?requestedBy=88",
                    "?requestedBy=37",
                    "?userId=88",
                    "?role=System%20Administrator",
                    "/7?requestedBy=37",
                ])
                    assert.equal(
                        (await request(path, { authorization })).status,
                        400,
                    );
                assert.deepEqual(reservationCalls(), []);
            },
        );
    }
    await scenario(
        "a different authenticated user receives their own scope rather than a fixed fixture ID",
        async () => {
            user.userId = 88;
            user.role.roleName = roles[2];
            const authorization = `Bearer ${token({}, { subject: "88" })}`;
            assert.deepEqual(
                (await request("", { authorization })).body.reservations,
                sorted(rows.filter((item) => item.requestedBy === 88)),
            );
            assert.equal((await request("/7", { authorization })).status, 200);
            missing(await request("/402", { authorization }));
            assert.deepEqual(
                reservationCalls().map((call) => call.query.where),
                [
                    { requestedBy: 88 },
                    { reservationId: 7, requestedBy: 88 },
                    { reservationId: 402, requestedBy: 88 },
                ],
            );
        },
    );
    await scenario(
        "nonexistent IDs use the same 404 response for administrators",
        async () => {
            missing(await request("/1999"));
        },
    );
    await scenario(
        "empty tables and owners without records return 200 with no other-user count leakage",
        async () => {
            rows = [];
            assert.deepEqual(await request(), {
                status: 200,
                body: {
                    success: true,
                    reservations: [],
                    pagination: { page: 1, limit: 20, hasMore: false },
                },
            });
            rows = [row(7, 88), row(8, 88)];
            user.role.roleName = roles[1];
            assert.deepEqual(await request(), {
                status: 200,
                body: {
                    success: true,
                    reservations: [],
                    pagination: { page: 1, limit: 20, hasMore: false },
                },
            });
        },
    );
    await scenario(
        "pagination defaults and boundary limits remain bounded",
        async () => {
            rows = Array.from({ length: 125 }, (_, i) => row(1000 - i, 37));
            const first = await request();
            assert.equal(first.body.reservations.length, 20);
            assert.deepEqual(first.body.pagination, {
                page: 1,
                limit: 20,
                hasMore: true,
            });
            assert.deepEqual(reservationCalls().at(-1).query, {
                where: {},
                select,
                orderBy: { reservationId: "asc" },
                skip: 0,
                take: 21,
            });
            assert.equal(
                (await request("?limit=1")).body.reservations.length,
                1,
            );
            assert.equal(reservationCalls().at(-1).query.take, 2);
            const max = await request("?limit=100&page=2");
            assert.equal(max.body.reservations.length, 25);
            assert.deepEqual(max.body.pagination, {
                page: 2,
                limit: 100,
                hasMore: false,
            });
            assert.deepEqual(reservationCalls().at(-1).query, {
                where: {},
                select,
                orderBy: { reservationId: "asc" },
                skip: 100,
                take: 101,
            });
            assert.deepEqual(
                (await request("?page=2147483647&limit=1")).body.pagination,
                { page: 2147483647, limit: 1, hasMore: false },
            );
            assert.equal(reservationCalls().at(-1).query.skip, 2147483646);
            assert.equal(
                (await request("?page=21474837&limit=100")).status,
                200,
            );
            assert.equal(reservationCalls().at(-1).query.skip, 2147483600);
        },
    );
    await scenario(
        "ownership is applied before skip/take and hasMore uses only the owner's extra row",
        async () => {
            user.role.roleName = roles[1];
            rows = [
                row(50, 37),
                row(70, 37),
                ...Array.from({ length: 110 }, (_, i) => row(i + 100, 88)),
            ];
            let result = await request("?limit=2");
            assert.deepEqual(
                result.body.reservations.map((item) => item.reservationId),
                [50, 70],
            );
            assert.deepEqual(result.body.pagination, {
                page: 1,
                limit: 2,
                hasMore: false,
            });
            rows.push(row(900, 37));
            result = await request("?limit=2");
            assert.equal(result.body.pagination.hasMore, true);
            result = await request("?page=2&limit=2");
            assert.deepEqual(
                result.body.reservations.map((item) => item.reservationId),
                [900],
            );
            assert.deepEqual(result.body.pagination, {
                page: 2,
                limit: 2,
                hasMore: false,
            });
            assert.deepEqual(reservationCalls().at(-1).query, {
                where: { requestedBy: 37 },
                select,
                orderBy: { reservationId: "asc" },
                skip: 2,
                take: 3,
            });
            assert.deepEqual(Object.keys(result.body.pagination).sort(), [
                "hasMore",
                "limit",
                "page",
            ]);
        },
    );
    await scenario(
        "unique-ID ordering is deterministic even when all timestamps tie",
        async () => {
            const first = await request("?limit=2");
            const second = await request("?page=2&limit=2");
            const repeated = await request("?limit=2");
            assert.deepEqual(
                first.body.reservations.map((item) => item.reservationId),
                [7, 55],
            );
            assert.deepEqual(
                second.body.reservations.map((item) => item.reservationId),
                [101, 402],
            );
            assert.deepEqual(repeated, first);
            for (const call of reservationCalls())
                assert.deepEqual(call.query.orderBy, { reservationId: "asc" });
        },
    );
    await scenario(
        "invalid, repeated and unsupported pagination/filter parameters are rejected before reservation access",
        async () => {
            for (const path of [
                "?page=0",
                "?page=-1",
                "?page=",
                "?page=01",
                "?page=1.5",
                "?page=1e2",
                "?page=NaN",
                "?page=2147483648",
                "?page=99999999999999999999",
                "?page=%201",
                "?page=%2B1",
                "?page=1&page=2",
                "?page[]=1",
                "?page[gt]=1",
                "?limit=0",
                "?limit=-1",
                "?limit=",
                "?limit=01",
                "?limit=1.0",
                "?limit=101",
                "?limit=1&limit=2",
                "?page=21474838&limit=100",
                "?page=2147483647&limit=2",
                "?facilityId=71",
                "?statusId=19",
                "?requestedBy=37",
                "?include=user",
                "?orderBy=createdAt",
            ]) {
                assert.deepEqual(await request(path), {
                    status: 400,
                    body: {
                        success: false,
                        message: "Invalid reservation input or pagination.",
                    },
                });
            }
            assert.deepEqual(reservationCalls(), []);
        },
    );
    await scenario(
        "malformed and overflowing reservation IDs and detail query parameters never reach the lookup",
        async () => {
            for (const id of [
                "0",
                "-1",
                "-0",
                "01",
                "1.5",
                "1.0",
                "1e2",
                "0x10",
                "abc",
                "null",
                "NaN",
                "+1",
                "%201",
                "1%20",
                "1%2F2",
                "2147483648",
                "999999999999999999999",
            ])
                assert.equal((await request("/" + id)).status, 400);
            for (const path of [
                "/402?page=1",
                "/402?requestedBy=37",
                "/402?include=user",
            ])
                assert.equal((await request(path)).status, 400);
            assert.deepEqual(reservationCalls(), []);
            rows.push(row(2147483647, 37));
            assert.equal((await request("/2147483647")).status, 200);
            assert.equal(
                reservationCalls()[0].query.where.reservationId,
                2147483647,
            );
        },
    );
    await scenario(
        "both endpoints reject missing, malformed, forged and expired authentication before database reads",
        async () => {
            for (const authorization of [
                null,
                "Bearer invalid",
                "Basic fixture",
                `Bearer ${jwt.sign({}, randomBytes(48).toString("hex"), { subject: "37" })}`,
                `Bearer ${token({}, { expiresIn: -1 })}`,
                `Bearer ${token({}, { subject: "invalid" })}`,
            ])
                for (const path of ["", "/402"])
                    rejected(await request(path, { authorization }), 401);
            assert.deepEqual(calls, []);
        },
    );
    await scenario(
        "both endpoints reject inactive and deleted users",
        async () => {
            user.isActive = false;
            for (const path of ["", "/402"]) rejected(await request(path), 401);
            user = null;
            for (const path of ["", "/402"]) rejected(await request(path), 401);
        },
    );
    await scenario(
        "unsupported and incorrectly cased roles cannot access either endpoint",
        async () => {
            for (const roleName of [
                "Guest",
                "system administrator",
                "System Administrator ",
            ]) {
                user.role = { roleId: 1, roleName };
                for (const path of ["", "/402"])
                    rejected(await request(path), 403);
            }
        },
    );
    await scenario(
        "a reused token immediately follows database role changes without granting an admin bypass",
        async () => {
            assert.equal(
                (await request()).body.reservations.length,
                rows.length,
            );
            user.role.roleName = roles[2];
            assert.deepEqual(
                (await request()).body.reservations,
                sorted(rows.filter((item) => item.requestedBy === 37)),
            );
            missing(await request("/7"));
            user.role.roleName = "Guest";
            calls = [];
            rejected(await request(), 403);
            rejected(await request("/402"), 403);
        },
    );
    await scenario(
        "exact field projection excludes related users, authentication and equipment data",
        async () => {
            rows = [
                {
                    ...row(402, 37),
                    user: { passwordHash: "PRIVATE-hash" },
                    requester: { email: "PRIVATE-email" },
                    equipmentItems: [{ token: "PRIVATE-token" }],
                    passwordHash: "PRIVATE-hash",
                    token: "PRIVATE-token",
                    other: "PRIVATE-value",
                },
            ];
            extraFields = true;
            const list = await request();
            const detail = await request("/402");
            assert.deepEqual(list.body.reservations, [publicRow(rows[0])]);
            assert.deepEqual(detail.body, {
                success: true,
                reservation: publicRow(rows[0]),
            });
            assert.deepEqual(Object.keys(detail.body.reservation), fields);
            for (const call of reservationCalls())
                assert.deepEqual(call.query.select, select);
        },
    );
    await scenario(
        "timestamps use Prisma Date JSON conventions and null approvers stay null",
        async () => {
            const result = (await request("/55")).body.reservation;
            assert.equal(result.approvedBy, null);
            assert.equal(result.startDatetime, "2027-01-15T01:00:00.000Z");
            assert.equal(result.endDatetime, "2027-01-15T02:00:00.000Z");
            assert.equal(result.createdAt, "2026-10-25T00:00:00.000Z");
        },
    );
    await scenario(
        "factory, authentication and reservation query errors are sanitized",
        async () => {
            for (const [stage, path] of [
                ["factory", ""],
                ["user.findUnique", ""],
                ["reservation.findMany", ""],
                ["reservation.findFirst", "/402"],
            ]) {
                failure = stage;
                calls = [];
                assert.deepEqual(await request(path), {
                    status: 500,
                    body: { success: false, message: "Internal server error." },
                });
                if (["factory", "user.findUnique"].includes(stage))
                    assert.deepEqual(reservationCalls(), []);
            }
        },
    );
    await scenario(
        "new routes coexist with Task 1, health and existing management list endpoints",
        async () => {
            assert.deepEqual(
                (await request("/api/reservation-statuses", { absolute: true }))
                    .body,
                {
                    success: true,
                    reservationStatuses: [
                        { statusId: 17, statusName: "Pending" },
                        { statusId: 99, statusName: "Approved" },
                    ],
                },
            );
            assert.equal(
                (await request("/api/health", { absolute: true })).status,
                200,
            );
            for (const collection of ["buildings", "facilities", "equipment"]) {
                const result = await request(`/api/${collection}`, {
                    absolute: true,
                });
                assert.deepEqual(result, {
                    status: 200,
                    body: {
                        success: true,
                        [collection]: [],
                        pagination: { page: 1, limit: 20, hasMore: false },
                    },
                });
            }
            assert.deepEqual(reservationCalls(), []);
        },
    );
    await scenario(
        "unsupported editing and deletion methods remain absent and cannot mutate fixtures",
        async () => {
            const before = structuredClone(rows);
            for (const method of ["PUT", "PATCH", "DELETE"])
                for (const path of [
                    "",
                    "/402",
                    "/402/approve",
                    "/402/reject",
                    "/402/cancel",
                ]) {
                    const response = await fetch(
                        base + "/api/reservations" + path,
                        {
                            method,
                            headers: { Authorization: bearer },
                            signal: AbortSignal.timeout(5000),
                        },
                    );
                    await response.text();
                    assert.equal(response.status, 404);
                }
            assert.deepEqual(calls, []);
            assert.deepEqual(rows, before);
            assert.deepEqual(forbidden, []);
        },
    );
});
