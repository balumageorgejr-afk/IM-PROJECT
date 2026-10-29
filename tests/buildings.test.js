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
    buildingId: true,
    buildingName: true,
    floorCount: true,
    locationNote: true,
};
const original = {
    buildingId: 1,
    buildingName: "Main Building",
    floorCount: 3,
    locationNote: null,
};

test("Buildings CRUD with isolated Prisma mocks and real HTTP/JWT/RBAC", async (t) => {
    const secret = randomBytes(48).toString("hex");
    let user,
        rows,
        calls,
        failure,
        dependencies,
        beforeWrite,
        facilityFloors,
        transactions,
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
        rows = [structuredClone(original)];
        calls = [];
        failure = null;
        dependencies = false;
        beforeWrite = null;
        facilityFloors = [];
        transactions = 0;
        failCommit = false;
    }
    reset();
    const prisma = {
        user: {
            findUnique: async () => {
                if (failure === "auth")
                    throw new Error("PRIVATE-database-error");
                return user;
            },
        },
        facility: {
            findFirst: async (query) => {
                calls.push({ method: "facility.findFirst", query });
                assert.deepEqual(query.select, { facilityId: true });
                if (failure === "facility lookup")
                    throw new Error("PRIVATE-facility-error");
                return (
                    facilityFloors.find(
                        (row) =>
                            row.buildingId === query.where.buildingId &&
                            row.floorNumber > query.where.floorNumber.gt,
                    ) || null
                );
            },
        },
        building: Object.fromEntries(
            ["findMany", "findUnique", "create", "update", "delete"].map(
                (method) => [
                    method,
                    async (query) => {
                        calls.push({ method, query });
                        assert.deepEqual(query.select, select);
                        if (failure)
                            throw Object.assign(
                                new Error("PRIVATE-database-error"),
                                { code: failure },
                            );
                        if (
                            beforeWrite &&
                            ["create", "update", "delete"].includes(method)
                        ) {
                            await beforeWrite(method);
                        }
                        const found = rows.find(
                            (row) => row.buildingId === query.where?.buildingId,
                        );
                        if (method === "findMany") {
                            assert.deepEqual(query.orderBy, {
                                buildingId: "asc",
                            });
                            return rows
                                .slice()
                                .sort((a, b) => a.buildingId - b.buildingId)
                                .slice(query.skip, query.skip + query.take);
                        }
                        if (method === "findUnique") return found || null;
                        if (method === "create" || method === "update") {
                            if (
                                rows.some(
                                    (row) =>
                                        row.buildingName ===
                                            query.data.buildingName &&
                                        row !== found,
                                )
                            )
                                throw Object.assign(
                                    new Error("PRIVATE-duplicate"),
                                    { code: "P2002" },
                                );
                            if (method === "create") {
                                const row = {
                                    buildingId: 2,
                                    locationNote: null,
                                    ...query.data,
                                };
                                rows.push(row);
                                return row;
                            }
                        }
                        if (!found)
                            throw Object.assign(new Error("PRIVATE-missing"), {
                                code: "P2025",
                            });
                        if (method === "update") {
                            Object.assign(found, query.data);
                            return found;
                        }
                        if (dependencies)
                            throw Object.assign(
                                new Error("PRIVATE-facilities"),
                                { code: "P2003" },
                            );
                        rows = rows.filter((row) => row !== found);
                        return found;
                    },
                ],
            ),
        ),
    };
    prisma.$transaction = async (run, options) => {
        transactions++;
        assert.deepEqual(options, {
            isolationLevel: "Serializable",
            maxWait: 10000,
            timeout: 15000,
        });
        const snapshot = structuredClone(rows);
        try {
            const result = await run(prisma);
            if (failCommit)
                throw Object.assign(new Error("PRIVATE-commit-conflict"), {
                    code: "P2034",
                });
            return result;
        } catch (error) {
            rows = snapshot;
            throw error;
        }
    };
    const app = createApp({ jwtSecret: secret, getPrisma: () => prisma });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    const token = jwt.sign({}, secret, {
        algorithm: "HS256",
        subject: "7",
        issuer: "im101-api",
        audience: "im101-client",
        expiresIn: "15m",
    });
    const base = `http://127.0.0.1:${server.address().port}/api/buildings`;
    async function request(
        method = "GET",
        path = "",
        body,
        authorization = `Bearer ${token}`,
        extraHeaders = {},
    ) {
        const response = await fetch(base + path, {
            method,
            headers: {
                "Content-Type": "application/json",
                ...(authorization ? { Authorization: authorization } : {}),
                ...extraHeaders,
            },
            ...(body === undefined || method === "GET"
                ? {}
                : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(5000),
        });
        const result = await response.json();
        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
        assert.ok(!JSON.stringify(result).includes(token));
        // Shared JSON parsing can reject a body before it reaches this router.
        if (result.message !== "Invalid request body.") {
            assert.equal(response.headers.get("cache-control"), "no-store");
        }
        return { status: response.status, body: result };
    }
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            await run();
        });
    }
    try {
        await scenario(
            "administrator can create, get, partially update and delete a building",
            async () => {
                const created = await request("POST", "", {
                    buildingName: " Annex ",
                    floorCount: 2,
                    locationNote: " East wing ",
                });
                assert.equal(created.status, 201);
                assert.deepEqual(created.body.building, {
                    buildingId: 2,
                    buildingName: "Annex",
                    floorCount: 2,
                    locationNote: "East wing",
                });
                assert.deepEqual(calls[0].query.data, {
                    buildingName: "Annex",
                    floorCount: 2,
                    locationNote: "East wing",
                });
                const read = await request("GET", "/2");
                assert.equal(read.status, 200);
                assert.deepEqual(read.body.building, created.body.building);
                const updated = await request("PUT", "/2", {
                    floorCount: 4,
                    locationNote: null,
                });
                assert.equal(updated.status, 200);
                assert.equal(updated.body.building.buildingName, "Annex");
                assert.equal(updated.body.building.floorCount, 4);
                assert.equal(updated.body.building.locationNote, null);
                assert.deepEqual(calls.at(-1).query.data, {
                    floorCount: 4,
                    locationNote: null,
                });
                assert.equal((await request("DELETE", "/2")).status, 200);
                assert.deepEqual(calls.at(-1).query, {
                    where: { buildingId: 2 },
                    select,
                });
                assert.equal((await request("GET", "/2")).status, 404);
            },
        );
        await scenario(
            "pagination uses bounded offsets and deterministic building ID order",
            async () => {
                rows = [5, 1, 3, 2, 4].map((buildingId) => ({
                    ...original,
                    buildingId,
                }));
                const page = await request("GET", "?page=2&limit=2");
                assert.equal(page.status, 200);
                assert.deepEqual(
                    page.body.buildings.map((row) => row.buildingId),
                    [3, 4],
                );
                assert.deepEqual(page.body.pagination, {
                    page: 2,
                    limit: 2,
                    hasMore: true,
                });
                assert.deepEqual(calls[0].query, {
                    select,
                    skip: 2,
                    take: 3,
                    orderBy: { buildingId: "asc" },
                });
                assert.equal(
                    (await request("GET", "?page=3&limit=2")).body.pagination
                        .hasMore,
                    false,
                );
                assert.deepEqual(
                    (await request("GET", "?page=4&limit=2")).body.buildings,
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
            "all three approved roles may read; unknown roles are denied",
            async () => {
                for (const roleName of roles) {
                    user.role.roleName = roleName;
                    assert.equal((await request()).status, 200);
                    assert.equal((await request("GET", "/1")).status, 200);
                }
                user.role.roleName = "Unapproved";
                assert.equal((await request()).status, 403);
                assert.equal((await request("GET", "/1")).status, 403);
            },
        );
        await scenario(
            "non-administrators cannot write or spoof a role through body, query or headers",
            async () => {
                for (const roleName of [...roles.slice(1), "Unapproved"]) {
                    user.role.roleName = roleName;
                    for (const [method, path] of [
                        ["POST", ""],
                        ["PUT", "/1"],
                        ["DELETE", "/1"],
                    ]) {
                        assert.equal(
                            (
                                await request(
                                    method,
                                    path + "?role=System%20Administrator",
                                    {
                                        buildingName: "Unauthorized",
                                        floorCount: 1,
                                        role: roles[0],
                                    },
                                    `Bearer ${token}`,
                                    { "X-Role": roles[0] },
                                )
                            ).status,
                            403,
                        );
                    }
                }
                assert.deepEqual(calls, []);
                assert.deepEqual(rows, [original]);
            },
        );
        await scenario(
            "missing, malformed and forged JWTs cannot access any endpoint",
            async () => {
                const forged = jwt.sign(
                    { role: roles[0] },
                    randomBytes(48).toString("hex"),
                    { subject: "7" },
                );
                for (const authorization of [
                    null,
                    "Bearer invalid",
                    `Bearer ${forged}`,
                ]) {
                    for (const [method, path] of [
                        ["GET", ""],
                        ["GET", "/1"],
                        ["POST", ""],
                        ["PUT", "/1"],
                        ["DELETE", "/1"],
                    ])
                        assert.equal(
                            (
                                await request(
                                    method,
                                    path,
                                    { buildingName: "No", floorCount: 1 },
                                    authorization,
                                )
                            ).status,
                            401,
                        );
                }
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "expired JWTs are refused and signed role claims cannot authorize writes",
            async () => {
                const expired = jwt.sign({}, secret, {
                    algorithm: "HS256",
                    subject: "7",
                    issuer: "im101-api",
                    audience: "im101-client",
                    expiresIn: -1,
                });
                const claimedAdmin = jwt.sign(
                    { role: roles[0], roleName: roles[0] },
                    secret,
                    {
                        algorithm: "HS256",
                        subject: "7",
                        issuer: "im101-api",
                        audience: "im101-client",
                        expiresIn: "15m",
                    },
                );
                user.role.roleName = roles[1];
                for (const [method, path] of [
                    ["GET", ""],
                    ["GET", "/1"],
                    ["POST", ""],
                    ["PUT", "/1"],
                    ["DELETE", "/1"],
                ]) {
                    assert.equal(
                        (
                            await request(
                                method,
                                path,
                                { buildingName: "No", floorCount: 1 },
                                `Bearer ${expired}`,
                            )
                        ).status,
                        401,
                    );
                }
                for (const [method, path] of [
                    ["POST", ""],
                    ["PUT", "/1"],
                    ["DELETE", "/1"],
                ]) {
                    assert.equal(
                        (
                            await request(
                                method,
                                path,
                                { buildingName: "No", floorCount: 1 },
                                `Bearer ${claimedAdmin}`,
                            )
                        ).status,
                        403,
                    );
                }
                assert.deepEqual(calls, []);
                assert.deepEqual(rows, [original]);
            },
        );
        await scenario(
            "inactive or deleted users cannot access any endpoint",
            async () => {
                for (const account of [{ ...user, isActive: false }, null]) {
                    user = account;
                    for (const [method, path] of [
                        ["GET", ""],
                        ["GET", "/1"],
                        ["POST", ""],
                        ["PUT", "/1"],
                        ["DELETE", "/1"],
                    ])
                        assert.equal(
                            (
                                await request(method, path, {
                                    buildingName: "No",
                                    floorCount: 1,
                                })
                            ).status,
                            401,
                        );
                }
                assert.deepEqual(calls, []);
            },
        );
        await scenario("invalid IDs never reach building queries", async () => {
            for (const value of [
                "0",
                "-1",
                "1.5",
                "1e2",
                "abc",
                "01",
                "2147483648",
                "999999999999999999999",
            ]) {
                for (const method of ["GET", "PUT", "DELETE"])
                    assert.equal(
                        (await request(method, `/${value}`, { floorCount: 1 }))
                            .status,
                        400,
                    );
            }
            assert.deepEqual(calls, []);
        });
        await scenario(
            "invalid pagination is rejected before queries",
            async () => {
                for (const query of [
                    "page=0",
                    "page=-1",
                    "page=abc",
                    "page=1.5",
                    "limit=0",
                    "limit=101",
                    "limit=true",
                    "page=1&page=2",
                    "page=2147483647&limit=100",
                    "limit=01",
                    "sort=buildingName",
                ])
                    assert.equal(
                        (await request("GET", "?" + query)).status,
                        400,
                    );
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "invalid writes and unknown fields are rejected before queries",
            async () => {
                const valid = { buildingName: "Annex", floorCount: 1 };
                for (const body of [
                    null,
                    [],
                    {},
                    { ...valid, buildingId: 9 },
                    { ...valid, facilities: [] },
                    { ...valid, role: roles[0] },
                    { ...valid, buildingName: " " },
                    { ...valid, buildingName: 1 },
                    { ...valid, buildingName: null },
                    { ...valid, buildingName: "x".repeat(101) },
                    { ...valid, buildingName: "a\0b" },
                    { ...valid, buildingName: "\ud800" },
                    ...[0, -1, 32768, 1.5, "2", true, null].map(
                        (floorCount) => ({ ...valid, floorCount }),
                    ),
                    { ...valid, locationNote: 1 },
                    { ...valid, locationNote: "x".repeat(151) },
                    { ...valid, locationNote: "a\nb" },
                    { ...valid, locationNote: "\ud800" },
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
                for (const body of [
                    { buildingName: "No floors" },
                    { floorCount: 1 },
                ])
                    assert.equal((await request("POST", "", body)).status, 400);
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "maximum lengths and SmallInt upper boundary are accepted",
            async () => {
                const result = await request("POST", "", {
                    buildingName: "😀".repeat(100),
                    floorCount: 32767,
                    locationNote: "雪".repeat(150),
                });
                assert.equal(result.status, 201);
                assert.equal(
                    (await request("PUT", "/2", { locationNote: "" })).status,
                    200,
                );
            },
        );
        await scenario(
            "database uniqueness rejects duplicate names on create and update",
            async () => {
                assert.equal(
                    (
                        await request("POST", "", {
                            buildingName: " Main Building ",
                            floorCount: 1,
                        })
                    ).status,
                    409,
                );
                rows.push({
                    ...original,
                    buildingId: 2,
                    buildingName: "Annex",
                });
                assert.equal(
                    (
                        await request("PUT", "/2", {
                            buildingName: "Main Building",
                        })
                    ).status,
                    409,
                );
                assert.equal(rows[1].buildingName, "Annex");
            },
        );
        await scenario(
            "simultaneous duplicate creates handle the mocked unique constraint without preflight reads",
            async () => {
                // Both mock writes yield before checking the simulated unique index.
                // This tests HTTP conflict handling, not PostgreSQL concurrency itself.
                beforeWrite = async (method) => {
                    assert.equal(method, "create");
                    await new Promise((resolve) => setImmediate(resolve));
                };
                const body = {
                    buildingName: "Concurrent Annex",
                    floorCount: 1,
                };
                const results = await Promise.all([
                    request("POST", "", body),
                    request("POST", "", body),
                ]);
                assert.deepEqual(
                    results.map((result) => result.status).sort(),
                    [201, 409],
                );
                assert.equal(
                    rows.filter((row) => row.buildingName === body.buildingName)
                        .length,
                    1,
                );
                assert.deepEqual(
                    calls.map((call) => call.method),
                    ["create", "create"],
                );
            },
        );
        await scenario(
            "missing buildings return 404 for read, update and delete",
            async () => {
                for (const method of ["GET", "PUT", "DELETE"])
                    assert.equal(
                        (await request(method, "/99", { floorCount: 1 }))
                            .status,
                        404,
                    );
            },
        );
        await scenario(
            "foreign-key conflict prevents deleting a building with facilities",
            async () => {
                dependencies = true;
                const result = await request("DELETE", "/1");
                assert.equal(result.status, 409);
                assert.match(result.body.message, /dependent facilities/);
                assert.deepEqual(rows, [original]);
                assert.deepEqual(
                    calls.map((call) => call.method),
                    ["delete"],
                );
            },
        );
        await scenario(
            "a facility arriving during deletion produces a safe conflict without dependent deletes",
            async () => {
                assert.equal(dependencies, false);
                beforeWrite = async (method) => {
                    assert.equal(method, "delete");
                    await new Promise((resolve) => setImmediate(resolve));
                    dependencies = true;
                };
                const result = await request("DELETE", "/1");
                assert.equal(result.status, 409);
                assert.deepEqual(rows, [original]);
                assert.deepEqual(calls, [
                    {
                        method: "delete",
                        query: { where: { buildingId: 1 }, select },
                    },
                ]);
            },
        );
        await scenario(
            "building floor count cannot strand facilities; safe changes remain allowed",
            async () => {
                facilityFloors = [
                    { buildingId: 1, floorNumber: 3, facilityId: 11 },
                ];
                const rejected = await request("PUT", "/1", {
                    floorCount: 2,
                    buildingName: "Rejected name",
                });
                assert.equal(rejected.status, 409);
                assert.match(rejected.body.message, /existing facility/);
                assert.deepEqual(rows, [original]);
                assert.deepEqual(calls, [
                    {
                        method: "facility.findFirst",
                        query: {
                            where: { buildingId: 1, floorNumber: { gt: 2 } },
                            select: { facilityId: true },
                        },
                    },
                ]);
                assert.equal(
                    (await request("PUT", "/1", { floorCount: 3 })).status,
                    200,
                );
                assert.equal(
                    (await request("PUT", "/1", { floorCount: 4 })).status,
                    200,
                );
                facilityFloors[0].floorNumber = 1;
                assert.equal(
                    (await request("PUT", "/1", { floorCount: 1 })).status,
                    200,
                );
                assert.equal(rows[0].floorCount, 1);
                assert.equal(transactions, 4);
            },
        );
        await scenario(
            "buildings without facilities allow reduction and unrelated edits skip the floor transaction",
            async () => {
                assert.equal(
                    (await request("PUT", "/1", { floorCount: 1 })).status,
                    200,
                );
                assert.equal(
                    (await request("PUT", "/1", { locationNote: "New note" }))
                        .status,
                    200,
                );
                assert.equal(transactions, 1);
                assert.equal(rows[0].locationNote, "New note");
            },
        );
        await scenario(
            "floor guard failures and serialization conflicts roll back without retry or raw errors",
            async () => {
                failure = "facility lookup";
                assert.equal(
                    (await request("PUT", "/1", { floorCount: 2 })).status,
                    500,
                );
                assert.deepEqual(rows, [original]);
                failure = null;
                failCommit = true;
                const conflict = await request("PUT", "/1", { floorCount: 2 });
                assert.equal(conflict.status, 409);
                assert.match(conflict.body.message, /Concurrent changes/);
                assert.deepEqual(rows, [original]);
                assert.equal(transactions, 2);
            },
        );
        await scenario(
            "database failures are sanitized across all endpoints and authentication",
            async () => {
                for (const code of ["UNKNOWN", "P2021", "auth"]) {
                    failure = code;
                    for (const [method, path] of [
                        ["GET", ""],
                        ["GET", "/1"],
                        ["POST", ""],
                        ["PUT", "/1"],
                        ["DELETE", "/1"],
                    ]) {
                        const result = await request(
                            method,
                            path,
                            method === "GET"
                                ? undefined
                                : { buildingName: "Annex", floorCount: 1 },
                        );
                        assert.equal(result.status, 500);
                        assert.deepEqual(result.body, {
                            success: false,
                            message: "Internal server error.",
                        });
                    }
                }
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
