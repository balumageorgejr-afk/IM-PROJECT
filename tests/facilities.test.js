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
const select = {
    facilityId: true,
    buildingId: true,
    facilityTypeId: true,
    facilityName: true,
    floorNumber: true,
    capacity: true,
    status: true,
    createdAt: true,
};
const createdAt = new Date("2026-10-25T00:00:00.000Z");
const initial = {
    facilityId: 1,
    buildingId: 1,
    facilityTypeId: 1,
    facilityName: "Room 101",
    floorNumber: 1,
    capacity: 30,
    status: "Available",
    createdAt,
};
const valid = {
    buildingId: 1,
    facilityTypeId: 1,
    facilityName: "Room 202",
    floorNumber: 2,
    capacity: 40,
};
const operations = [
    ["GET", ""],
    ["GET", "/1"],
    ["POST", ""],
    ["PUT", "/1"],
    ["DELETE", "/1"],
];

test("Facilities CRUD uses local HTTP and isolated Prisma mocks", async (t) => {
    const secret = randomBytes(48).toString("hex");
    let user,
        rows,
        buildings,
        types,
        calls,
        failure,
        failureCode,
        dependency,
        beforeWrite,
        failCommit;
    function reset() {
        user = {
            userId: 7,
            fname: "Test",
            lname: "Admin",
            email: "fixture@example.test",
            isActive: true,
            role: { roleId: 1, roleName: roles[0] },
        };
        rows = [structuredClone(initial)];
        buildings = [
            { buildingId: 1, floorCount: 3 },
            { buildingId: 2, floorCount: 1 },
        ];
        types = [{ facilityTypeId: 1 }, { facilityTypeId: 2 }];
        calls = [];
        failure = null;
        failureCode = undefined;
        dependency = null;
        beforeWrite = null;
        failCommit = false;
    }
    reset();
    function record(method, query) {
        calls.push({ method, query });
        if (failure === method)
            throw Object.assign(new Error("PRIVATE-database-error"), {
                code: failureCode,
                meta: {
                    detail: "PRIVATE-database-configuration",
                    target: "PRIVATE-table",
                },
            });
    }
    function dbError(code) {
        return Object.assign(new Error("PRIVATE-database-error"), { code });
    }
    const prisma = {
        user: {
            findUnique: async () => {
                if (failure === "auth") throw new Error("PRIVATE-auth-error");
                return structuredClone(user);
            },
        },
        building: {
            findUnique: async (query) => {
                record("building.findUnique", query);
                assert.deepEqual(query.select, {
                    buildingId: true,
                    floorCount: true,
                });
                return (
                    buildings.find(
                        (row) => row.buildingId === query.where.buildingId,
                    ) || null
                );
            },
        },
        facilityType: {
            findUnique: async (query) => {
                record("facilityType.findUnique", query);
                assert.deepEqual(query.select, { facilityTypeId: true });
                return (
                    types.find(
                        (row) =>
                            row.facilityTypeId === query.where.facilityTypeId,
                    ) || null
                );
            },
        },
        facility: Object.fromEntries(
            ["findMany", "findUnique", "create", "update", "delete"].map(
                (method) => [
                    method,
                    async (query) => {
                        record(`facility.${method}`, query);
                        assert.deepEqual(query.select, select);
                        if (method === "findMany") {
                            assert.deepEqual(query.orderBy, {
                                facilityId: "asc",
                            });
                            return structuredClone(
                                rows
                                    .filter((row) =>
                                        Object.entries(query.where).every(
                                            ([key, value]) =>
                                                row[key] === value,
                                        ),
                                    )
                                    .sort((a, b) => a.facilityId - b.facilityId)
                                    .slice(query.skip, query.skip + query.take),
                            );
                        }
                        if (method === "findUnique")
                            return structuredClone(
                                rows.find(
                                    (row) =>
                                        row.facilityId ===
                                        query.where.facilityId,
                                ) || null,
                            );
                        if (beforeWrite) await beforeWrite(method);
                        const current = rows.find(
                            (row) => row.facilityId === query.where?.facilityId,
                        );
                        if (method !== "create" && !current)
                            throw dbError("P2025");
                        if (method === "delete") {
                            assert.deepEqual(query, {
                                where: { facilityId: current.facilityId },
                                select,
                            });
                            if (dependency) throw dbError("P2003");
                            rows = rows.filter((row) => row !== current);
                            return structuredClone(current);
                        }
                        assert.ok(!Object.hasOwn(query.data, "facilityId"));
                        assert.ok(!Object.hasOwn(query.data, "createdAt"));
                        const resulting = {
                            ...(current || { status: "Available", createdAt }),
                            ...query.data,
                        };
                        if (
                            !buildings.some(
                                (row) =>
                                    row.buildingId === resulting.buildingId,
                            ) ||
                            !types.some(
                                (row) =>
                                    row.facilityTypeId ===
                                    resulting.facilityTypeId,
                            )
                        )
                            throw dbError("P2003");
                        if (
                            rows.some(
                                (row) =>
                                    row !== current &&
                                    row.buildingId === resulting.buildingId &&
                                    row.facilityName ===
                                        resulting.facilityName &&
                                    row.floorNumber === resulting.floorNumber,
                            )
                        )
                            throw dbError("P2002");
                        if (method === "create") {
                            resulting.facilityId =
                                Math.max(
                                    0,
                                    ...rows.map((row) => row.facilityId),
                                ) + 1;
                            rows.push(resulting);
                            return structuredClone(resulting);
                        }
                        Object.assign(current, query.data);
                        return structuredClone(current);
                    },
                ],
            ),
        ),
    };
    prisma.$transaction = async (run, options) => {
        record("transaction", options);
        assert.deepEqual(options, {
            isolationLevel: "Serializable",
            maxWait: 10000,
            timeout: 15000,
        });
        const snapshot = structuredClone(rows);
        try {
            const result = await run(prisma);
            if (failCommit) throw dbError("P2034");
            calls.push({ method: "commit" });
            return result;
        } catch (error) {
            rows = snapshot;
            calls.push({ method: "rollback" });
            throw error;
        }
    };
    const app = createApp({ jwtSecret: secret, getPrisma: () => prisma });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api/facilities`;
    const sign = (payload = {}, overrides = {}) =>
        jwt.sign(payload, secret, {
            algorithm: "HS256",
            subject: "7",
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: "15m",
            ...overrides,
        });
    const token = sign();
    async function request(
        method = "GET",
        path = "",
        body,
        authorization = `Bearer ${token}`,
        headers = {},
    ) {
        const response = await fetch(base + path, {
            method,
            headers: {
                "Content-Type": "application/json",
                ...(authorization ? { Authorization: authorization } : {}),
                ...headers,
            },
            ...(body === undefined || method === "GET"
                ? {}
                : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const result = await response.json();
        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
        assert.ok(!JSON.stringify(result).includes(token));
        if (result.message !== "Invalid request body.")
            assert.equal(response.headers.get("cache-control"), "no-store");
        return { status: response.status, body: result };
    }
    const noWrites = () =>
        assert.ok(
            !calls.some((call) =>
                /^facility\.(create|update|delete)$/.test(call.method),
            ),
        );
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            await run();
        });
    }
    try {
        await scenario(
            "administrator CRUD honors defaults, references, partial updates and response fields",
            async () => {
                const created = await request("POST", "", {
                    ...valid,
                    facilityName: " Room 202 ",
                });
                assert.equal(created.status, 201);
                assert.deepEqual(created.body.facility, {
                    ...valid,
                    facilityId: 2,
                    status: "Available",
                    createdAt: createdAt.toISOString(),
                });
                assert.equal(
                    Object.hasOwn(
                        calls.find((call) => call.method === "facility.create")
                            .query.data,
                        "status",
                    ),
                    false,
                );
                const read = await request("GET", "/2");
                assert.deepEqual(read.body, created.body);
                const updated = await request("PUT", "/2", {
                    capacity: 50,
                    status: " Reserved ",
                });
                assert.equal(updated.status, 200);
                assert.equal(updated.body.facility.capacity, 50);
                assert.equal(
                    updated.body.facility.facilityName,
                    valid.facilityName,
                );
                assert.equal(updated.body.facility.status, "Reserved");
                assert.equal(
                    updated.body.facility.createdAt,
                    created.body.facility.createdAt,
                );
                assert.deepEqual(
                    calls
                        .filter((call) => call.method === "facility.update")
                        .at(-1).query.data,
                    { capacity: 50, status: "Reserved" },
                );
                assert.equal((await request("DELETE", "/2")).status, 200);
                assert.equal((await request("GET", "/2")).status, 404);
            },
        );
        await scenario(
            "bounded pagination is deterministic and both optional filters are applied",
            async () => {
                rows = [5, 1, 4, 2, 3].map((facilityId) => ({
                    ...initial,
                    facilityId,
                    buildingId: facilityId === 5 ? 2 : 1,
                    facilityTypeId: facilityId === 4 ? 2 : 1,
                }));
                const page = await request(
                    "GET",
                    "?buildingId=1&facilityTypeId=1&page=1&limit=2",
                );
                assert.equal(page.status, 200);
                assert.deepEqual(
                    page.body.facilities.map((row) => row.facilityId),
                    [1, 2],
                );
                assert.deepEqual(page.body.pagination, {
                    page: 1,
                    limit: 2,
                    hasMore: true,
                });
                assert.deepEqual(calls[0].query, {
                    where: { buildingId: 1, facilityTypeId: 1 },
                    select,
                    orderBy: { facilityId: "asc" },
                    skip: 0,
                    take: 3,
                });
                assert.deepEqual(
                    (await request("GET", "?buildingId=2")).body.facilities.map(
                        (row) => row.facilityId,
                    ),
                    [5],
                );
                assert.deepEqual(
                    (
                        await request("GET", "?facilityTypeId=2")
                    ).body.facilities.map((row) => row.facilityId),
                    [4],
                );
                assert.deepEqual(
                    (await request("GET", "?buildingId=999")).body.facilities,
                    [],
                );
                assert.deepEqual(
                    (await request("GET", "?page=9")).body.facilities,
                    [],
                );
                assert.deepEqual((await request()).body.pagination, {
                    page: 1,
                    limit: 20,
                    hasMore: false,
                });
            },
        );
        await scenario(
            "all approved roles may read but other roles are denied",
            async () => {
                for (const roleName of roles) {
                    user.role.roleName = roleName;
                    assert.equal((await request()).status, 200);
                    assert.equal((await request("GET", "/1")).status, 200);
                }
                user.role.roleName = "Other";
                assert.equal((await request()).status, 403);
                assert.equal((await request("GET", "/1")).status, 403);
            },
        );
        await scenario(
            "non-administrators cannot write or spoof roles through signed claims, body or headers",
            async () => {
                const claimed = sign({ role: roles[0], roleName: roles[0] });
                for (const roleName of [...roles.slice(1), "Other"]) {
                    user.role.roleName = roleName;
                    for (const [method, path] of operations.slice(2))
                        assert.equal(
                            (
                                await request(
                                    method,
                                    path + "?role=System%20Administrator",
                                    { ...valid, role: roles[0] },
                                    `Bearer ${claimed}`,
                                    { "X-Role": roles[0] },
                                )
                            ).status,
                            403,
                        );
                }
                assert.deepEqual(calls, []);
                assert.deepEqual(rows, [initial]);
            },
        );
        await scenario(
            "missing, invalid, forged and expired JWTs cannot reach facility queries",
            async () => {
                const forged = token.slice(0, -4) + "XXXX";
                for (const authorization of [
                    null,
                    "Bearer invalid",
                    `Bearer ${forged}`,
                    `Bearer ${sign({}, { expiresIn: -1 })}`,
                ]) {
                    for (const [method, path] of operations)
                        assert.equal(
                            (await request(method, path, valid, authorization))
                                .status,
                            401,
                        );
                }
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "inactive and deleted users cannot read or write",
            async () => {
                for (const account of [{ ...user, isActive: false }, null]) {
                    user = account;
                    for (const [method, path] of operations)
                        assert.equal(
                            (await request(method, path, valid)).status,
                            401,
                        );
                }
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "invalid IDs, pagination and filters are rejected before facility queries",
            async () => {
                for (const id of [
                    "0",
                    "-1",
                    "1.2",
                    "1e2",
                    "01",
                    "abc",
                    "2147483648",
                ]) {
                    for (const method of ["GET", "PUT", "DELETE"])
                        assert.equal(
                            (await request(method, `/${id}`, valid)).status,
                            400,
                        );
                }
                for (const query of [
                    "page=0",
                    "page=1.1",
                    "limit=101",
                    "limit=0",
                    "page=1&page=2",
                    "page=2147483647&limit=100",
                    "buildingId=0",
                    "buildingId=abc",
                    "buildingId=1&buildingId=2",
                    "facilityTypeId=-1",
                    "facilityTypeId=1.1",
                    "facilityTypeId=2147483648",
                    "sort=name",
                    "facilityTypeId[]=1",
                ])
                    assert.equal(
                        (await request("GET", "?" + query)).status,
                        400,
                    );
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "invalid writable fields, ranges, Unicode, and nested writes never start transactions",
            async () => {
                const bodies = [
                    null,
                    [],
                    {},
                    { ...valid, facilityId: 2 },
                    { ...valid, createdAt: createdAt.toISOString() },
                    { ...valid, building: { connect: { buildingId: 1 } } },
                    { ...valid, equipment: { deleteMany: {} } },
                    { ...valid, role: roles[0] },
                    ...[
                        "",
                        " ",
                        1,
                        null,
                        "x".repeat(101),
                        "a\0b",
                        "\ud800",
                    ].map((facilityName) => ({ ...valid, facilityName })),
                    ...["", " ", 1, null, "x".repeat(21), "a\nb", "\ud800"].map(
                        (status) => ({ ...valid, status }),
                    ),
                ];
                for (const [field, max] of [
                    ["buildingId", 2147483647],
                    ["facilityTypeId", 2147483647],
                    ["floorNumber", 32767],
                    ["capacity", 2147483647],
                ]) {
                    for (const value of [0, -1, 1.5, "1", true, null, max + 1])
                        bodies.push({ ...valid, [field]: value });
                }
                for (const body of bodies)
                    for (const [method, path] of [
                        ["POST", ""],
                        ["PUT", "/1"],
                    ])
                        assert.equal(
                            (await request(method, path, body)).status,
                            400,
                        );
                for (const field of Object.keys(valid)) {
                    const body = { ...valid };
                    delete body[field];
                    assert.equal((await request("POST", "", body)).status, 400);
                }
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "missing references and empty facility-type lookup are refused without creating records",
            async () => {
                for (const body of [
                    { ...valid, buildingId: 99 },
                    { ...valid, facilityTypeId: 99 },
                ]) {
                    for (const [method, path] of [
                        ["POST", ""],
                        ["PUT", "/1"],
                    ])
                        assert.equal(
                            (await request(method, path, body)).status,
                            400,
                        );
                }
                types = [];
                assert.equal((await request("POST", "", valid)).status, 400);
                noWrites();
                assert.deepEqual(rows, [initial]);
            },
        );
        await scenario(
            "partial updates validate the resulting building and floor together",
            async () => {
                assert.equal(
                    (await request("POST", "", { ...valid, floorNumber: 4 }))
                        .status,
                    400,
                );
                rows[0].floorNumber = 3;
                assert.equal(
                    (await request("PUT", "/1", { buildingId: 2 })).status,
                    400,
                );
                assert.equal(rows[0].buildingId, 1);
                assert.equal(
                    (
                        await request("PUT", "/1", {
                            buildingId: 2,
                            floorNumber: 1,
                            facilityTypeId: 2,
                        })
                    ).status,
                    200,
                );
                assert.equal(rows[0].buildingId, 2);
                assert.equal(rows[0].floorNumber, 1);
                assert.equal(
                    (await request("PUT", "/1", { floorNumber: 2 })).status,
                    400,
                );
            },
        );
        await scenario(
            "schema boundaries accept Unicode names, custom status and positive database integer maxima",
            async () => {
                buildings[0].floorCount = 32767;
                const result = await request("POST", "", {
                    ...valid,
                    facilityName: "😀".repeat(100),
                    floorNumber: 32767,
                    capacity: 2147483647,
                    status: "x".repeat(20),
                });
                assert.equal(result.status, 201);
                assert.equal(result.body.facility.floorNumber, 32767);
                assert.equal(
                    (await request("PUT", "/2", { status: "Custom status" }))
                        .status,
                    200,
                );
            },
        );
        await scenario(
            "uniqueness uses building, name and floor, not facility type",
            async () => {
                assert.equal(
                    (
                        await request("POST", "", {
                            ...valid,
                            facilityName: " Room 101 ",
                            floorNumber: 1,
                            facilityTypeId: 2,
                        })
                    ).status,
                    409,
                );
                assert.equal(
                    (
                        await request("POST", "", {
                            ...valid,
                            facilityName: "Room 101",
                            floorNumber: 2,
                        })
                    ).status,
                    201,
                );
                assert.equal(
                    (await request("PUT", "/2", { floorNumber: 1 })).status,
                    409,
                );
                assert.equal(rows[1].floorNumber, 2);
                assert.equal(
                    (
                        await request("POST", "", {
                            ...valid,
                            buildingId: 2,
                            facilityName: "Room 101",
                            floorNumber: 1,
                        })
                    ).status,
                    201,
                );
            },
        );
        await scenario(
            "missing facilities return 404 and update never upserts",
            async () => {
                for (const method of ["GET", "PUT", "DELETE"])
                    assert.equal(
                        (await request(method, "/99", valid)).status,
                        404,
                    );
                assert.ok(
                    !calls.some((call) =>
                        ["facility.create", "facility.update"].includes(
                            call.method,
                        ),
                    ),
                );
                assert.deepEqual(rows, [initial]);
            },
        );
        await scenario(
            "all dependency kinds safely block deletion without touching dependent models",
            async () => {
                for (const kind of [
                    "equipment",
                    "reservations",
                    "maintenanceRequests",
                    "staffAssignments",
                ]) {
                    dependency = kind;
                    const result = await request("DELETE", "/1");
                    assert.equal(result.status, 409);
                    assert.match(result.body.message, /dependent records/);
                    assert.deepEqual(rows, [initial]);
                }
                assert.deepEqual(
                    calls.map((call) => call.method),
                    Array(4).fill("facility.delete"),
                );
            },
        );
        await scenario(
            "late dependency or parent deletion produces safe foreign-key conflicts",
            async () => {
                beforeWrite = async (method) => {
                    await new Promise((resolve) => setImmediate(resolve));
                    if (method === "delete") dependency = "reservations";
                    else types = [];
                };
                assert.equal((await request("DELETE", "/1")).status, 409);
                assert.equal((await request("POST", "", valid)).status, 409);
                assert.deepEqual(rows, [initial]);
            },
        );
        await scenario(
            "serialization conflicts roll back and never retry automatically",
            async () => {
                failCommit = true;
                for (const [method, path] of [
                    ["POST", ""],
                    ["PUT", "/1"],
                ]) {
                    const result = await request(method, path, valid);
                    assert.equal(result.status, 409);
                    assert.match(result.body.message, /Concurrent changes/);
                    assert.deepEqual(rows, [initial]);
                }
                assert.equal(
                    calls.filter((call) => call.method === "transaction")
                        .length,
                    2,
                );
            },
        );
        await scenario(
            "reservation closure and configuration refusals are sanitized and rolled back",
            async () => {
                failure = "facility.update";
                for (const [code, status] of [
                    ["R4091", 409],
                    ["R5031", 503],
                ]) {
                    failureCode = code;
                    const response = await request("PUT", "/1", {
                        status: "Closed",
                    });
                    assert.equal(response.status, status);
                    assert.ok(!JSON.stringify(response).includes("PRIVATE"));
                    assert.deepEqual(rows, [initial]);
                }
            },
        );
        await scenario(
            "unexpected Prisma codes and private metadata stay out of HTTP errors",
            async () => {
                failure = "facility.create";
                for (const code of [
                    "P2000",
                    "P2022",
                    "P2028",
                    "PRIVATE-unknown-code",
                ]) {
                    failureCode = code;
                    const result = await request("POST", "", valid);
                    assert.equal(result.status, 500);
                    assert.deepEqual(result.body, {
                        success: false,
                        message: "Internal server error.",
                    });
                    assert.deepEqual(rows, [initial]);
                }
            },
        );
        await scenario(
            "database and transaction failures are sanitized at every query stage",
            async () => {
                for (const stage of [
                    "facility.findMany",
                    "facility.findUnique",
                    "facility.create",
                    "facility.update",
                    "facility.delete",
                    "building.findUnique",
                    "facilityType.findUnique",
                    "transaction",
                    "auth",
                ]) {
                    failure = stage;
                    let method = "POST",
                        path = "";
                    if (stage === "facility.findMany") method = "GET";
                    if (stage === "facility.findUnique") {
                        method = "GET";
                        path = "/1";
                    }
                    if (stage === "facility.update") {
                        method = "PUT";
                        path = "/1";
                    }
                    if (stage === "facility.delete") {
                        method = "DELETE";
                        path = "/1";
                    }
                    const result = await request(method, path, valid);
                    assert.equal(result.status, 500);
                    assert.deepEqual(result.body, {
                        success: false,
                        message: "Internal server error.",
                    });
                    assert.deepEqual(rows, [initial]);
                }
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
