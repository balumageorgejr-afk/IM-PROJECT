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
    equipmentId: true,
    categoryId: true,
    homeFacilityId: true,
    equipmentName: true,
    serialNumber: true,
    totalQuantity: true,
    availableQuantity: true,
    conditionStatus: true,
    createdAt: true,
};
const createdAt = new Date("2026-10-25T00:00:00Z");
const initial = {
    equipmentId: 1,
    categoryId: 1,
    homeFacilityId: 1,
    equipmentName: "Projector",
    serialNumber: "SN-1",
    totalQuantity: 5,
    availableQuantity: 5,
    conditionStatus: "Good",
    createdAt,
};
const valid = {
    categoryId: 1,
    equipmentName: "Chairs",
    totalQuantity: 10,
    availableQuantity: 10,
};
const operations = [
    ["GET", ""],
    ["GET", "/1"],
    ["POST", ""],
    ["PUT", "/1"],
    ["DELETE", "/1"],
];

test("Equipment CRUD with isolated Prisma snapshots and real local HTTP/JWT/RBAC", async (t) => {
    const secret = randomBytes(48).toString("hex");
    let state, user, calls, failure, failureCode, beforeWrite, failCommit, race;
    function reset() {
        state = {
            equipment: [structuredClone(initial)],
            categories: [{ categoryId: 1 }, { categoryId: 2 }],
            facilities: [{ facilityId: 1 }],
            loanItems: [],
            reservationItems: [],
            maintenance: [],
        };
        user = {
            userId: 7,
            fname: "Test",
            lname: "Admin",
            email: "fixture@example.test",
            isActive: true,
            role: { roleId: 1, roleName: roles[0] },
        };
        calls = [];
        failure = null;
        failureCode = undefined;
        beforeWrite = null;
        failCommit = false;
        race = null;
    }
    reset();
    const dbError = (code) =>
        Object.assign(new Error("PRIVATE-driver-error"), {
            code,
            meta: { detail: "PRIVATE-database-details" },
        });
    function record(method, query) {
        calls.push({ method, query });
        if (failure === method) throw dbError(failureCode);
    }
    function delegates(snapshot) {
        const reference = (method, rows, field) => ({
            findUnique: async (query) => {
                record(method, query);
                assert.deepEqual(query.select, { [field]: true });
                return structuredClone(
                    rows.find((row) => row[field] === query.where[field]) ||
                        null,
                );
            },
        });
        const history = (method, rows, field) => ({
            findFirst: async (query) => {
                record(method, query);
                assert.deepEqual(query.select, { [field]: true });
                return (
                    rows.find(
                        (row) => row.equipmentId === query.where.equipmentId,
                    ) || null
                );
            },
        });
        return {
            equipmentCategory: reference(
                "equipmentCategory.findUnique",
                snapshot.categories,
                "categoryId",
            ),
            facility: reference(
                "facility.findUnique",
                snapshot.facilities,
                "facilityId",
            ),
            loanItem: history(
                "loanItem.findFirst",
                snapshot.loanItems,
                "equipmentId",
            ),
            reservationEquipment: history(
                "reservationEquipment.findFirst",
                snapshot.reservationItems,
                "equipmentId",
            ),
            maintenanceRequest: history(
                "maintenanceRequest.findFirst",
                snapshot.maintenance,
                "requestId",
            ),
            equipment: Object.fromEntries(
                ["findMany", "findUnique", "create", "update", "delete"].map(
                    (method) => [
                        method,
                        async (query) => {
                            record(`equipment.${method}`, query);
                            assert.deepEqual(query.select, select);
                            if (method === "findMany") {
                                assert.deepEqual(query.orderBy, {
                                    equipmentId: "asc",
                                });
                                return structuredClone(
                                    snapshot.equipment
                                        .filter((row) =>
                                            Object.entries(query.where).every(
                                                ([key, value]) =>
                                                    row[key] === value,
                                            ),
                                        )
                                        .sort(
                                            (a, b) =>
                                                a.equipmentId - b.equipmentId,
                                        )
                                        .slice(
                                            query.skip,
                                            query.skip + query.take,
                                        ),
                                );
                            }
                            if (method === "findUnique")
                                return structuredClone(
                                    snapshot.equipment.find(
                                        (row) =>
                                            row.equipmentId ===
                                            query.where.equipmentId,
                                    ) || null,
                                );
                            if (beforeWrite)
                                await beforeWrite(method, snapshot);
                            const current = snapshot.equipment.find(
                                (row) =>
                                    row.equipmentId ===
                                    query.where?.equipmentId,
                            );
                            if (method !== "create" && !current)
                                throw dbError("P2025");
                            if (method === "delete") {
                                assert.deepEqual(query, {
                                    where: { equipmentId: current.equipmentId },
                                    select,
                                });
                                if (
                                    [
                                        ...snapshot.loanItems,
                                        ...snapshot.reservationItems,
                                        ...snapshot.maintenance,
                                    ].some(
                                        (row) =>
                                            row.equipmentId ===
                                            current.equipmentId,
                                    )
                                )
                                    throw dbError("P2003");
                                snapshot.equipment = snapshot.equipment.filter(
                                    (row) => row !== current,
                                );
                                return structuredClone(current);
                            }
                            assert.ok(
                                !Object.hasOwn(query.data, "equipmentId"),
                            );
                            assert.ok(!Object.hasOwn(query.data, "createdAt"));
                            const resulting = {
                                ...(current || {
                                    homeFacilityId: null,
                                    serialNumber: null,
                                    conditionStatus: "Good",
                                    createdAt,
                                }),
                                ...query.data,
                            };
                            if (
                                !snapshot.categories.some(
                                    (row) =>
                                        row.categoryId === resulting.categoryId,
                                ) ||
                                (resulting.homeFacilityId !== null &&
                                    !snapshot.facilities.some(
                                        (row) =>
                                            row.facilityId ===
                                            resulting.homeFacilityId,
                                    ))
                            )
                                throw dbError("P2003");
                            if (
                                resulting.serialNumber !== null &&
                                snapshot.equipment.some(
                                    (row) =>
                                        row !== current &&
                                        row.serialNumber ===
                                            resulting.serialNumber,
                                )
                            )
                                throw dbError("P2002");
                            if (method === "create") {
                                resulting.equipmentId =
                                    Math.max(
                                        0,
                                        ...snapshot.equipment.map(
                                            (row) => row.equipmentId,
                                        ),
                                    ) + 1;
                                snapshot.equipment.push(resulting);
                                return structuredClone(resulting);
                            }
                            Object.assign(current, query.data);
                            return structuredClone(current);
                        },
                    ],
                ),
            ),
        };
    }
    const prisma = {
        user: {
            findUnique: async () => {
                if (failure === "auth") throw dbError("PRIVATE-auth-code");
                return structuredClone(user);
            },
        },
        equipment: Object.fromEntries(
            ["findMany", "findUnique"].map((method) => [
                method,
                (query) => delegates(state).equipment[method](query),
            ]),
        ),
        $transaction: async (run, options) => {
            record("transaction", options);
            assert.deepEqual(options, {
                isolationLevel: "Serializable",
                maxWait: 10000,
                timeout: 15000,
            });
            const snapshot = structuredClone(state);
            try {
                const result = await run(delegates(snapshot));
                if (race) {
                    if (++race.arrivals === 2) race.barrier.resolve();
                    await race.barrier.promise;
                    // Simulate either commit winner. This is not a database SSI implementation.
                    if (snapshot.equipment[0].totalQuantity !== race.winner)
                        throw dbError("P2034");
                }
                if (failCommit)
                    throw dbError(
                        typeof failCommit === "string" ? failCommit : "P2034",
                    );
                state = snapshot;
                calls.push({ method: "commit" });
                return result;
            } catch (error) {
                calls.push({ method: "rollback" });
                throw error;
            }
        },
    };
    const app = createApp({ jwtSecret: secret, getPrisma: () => prisma });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
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
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/equipment${path}`,
            {
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
            },
        );
        const result = await response.json();
        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
        assert.ok(!JSON.stringify(result).includes(token));
        if (result.message !== "Invalid request body.")
            assert.equal(response.headers.get("cache-control"), "no-store");
        return { status: response.status, body: result };
    }
    async function scenario(name, run) {
        await t.test(name, async () => {
            reset();
            await run();
        });
    }
    const noWrites = () =>
        assert.ok(
            !calls.some((call) =>
                /^equipment\.(create|update|delete)$/.test(call.method),
            ),
        );
    try {
        await scenario(
            "administrator CRUD selects approved fields and respects defaults and partial updates",
            async () => {
                const created = await request("POST", "", {
                    ...valid,
                    equipmentName: " Chairs ",
                });
                assert.equal(created.status, 201);
                assert.deepEqual(created.body.equipment, {
                    ...valid,
                    equipmentId: 2,
                    serialNumber: null,
                    homeFacilityId: null,
                    conditionStatus: "Good",
                    createdAt: createdAt.toISOString(),
                });
                const written = calls.find(
                    (call) => call.method === "equipment.create",
                ).query.data;
                assert.equal(Object.hasOwn(written, "conditionStatus"), false);
                assert.equal((await request("GET", "/2")).status, 200);
                const edited = await request("PUT", "/2", {
                    homeFacilityId: 1,
                    serialNumber: " SN-2 ",
                    conditionStatus: " Needs service ",
                });
                assert.equal(edited.status, 200);
                assert.equal(edited.body.equipment.serialNumber, "SN-2");
                assert.equal(edited.body.equipment.totalQuantity, 10);
                assert.equal(
                    edited.body.equipment.conditionStatus,
                    "Needs service",
                );
                assert.equal(
                    edited.body.equipment.createdAt,
                    createdAt.toISOString(),
                );
                assert.equal(
                    (
                        await request("PUT", "/2", {
                            homeFacilityId: null,
                            serialNumber: null,
                        })
                    ).status,
                    200,
                );
                assert.equal((await request("DELETE", "/2")).status, 200);
                assert.equal((await request("GET", "/2")).status, 404);
            },
        );
        await scenario(
            "zero stock, null serials and null home facilities are allowed",
            async () => {
                for (let i = 0; i < 2; i++)
                    assert.equal(
                        (
                            await request("POST", "", {
                                ...valid,
                                totalQuantity: 0,
                                availableQuantity: 0,
                                homeFacilityId: null,
                                serialNumber: null,
                            })
                        ).status,
                        201,
                    );
                assert.equal(state.equipment.length, 3);
                assert.ok(
                    !calls.some(
                        (call) => call.method === "facility.findUnique",
                    ),
                );
            },
        );
        await scenario(
            "list pagination and all filters combine correctly with deterministic ordering",
            async () => {
                state.equipment = [5, 1, 4, 2, 3].map((equipmentId) => ({
                    ...initial,
                    equipmentId,
                    categoryId: equipmentId === 5 ? 2 : 1,
                    homeFacilityId: equipmentId === 4 ? null : 1,
                    conditionStatus: equipmentId === 3 ? "Damaged" : "Good",
                }));
                const page = await request(
                    "GET",
                    "?categoryId=1&homeFacilityId=1&conditionStatus=Good&limit=1&page=1",
                );
                assert.equal(page.status, 200);
                assert.deepEqual(
                    page.body.equipment.map((row) => row.equipmentId),
                    [1],
                );
                assert.deepEqual(page.body.pagination, {
                    page: 1,
                    limit: 1,
                    hasMore: true,
                });
                assert.deepEqual(calls[0].query, {
                    where: {
                        categoryId: 1,
                        homeFacilityId: 1,
                        conditionStatus: "Good",
                    },
                    select,
                    orderBy: { equipmentId: "asc" },
                    skip: 0,
                    take: 2,
                });
                assert.deepEqual(
                    (
                        await request("GET", "?homeFacilityId=null")
                    ).body.equipment.map((row) => row.equipmentId),
                    [4],
                );
                assert.deepEqual(
                    (await request("GET", "?categoryId=2")).body.equipment.map(
                        (row) => row.equipmentId,
                    ),
                    [5],
                );
                assert.deepEqual(
                    (
                        await request("GET", "?conditionStatus=Damaged")
                    ).body.equipment.map((row) => row.equipmentId),
                    [3],
                );
                assert.deepEqual(
                    (await request("GET", "?page=99")).body.equipment,
                    [],
                );
                assert.deepEqual(
                    (await request("GET", "?categoryId=999")).body.equipment,
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
            "all three approved roles can read; other roles are denied",
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
            "non-admin writes and role spoofing through valid JWT claims, body, query and headers fail",
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
                assert.deepEqual(state.equipment, [initial]);
            },
        );
        await scenario(
            "missing, malformed, forged and expired JWTs never reach equipment queries",
            async () => {
                const forged = jwt.sign({}, randomBytes(48).toString("hex"), {
                    subject: "7",
                });
                for (const authorization of [
                    null,
                    "Bearer invalid",
                    `Bearer ${forged}`,
                    `Bearer ${sign({}, { expiresIn: -1 })}`,
                ])
                    for (const [method, path] of operations)
                        assert.equal(
                            (await request(method, path, valid, authorization))
                                .status,
                            401,
                        );
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
            "invalid path IDs, pagination and filters are rejected before queries",
            async () => {
                for (const id of [
                    "0",
                    "-1",
                    "01",
                    "1.1",
                    "1e2",
                    "abc",
                    "2147483648",
                ])
                    for (const method of ["GET", "PUT", "DELETE"])
                        assert.equal(
                            (await request(method, `/${id}`, valid)).status,
                            400,
                        );
                for (const query of [
                    "page=0",
                    "page=1.5",
                    "page=1&page=2",
                    "limit=0",
                    "limit=101",
                    "page=2147483647&limit=100",
                    "sort=name",
                    "categoryId=0",
                    "categoryId=null",
                    "categoryId=abc",
                    "categoryId=1&categoryId=2",
                    "homeFacilityId=-1",
                    "homeFacilityId=2147483648",
                    "homeFacilityId[]=1",
                    "conditionStatus=",
                    "conditionStatus=" + "x".repeat(21),
                    "conditionStatus=a%00b",
                    "conditionStatus=Good&conditionStatus=Bad",
                ])
                    assert.equal(
                        (await request("GET", "?" + query)).status,
                        400,
                    );
                assert.deepEqual(calls, []);
            },
        );
        await scenario(
            "unknown, nested, generated, malformed and incorrectly typed writable fields are rejected",
            async () => {
                const bodies = [
                    null,
                    [],
                    {},
                    { ...valid, equipmentId: 2 },
                    { ...valid, createdAt: createdAt.toISOString() },
                    { ...valid, category: { connect: { categoryId: 1 } } },
                    { ...valid, loanItems: { deleteMany: {} } },
                    { ...valid, reservationItems: [] },
                    { ...valid, role: roles[0] },
                ];
                for (const [field, max] of [
                    ["equipmentName", 100],
                    ["serialNumber", 60],
                    ["conditionStatus", 20],
                ])
                    for (const value of [
                        "",
                        " ",
                        1,
                        "x".repeat(max + 1),
                        "a\nb",
                        "a\0b",
                        "\ud800",
                        ...(field === "serialNumber" ? [] : [null]),
                    ])
                        bodies.push({ ...valid, [field]: value });
                for (const field of ["categoryId", "homeFacilityId"])
                    for (const value of [
                        0,
                        -1,
                        1.5,
                        "1",
                        true,
                        2147483648,
                        ...(field === "categoryId" ? [null] : []),
                    ])
                        bodies.push({ ...valid, [field]: value });
                for (const field of ["totalQuantity", "availableQuantity"])
                    for (const value of [-1, 1.5, "1", true, null, 2147483648])
                        bodies.push({ ...valid, [field]: value });
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
            "missing categories, home facilities and empty lookup data fail without creating records",
            async () => {
                for (const body of [
                    { ...valid, categoryId: 99 },
                    { ...valid, homeFacilityId: 99 },
                ])
                    for (const [method, path] of [
                        ["POST", ""],
                        ["PUT", "/1"],
                    ])
                        assert.equal(
                            (await request(method, path, body)).status,
                            400,
                        );
                state.categories = [];
                assert.equal((await request("POST", "", valid)).status, 400);
                noWrites();
                assert.deepEqual(state.equipment, [initial]);
            },
        );
        await scenario(
            "schema text boundaries, maximum integer quantities and custom conditions are supported",
            async () => {
                const result = await request("POST", "", {
                    ...valid,
                    equipmentName: "😀".repeat(100),
                    serialNumber: "雪".repeat(60),
                    conditionStatus: "x".repeat(20),
                    totalQuantity: 2147483647,
                    availableQuantity: 2147483647,
                });
                assert.equal(result.status, 201);
            },
        );
        await scenario(
            "unique serial numbers are enforced on create and update; nulls remain unrestricted",
            async () => {
                assert.equal(
                    (
                        await request("POST", "", {
                            ...valid,
                            serialNumber: " SN-1 ",
                        })
                    ).status,
                    409,
                );
                assert.equal(
                    (
                        await request("POST", "", {
                            ...valid,
                            serialNumber: "SN-2",
                        })
                    ).status,
                    201,
                );
                assert.equal(
                    (await request("PUT", "/2", { serialNumber: "SN-1" }))
                        .status,
                    409,
                );
                assert.equal(state.equipment[1].serialNumber, "SN-2");
            },
        );
        await scenario(
            "creation requires fully available stock and rejects impossible quantities",
            async () => {
                for (const availableQuantity of [9, 11])
                    assert.equal(
                        (
                            await request("POST", "", {
                                ...valid,
                                availableQuantity,
                            })
                        ).status,
                        400,
                    );
                assert.equal(
                    (
                        await request("PUT", "/1", {
                            totalQuantity: 3,
                            availableQuantity: 4,
                        })
                    ).status,
                    400,
                );
                noWrites();
            },
        );
        await scenario(
            "stock adjustments preserve unavailable quantity instead of permitting checkout or return",
            async () => {
                const raised = await request("PUT", "/1", { totalQuantity: 7 });
                assert.equal(raised.status, 200);
                assert.equal(raised.body.equipment.availableQuantity, 7);
                assert.deepEqual(
                    calls
                        .filter((call) => call.method === "equipment.update")
                        .at(-1).query.data,
                    { totalQuantity: 7, availableQuantity: 7 },
                );
                assert.equal(
                    (
                        await request("PUT", "/1", {
                            totalQuantity: 3,
                            availableQuantity: 3,
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    (await request("PUT", "/1", { availableQuantity: 2 }))
                        .status,
                    409,
                );
                assert.equal(state.equipment[0].availableQuantity, 3);
                state.equipment[0].totalQuantity = 5;
                state.equipment[0].availableQuantity = 3;
                const legacy = await request("PUT", "/1", { totalQuantity: 7 });
                assert.equal(legacy.status, 200);
                assert.equal(legacy.body.equipment.availableQuantity, 5);
                assert.equal(
                    (await request("PUT", "/1", { totalQuantity: 1 })).status,
                    400,
                );
                assert.equal(
                    (await request("PUT", "/1", { availableQuantity: 6 }))
                        .status,
                    409,
                );
                assert.equal(
                    (await request("PUT", "/1", { equipmentName: "Renamed" }))
                        .status,
                    200,
                );
            },
        );
        await scenario(
            "any loan, reservation or maintenance history blocks quantity changes but permits metadata/no-op edits",
            async () => {
                for (const model of [
                    "loanItems",
                    "reservationItems",
                    "maintenance",
                ]) {
                    state[model] = [{ equipmentId: 1, requestId: 7 }];
                    assert.equal(
                        (await request("PUT", "/1", { totalQuantity: 6 }))
                            .status,
                        409,
                    );
                    assert.equal(
                        (
                            await request("PUT", "/1", {
                                totalQuantity: 4,
                                availableQuantity: 4,
                            })
                        ).status,
                        409,
                    );
                    assert.equal(
                        (
                            await request("PUT", "/1", {
                                equipmentName: "Same stock",
                                availableQuantity: 5,
                            })
                        ).status,
                        200,
                    );
                    assert.equal(state.equipment[0].totalQuantity, 5);
                    state[model] = [];
                }
            },
        );
        await scenario(
            "stored inconsistent counts and unavailable stock cannot be silently deleted",
            async () => {
                for (const values of [
                    { totalQuantity: 5, availableQuantity: 3 },
                    { totalQuantity: 5, availableQuantity: 6 },
                    { totalQuantity: -1, availableQuantity: -1 },
                ]) {
                    Object.assign(state.equipment[0], values);
                    assert.equal((await request("DELETE", "/1")).status, 409);
                    if (
                        values.availableQuantity > values.totalQuantity ||
                        values.totalQuantity < 0
                    )
                        assert.equal(
                            (
                                await request("PUT", "/1", {
                                    equipmentName: "No repair",
                                })
                            ).status,
                            409,
                        );
                }
                noWrites();
            },
        );
        await scenario(
            "foreign keys block all dependent deletions without cascading or unlinking",
            async () => {
                for (const model of [
                    "loanItems",
                    "reservationItems",
                    "maintenance",
                ]) {
                    state[model] = [{ equipmentId: 1, requestId: 7 }];
                    const result = await request("DELETE", "/1");
                    assert.equal(result.status, 409);
                    assert.match(result.body.message, /dependent records/);
                    assert.equal(state[model].length, 1);
                    assert.deepEqual(state.equipment, [initial]);
                    state[model] = [];
                }
            },
        );
        await scenario(
            "late parent and dependent inserts yield safe foreign-key conflicts",
            async () => {
                beforeWrite = async (method, snapshot) => {
                    await new Promise((resolve) => setImmediate(resolve));
                    if (method === "delete")
                        snapshot.loanItems.push({ equipmentId: 1 });
                    else snapshot.categories = [];
                };
                assert.equal((await request("DELETE", "/1")).status, 409);
                assert.equal((await request("POST", "", valid)).status, 409);
                assert.equal(
                    (await request("PUT", "/1", { equipmentName: "No commit" }))
                        .status,
                    409,
                );
                assert.deepEqual(state.equipment, [initial]);
            },
        );
        await scenario(
            "missing records return 404 and update does not upsert",
            async () => {
                for (const method of ["GET", "PUT", "DELETE"])
                    assert.equal(
                        (await request(method, "/99", valid)).status,
                        404,
                    );
                noWrites();
                assert.deepEqual(state.equipment, [initial]);
            },
        );
        await scenario(
            "transaction conflicts roll back creates, updates and deletes without retries",
            async () => {
                failCommit = true;
                for (const [method, path] of operations.slice(2)) {
                    const result = await request(method, path, valid);
                    assert.equal(result.status, 409);
                    assert.match(result.body.message, /Concurrent changes/);
                    assert.deepEqual(state.equipment, [initial]);
                }
                assert.equal(
                    calls.filter((call) => call.method === "transaction")
                        .length,
                    3,
                );
            },
        );
        await scenario(
            "overlapping stock edits handle either simulated commit winner without stock drift",
            async () => {
                for (const winner of [6, 7]) {
                    reset();
                    race = {
                        winner,
                        arrivals: 0,
                        barrier: Promise.withResolvers(),
                    };
                    const results = await Promise.all([
                        request("PUT", "/1", { totalQuantity: 6 }),
                        request("PUT", "/1", { totalQuantity: 7 }),
                    ]);
                    assert.deepEqual(
                        results.map((result) => result.status).sort(),
                        [200, 409],
                    );
                    assert.equal(state.equipment[0].totalQuantity, winner);
                    assert.equal(state.equipment[0].availableQuantity, winner);
                    assert.equal(
                        calls.filter((call) => call.method === "transaction")
                            .length,
                        2,
                    );
                    assert.equal(
                        calls.filter((call) => call.method === "commit").length,
                        1,
                    );
                    race = null;
                }
            },
        );
        await scenario(
            "reductions may reach unavailable stock exactly but cannot erase or return it",
            async () => {
                state.equipment[0].availableQuantity = 3;
                const boundary = await request("PUT", "/1", {
                    totalQuantity: 2,
                });
                assert.equal(boundary.status, 200);
                assert.equal(boundary.body.equipment.availableQuantity, 0);
                const snapshot = structuredClone(state);
                const writesBefore = calls.filter(
                    (call) => call.method === "equipment.update",
                ).length;
                for (const body of [
                    { totalQuantity: 1, equipmentName: "Rejected rename" },
                    { totalQuantity: 0, availableQuantity: 0 },
                ])
                    assert.equal(
                        (await request("PUT", "/1", body)).status,
                        400,
                    );
                assert.equal(
                    (await request("PUT", "/1", { availableQuantity: 1 }))
                        .status,
                    409,
                );
                assert.equal((await request("DELETE", "/1")).status, 409);
                assert.deepEqual(state, snapshot);
                assert.equal(
                    calls.filter((call) => call.method === "equipment.update")
                        .length,
                    writesBefore,
                );
            },
        );
        await scenario(
            "a unique serial conflict rolls back a combined stock and metadata edit",
            async () => {
                state.equipment.push({
                    ...initial,
                    equipmentId: 2,
                    serialNumber: "SN-2",
                });
                const snapshot = structuredClone(state);
                const result = await request("PUT", "/1", {
                    totalQuantity: 8,
                    serialNumber: "SN-2",
                    equipmentName: "Rejected rename",
                });
                assert.equal(result.status, 409);
                assert.deepEqual(state, snapshot);
                assert.equal(
                    calls.filter((call) => call.method === "transaction")
                        .length,
                    1,
                );
                assert.equal(
                    calls.filter((call) => call.method === "rollback").length,
                    1,
                );
                assert.equal(
                    calls.filter((call) => call.method === "commit").length,
                    0,
                );
            },
        );
        await scenario(
            "completed history still blocks stock edits and deletion even at zero stock",
            async () => {
                // Illustrative closed-history markers, not lifecycle rules or seeds.
                const references = [
                    [
                        "loanItems",
                        {
                            equipmentId: 1,
                            loan: {
                                returnDate: createdAt,
                                loanStatus: "Returned",
                            },
                        },
                        "loanItem.findFirst",
                    ],
                    [
                        "reservationItems",
                        {
                            equipmentId: 1,
                            reservation: {
                                status: { statusName: "Completed" },
                            },
                        },
                        "reservationEquipment.findFirst",
                    ],
                    [
                        "maintenance",
                        { equipmentId: 1, requestId: 7, status: "Closed" },
                        "maintenanceRequest.findFirst",
                    ],
                ];
                for (const [model, record, queryMethod] of references) {
                    reset();
                    state[model] = [record];
                    assert.equal(
                        (await request("PUT", "/1", { totalQuantity: 6 }))
                            .status,
                        409,
                    );
                    const query = calls.find(
                        (call) => call.method === queryMethod,
                    ).query;
                    assert.deepEqual(query.where, { equipmentId: 1 });
                    assert.equal(
                        (
                            await request("PUT", "/1", {
                                equipmentName: "Metadata only",
                            })
                        ).status,
                        200,
                    );
                    assert.equal(state.equipment[0].totalQuantity, 5);
                    assert.equal(state.equipment[0].availableQuantity, 5);
                    state.equipment[0].totalQuantity =
                        state.equipment[0].availableQuantity = 0;
                    assert.equal((await request("DELETE", "/1")).status, 409);
                    assert.equal(state[model].length, 1);
                    assert.equal(state.equipment.length, 1);
                }
            },
        );
        await scenario(
            "a home facility removed after validation rejects and rolls back stock edits",
            async () => {
                const snapshot = structuredClone(state);
                beforeWrite = async (method, pending) => {
                    assert.equal(method, "update");
                    pending.facilities = [];
                };
                const result = await request("PUT", "/1", {
                    totalQuantity: 6,
                    homeFacilityId: 1,
                });
                assert.equal(result.status, 409);
                assert.deepEqual(state, snapshot);
                assert.equal(
                    calls.filter((call) => call.method === "commit").length,
                    0,
                );
            },
        );
        await scenario(
            "unexpected commit failures are sanitized and never automatically retried",
            async () => {
                failCommit = "P2028";
                const result = await request("PUT", "/1", { totalQuantity: 6 });
                assert.equal(result.status, 500);
                assert.deepEqual(result.body, {
                    success: false,
                    message: "Internal server error.",
                });
                assert.deepEqual(state.equipment, [initial]);
                assert.equal(
                    calls.filter((call) => call.method === "transaction")
                        .length,
                    1,
                );
                assert.equal(
                    calls.filter((call) => call.method === "rollback").length,
                    1,
                );
                assert.equal(
                    calls.filter((call) => call.method === "commit").length,
                    0,
                );
            },
        );
        await scenario(
            "query failures and unexpected Prisma metadata never leak in API responses",
            async () => {
                for (const stage of [
                    "equipment.findMany",
                    "equipment.findUnique",
                    "equipment.create",
                    "equipment.update",
                    "equipment.delete",
                    "equipmentCategory.findUnique",
                    "facility.findUnique",
                    "transaction",
                    "auth",
                    "loanItem.findFirst",
                    "reservationEquipment.findFirst",
                    "maintenanceRequest.findFirst",
                ]) {
                    reset();
                    failure = stage;
                    let method = "POST",
                        path = "",
                        body = valid;
                    if (stage === "equipment.findMany") method = "GET";
                    if (stage === "equipment.findUnique") {
                        method = "GET";
                        path = "/1";
                    }
                    if (
                        stage === "equipment.update" ||
                        stage.endsWith("findFirst")
                    ) {
                        method = "PUT";
                        path = "/1";
                        body = { totalQuantity: 6 };
                    }
                    if (stage === "equipment.delete") {
                        method = "DELETE";
                        path = "/1";
                    }
                    if (stage === "facility.findUnique")
                        body = { ...valid, homeFacilityId: 1 };
                    const result = await request(method, path, body);
                    assert.equal(result.status, 500);
                    assert.deepEqual(result.body, {
                        success: false,
                        message: "Internal server error.",
                    });
                    assert.deepEqual(state.equipment, [initial]);
                }
                for (const code of [
                    "P2000",
                    "P2021",
                    "P2022",
                    "P2028",
                    "PRIVATE-unknown-code",
                ]) {
                    reset();
                    failure = "equipment.create";
                    failureCode = code;
                    const result = await request("POST", "", valid);
                    assert.equal(result.status, 500);
                    assert.deepEqual(result.body, {
                        success: false,
                        message: "Internal server error.",
                    });
                }
            },
        );
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
