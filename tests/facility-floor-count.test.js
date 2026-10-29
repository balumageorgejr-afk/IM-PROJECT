const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

// Deliberately overlap the real route callbacks against old snapshots. The mock
// supplies a P2034 at commit for either loser; it does NOT implement PostgreSQL SSI.
// This verifies both routes' isolation, rollback response, and no-retry behavior.
test("cross-module floor-count races handle either serialization-conflict loser", async (t) => {
    for (const operation of ["create", "move"]) {
        for (const winner of ["building", "facility"]) {
            await t.test(
                `${operation}: ${winner} commits; the other request returns 409`,
                async () => {
                    let state = {
                        buildings: [
                            {
                                buildingId: 1,
                                buildingName: "Main",
                                floorCount: 3,
                                locationNote: null,
                            },
                            {
                                buildingId: 2,
                                buildingName: "Annex",
                                floorCount: 1,
                                locationNote: null,
                            },
                        ],
                        facilities:
                            operation === "move"
                                ? [
                                      {
                                          facilityId: 1,
                                          buildingId: 2,
                                          facilityTypeId: 1,
                                          facilityName: "Room",
                                          floorNumber: 1,
                                          capacity: 20,
                                          status: "Available",
                                          createdAt: new Date(
                                              "2026-10-25T00:00:00Z",
                                          ),
                                      },
                                  ]
                                : [],
                    };
                    const barrier = Promise.withResolvers();
                    let arrivals = 0,
                        attempts = 0;
                    const commits = [];
                    const prisma = {
                        user: {
                            findUnique: async () => ({
                                userId: 7,
                                fname: "Test",
                                lname: "Admin",
                                email: "fixture@example.test",
                                isActive: true,
                                role: {
                                    roleId: 1,
                                    roleName: "System Administrator",
                                },
                            }),
                        },
                        $transaction: async (run, options) => {
                            const attempt = ++attempts;
                            assert.deepEqual(options, {
                                isolationLevel: "Serializable",
                                maxWait: 10000,
                                timeout: 15000,
                            });
                            const snapshot = structuredClone(state);
                            let kind;
                            const tx = {
                                building: {
                                    findUnique: async (query) => {
                                        kind = "facility";
                                        assert.deepEqual(query.select, {
                                            buildingId: true,
                                            floorCount: true,
                                        });
                                        return (
                                            snapshot.buildings.find(
                                                (row) =>
                                                    row.buildingId ===
                                                    query.where.buildingId,
                                            ) || null
                                        );
                                    },
                                    update: async (query) => {
                                        assert.equal(kind, "building");
                                        const row = snapshot.buildings.find(
                                            (row) =>
                                                row.buildingId ===
                                                query.where.buildingId,
                                        );
                                        Object.assign(row, query.data);
                                        return structuredClone(row);
                                    },
                                },
                                facilityType: {
                                    findUnique: async () => ({
                                        facilityTypeId: 1,
                                    }),
                                },
                                facility: {
                                    findFirst: async (query) => {
                                        kind = "building";
                                        assert.deepEqual(query, {
                                            where: {
                                                buildingId: 1,
                                                floorNumber: { gt: 2 },
                                            },
                                            select: { facilityId: true },
                                        });
                                        return (
                                            snapshot.facilities.find(
                                                (row) =>
                                                    row.buildingId ===
                                                        query.where
                                                            .buildingId &&
                                                    row.floorNumber >
                                                        query.where.floorNumber
                                                            .gt,
                                            ) || null
                                        );
                                    },
                                    findUnique: async (query) => {
                                        kind = "facility";
                                        return (
                                            snapshot.facilities.find(
                                                (row) =>
                                                    row.facilityId ===
                                                    query.where.facilityId,
                                            ) || null
                                        );
                                    },
                                    create: async (query) => {
                                        assert.equal(kind, "facility");
                                        const row = {
                                            facilityId: 1,
                                            status: "Available",
                                            createdAt: new Date(
                                                "2026-10-25T00:00:00Z",
                                            ),
                                            ...query.data,
                                        };
                                        snapshot.facilities.push(row);
                                        return row;
                                    },
                                    update: async (query) => {
                                        assert.equal(kind, "facility");
                                        const row = snapshot.facilities.find(
                                            (row) =>
                                                row.facilityId ===
                                                query.where.facilityId,
                                        );
                                        Object.assign(row, query.data);
                                        return structuredClone(row);
                                    },
                                },
                            };
                            const result = await run(tx);
                            if (attempt <= 2) {
                                if (++arrivals === 2) barrier.resolve();
                                await barrier.promise;
                                if (kind !== winner)
                                    throw Object.assign(
                                        new Error(
                                            "PRIVATE-serialization-details",
                                        ),
                                        { code: "P2034" },
                                    );
                            }
                            state = snapshot;
                            commits.push(kind);
                            return result;
                        },
                    };
                    const secret = randomBytes(48).toString("hex");
                    const token = jwt.sign({}, secret, {
                        algorithm: "HS256",
                        subject: "7",
                        issuer: "im101-api",
                        audience: "im101-client",
                        expiresIn: "15m",
                    });
                    const app = createApp({
                        jwtSecret: secret,
                        getPrisma: () => prisma,
                    });
                    const server = app.listen(0, "127.0.0.1");
                    await new Promise((resolve, reject) => {
                        server.once("listening", resolve);
                        server.once("error", reject);
                    });
                    async function request(path, method, body) {
                        const response = await fetch(
                            `http://127.0.0.1:${server.address().port}${path}`,
                            {
                                method,
                                headers: {
                                    Authorization: `Bearer ${token}`,
                                    "Content-Type": "application/json",
                                },
                                body: JSON.stringify(body),
                                signal: AbortSignal.timeout(5000),
                            },
                        );
                        const result = await response.json();
                        assert.ok(!JSON.stringify(result).includes("PRIVATE-"));
                        assert.ok(!JSON.stringify(result).includes(token));
                        return { status: response.status, body: result };
                    }
                    const buildingRequest = () =>
                        request("/api/buildings/1", "PUT", { floorCount: 2 });
                    const facilityRequest = () =>
                        request(
                            operation === "create"
                                ? "/api/facilities"
                                : "/api/facilities/1",
                            operation === "create" ? "POST" : "PUT",
                            operation === "create"
                                ? {
                                      buildingId: 1,
                                      facilityTypeId: 1,
                                      facilityName: "Room",
                                      floorNumber: 3,
                                      capacity: 20,
                                  }
                                : { buildingId: 1, floorNumber: 3 },
                        );
                    try {
                        const [building, facility] = await Promise.all([
                            buildingRequest(),
                            facilityRequest(),
                        ]);
                        assert.equal(
                            building.status,
                            winner === "building" ? 200 : 409,
                        );
                        assert.equal(
                            facility.status,
                            winner === "facility"
                                ? operation === "create"
                                    ? 201
                                    : 200
                                : 409,
                        );
                        assert.equal(attempts, 2);
                        assert.deepEqual(commits, [winner]);
                        for (const row of state.facilities)
                            assert.ok(
                                row.floorNumber <=
                                    state.buildings.find(
                                        (building) =>
                                            building.buildingId ===
                                            row.buildingId,
                                    ).floorCount,
                            );
                        // A fresh, operator-initiated attempt now sees the winning state.
                        if (winner === "building")
                            assert.equal((await facilityRequest()).status, 400);
                        else
                            assert.equal((await buildingRequest()).status, 409);
                        assert.deepEqual(commits, [winner]);
                    } finally {
                        server.closeAllConnections();
                        await new Promise((resolve) => server.close(resolve));
                    }
                },
            );
        }
    }
});
