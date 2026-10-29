const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rootCertificates } = require("node:tls");
const { verifyCrud, runLiveCrud } = require("../scripts/verify-live-crud");
const runId = "12345678-1234-4123-8123-123456789abc";
function fixture(options = {}) {
    const calls = [],
        entries = [],
        rows = new Map();
    let next = 100;
    const metadata = {
        buildings: ["building", "buildingId"],
        facilities: ["facility", "facilityId"],
        equipment: ["equipment", "equipmentId"],
    };
    const request = async (method, path, body) => {
        calls.push({ method, path, body: structuredClone(body) });
        if (options.fail === method) throw new Error("PRIVATE");
        const [, , collection, id] = path.split("/");
        const [key, idField] = metadata[collection];
        let row;
        if (method === "POST") {
            row = {
                ...body,
                [idField]: next++,
                ...(collection !== "buildings"
                    ? { createdAt: "2026-10-25T00:00:00.000Z" }
                    : {}),
            };
            rows.set(`/api/${collection}/${row[idField]}`, row);
        } else {
            assert.ok((id && rows.has(path)) || method === "GET");
            row = rows.get(path);
            if (!row)
                return {
                    status: 404,
                    body: {
                        success: false,
                        message: `${key[0].toUpperCase()}${key.slice(1)} not found.`,
                    },
                };
            if (method === "PUT") {
                row = { ...row, ...body };
                rows.set(path, row);
            }
            if (method === "DELETE") rows.delete(path);
        }
        row = structuredClone(row);
        if (options.mismatch && method === options.mismatch)
            row[idField] = 999999;
        return {
            status: method === "POST" ? 201 : 200,
            body: { success: true, [key]: row },
        };
    };
    return {
        calls,
        entries,
        rows,
        request,
        run: (overrides = {}) =>
            verifyCrud({
                request,
                record: (entry) => {
                    if (options.receiptFail === entry.action)
                        throw new Error("PRIVATE receipt");
                    entries.push(structuredClone(entry));
                },
                runId,
                facilityTypeId: 71,
                categoryId: 81,
                ...overrides,
            }),
    };
}
test("mock-only CRUD verifies all three APIs and deletes only returned IDs in reverse order", async () => {
    const f = fixture();
    await f.run();
    assert.equal(f.rows.size, 0);
    const posts = f.calls.filter((call) => call.method === "POST");
    assert.equal(posts.length, 3);
    assert.equal(posts[1].body.buildingId, 100);
    assert.equal(posts[2].body.homeFacilityId, 101);
    assert.equal(posts[1].body.facilityTypeId, 71);
    assert.equal(posts[2].body.categoryId, 81);
    for (const call of posts)
        assert.match(JSON.stringify(call.body), /IM101-DISPOSABLE-/);
    assert.deepEqual(
        f.calls
            .filter((call) => call.method === "DELETE")
            .map((call) => call.path),
        ["/api/equipment/102", "/api/facilities/101", "/api/buildings/100"],
    );
    assert.equal(
        f.entries.filter((entry) => entry.action === "created").length,
        3,
    );
    for (const [index, call] of f.calls.entries()) {
        if (["PUT", "DELETE"].includes(call.method)) {
            assert.equal(f.calls[index - 1].method, "GET");
            assert.equal(f.calls[index - 1].path, call.path);
        }
    }
});
test("bad lookup IDs or marker stop before any request", async () => {
    for (const overrides of [
        { runId: "real-campus-name" },
        { facilityTypeId: 0 },
        { categoryId: -1 },
    ]) {
        const f = fixture();
        await assert.rejects(f.run(overrides));
        assert.equal(f.calls.length, 0);
    }
});
test("mismatched ownership, lost responses, and receipt failures stop without failure cleanup", async () => {
    for (const options of [
        { mismatch: "GET" },
        { fail: "POST" },
        { fail: "PUT" },
        { receiptFail: "intent" },
        { receiptFail: "created" },
    ]) {
        const f = fixture(options);
        await assert.rejects(f.run());
        assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 0);
        if (options.mismatch)
            assert.equal(f.calls.filter((c) => c.method === "PUT").length, 0);
        if (options.receiptFail === "intent") assert.equal(f.calls.length, 0);
    }
});
test("unexpected status, unsuccessful response and delete conflicts abort without retries", async () => {
    for (const failure of ["status", "success", "conflict"]) {
        const f = fixture();
        await assert.rejects(
            f.run({
                request: async (...args) => {
                    if (failure === "conflict" && args[0] === "DELETE")
                        return { status: 409, body: { success: false } };
                    const result = await f.request(...args);
                    if (failure === "status") result.status = 500;
                    if (failure === "success") result.body.success = false;
                    return result;
                },
            }),
        );
        assert.ok(f.calls.filter((call) => call.method === "POST").length <= 3);
        assert.equal(
            f.calls.filter((call) => call.method === "DELETE").length,
            0,
        );
    }
});

test("changed data before deletion, failed delete responses and failed intent receipts never delete parents", async () => {
    for (const failure of [
        "changed-before-delete",
        "lost-delete-response",
        "delete-intent-receipt",
    ]) {
        const f = fixture();
        let updates = 0;
        await assert.rejects(
            f.run({
                request: async (...args) => {
                    if (args[0] === "PUT") updates++;
                    const response = await f.request(...args);
                    if (
                        failure === "changed-before-delete" &&
                        updates === 3 &&
                        args[0] === "GET" &&
                        args[1].includes("/equipment/")
                    ) {
                        response.body.equipment.conditionStatus =
                            "Changed by another operator";
                    }
                    if (
                        failure === "lost-delete-response" &&
                        args[0] === "DELETE"
                    )
                        throw new Error("PRIVATE");
                    return response;
                },
                record: (entry) => {
                    if (
                        failure === "delete-intent-receipt" &&
                        entry.action === "delete-intent"
                    )
                        throw new Error("PRIVATE");
                },
            }),
        );
        assert.equal(
            f.calls.filter((call) => call.method === "DELETE").length,
            failure === "lost-delete-response" ? 1 : 0,
        );
        assert.ok(f.rows.has("/api/buildings/100"));
        assert.ok(f.rows.has("/api/facilities/101"));
    }
});

const projectRef = "abcdefghijklmnopqrst";
const input = {
    projectRef,
    approval: `CREATE UPDATE DELETE DISPOSABLE RECORDS IN ${projectRef}`,
    email: "admin@example.test",
    password: "PRIVATE",
};
const env = {
    DATABASE_URL: `postgresql://postgres:PRIVATE@db.${projectRef}.supabase.co/postgres?sslmode=verify-full`,
    NODE_EXTRA_CA_CERTS: "fixture",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
};
test("live orchestration is mocked: approvals/config gate startup; auth and lookups gate writes", async () => {
    for (const failure of [
        "approval",
        "tls",
        "identity",
        "login",
        "role",
        "profile",
        "lookup",
        "receipt",
        "none",
    ]) {
        const f = fixture();
        let starts = 0,
            closes = 0,
            tokens = 0;
        const user = {
            userId: 7,
            email: input.email,
            role: {
                roleName: failure === "role" ? "Staff" : "System Administrator",
            },
        };
        const result = await runLiveCrud({
            input: {
                ...input,
                ...(failure === "approval" ? { approval: "" } : {}),
            },
            env: {
                ...env,
                ...(failure === "tls"
                    ? { NODE_TLS_REJECT_UNAUTHORIZED: "0" }
                    : {}),
                ...(failure === "identity"
                    ? {
                          DATABASE_URL: env.DATABASE_URL.replace(
                              projectRef,
                              "wrong",
                          ),
                      }
                    : {}),
            },
            readCa: () => rootCertificates[0],
            start: async (config) => {
                starts++;
                assert.equal(config.ssl.rejectUnauthorized, true);
                return {
                    request: async (method, path, data) => {
                        if (path === "/api/auth/login")
                            return {
                                status: failure === "login" ? 401 : 200,
                                body: {
                                    success: true,
                                    token: "PRIVATE-token",
                                    user,
                                },
                            };
                        if (path === "/api/auth/me")
                            return {
                                status: failure === "profile" ? 401 : 200,
                                body: { success: true, user },
                            };
                        return f.request(method, path, data);
                    },
                    setToken: () => {
                        tokens++;
                    },
                    lookups: async () => ({
                        facilityTypeId: failure === "lookup" ? undefined : 71,
                        categoryId: 81,
                    }),
                    close: async () => {
                        closes++;
                    },
                };
            },
            openReceipt: () => {
                if (failure === "receipt") throw new Error("PRIVATE");
                return { record: (e) => f.entries.push(e), close: () => {} };
            },
        });
        assert.equal(result.success, failure === "none");
        assert.doesNotMatch(result.message, /PRIVATE/);
        assert.equal(
            starts,
            ["approval", "tls", "identity"].includes(failure) ? 0 : 1,
        );
        assert.equal(closes, starts);
        if (failure !== "none") assert.equal(f.calls.length, 0);
        else {
            assert.equal(tokens, 1);
            assert.equal(f.rows.size, 0);
        }
    }
});

// Independent expected fields: deliberately not imported from the runner.
const fields = {
    buildings: ["buildingId", "buildingName", "floorCount", "locationNote"],
    facilities: [
        "facilityId",
        "buildingId",
        "facilityTypeId",
        "facilityName",
        "floorNumber",
        "capacity",
        "status",
        "createdAt",
    ],
    equipment: [
        "equipmentId",
        "categoryId",
        "homeFacilityId",
        "equipmentName",
        "serialNumber",
        "totalQuantity",
        "availableQuantity",
        "conditionStatus",
        "createdAt",
    ],
};
const collections = Object.keys(fields);
const keys = {
    buildings: "building",
    facilities: "facility",
    equipment: "equipment",
};
const secret = "PRIVATE_RESPONSE_VALUE_SENTINEL";
const secretName = "PRIVATE_RESPONSE_FIELD_SENTINEL";

function noLeak(error, entries) {
    for (const value of [
        error.message,
        error.stack,
        JSON.stringify(error),
        JSON.stringify(entries),
    ]) {
        assert.ok(!value.includes(secret));
        assert.ok(!value.includes(secretName));
    }
    // No AssertionError actual/expected/cause objects retaining responses.
    assert.deepEqual(Object.keys(error), ["code"]);
}

async function rejectedResponse(index, transform, expectedCode) {
    const f = fixture();
    let error;
    try {
        await f.run({
            request: async (...args) => {
                const response = await f.request(...args);
                if (f.calls.length - 1 === index)
                    transform(response, args[1].split("/")[2]);
                return response;
            },
        });
    } catch (caught) {
        error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, expectedCode);
    assert.equal(
        f.calls.length,
        index + 1,
        "must stop immediately without retries or failure cleanup",
    );
    noLeak(error, f.entries);
    return f;
}

test("secret fields in every HTTP envelope or management snapshot stop without leaking or further requests", async () => {
    const baseline = fixture();
    await baseline.run();
    for (let index = 0; index < baseline.calls.length; index++) {
        await rejectedResponse(
            index,
            (response) => {
                response.body[secretName] = secret;
            },
            "RESPONSE_UNEXPECTED_FIELDS",
        );
        if (
            baseline.calls[index].method === "GET" &&
            [
                "/api/equipment/102",
                "/api/facilities/101",
                "/api/buildings/100",
            ].includes(baseline.calls[index].path) &&
            baseline.calls[index - 1]?.method === "DELETE"
        )
            continue;
        const f = await rejectedResponse(
            index,
            (response, collection) => {
                response.body[keys[collection]][secretName] = secret;
            },
            "RESPONSE_UNEXPECTED_FIELDS",
        );
        // DELETE may already have happened, but never record its unvalidated response.
        if (baseline.calls[index].method === "DELETE") {
            const count = baseline.calls
                .slice(0, index)
                .filter((call) => call.method === "DELETE").length;
            assert.equal(
                f.entries.filter((entry) => entry.action === "deleted").length,
                count,
            );
        }
    }
});

test("all required fields are mandatory on each model's creation response", async () => {
    for (const [index, collection] of collections.entries()) {
        for (const field of fields[collection]) {
            await rejectedResponse(
                index,
                (response) => {
                    delete response.body[keys[collection]][field];
                },
                "RESPONSE_MISSING_FIELDS",
            );
        }
    }
});

test("credential-shaped fields and nested relationships are rejected without naming them in errors", async () => {
    for (const name of [
        "password",
        "passwordHash",
        "jwt",
        "token",
        "connectionString",
        "DATABASE_URL",
        "user",
        "facilities",
    ]) {
        for (let index = 0; index < 3; index++) {
            await rejectedResponse(
                index,
                (response, collection) => {
                    response.body[keys[collection]][name] = { value: secret };
                },
                "RESPONSE_UNEXPECTED_FIELDS",
            );
        }
    }
});

test("incorrect scalar types, bounds, timestamp formats and malformed records are rejected", async () => {
    const invalid = {
        buildings: {
            buildingId: ["100", 0, -1, 2147483648, NaN],
            buildingName: [null, {}, true, secret + "\n"],
            floorCount: ["2", 0, 32768, 1.5],
            locationNote: [{ password: secret }, 2],
        },
        facilities: {
            facilityId: ["101", -1],
            buildingId: ["100", null],
            facilityTypeId: [0, "71"],
            facilityName: [null, []],
            floorNumber: [0, 32768],
            capacity: ["1", -1],
            status: [false, {}],
            createdAt: [
                secret,
                new Date(),
                "2026-02-30T00:00:00.000Z",
                "2026-10-25T00:00:00Z",
                null,
            ],
        },
        equipment: {
            equipmentId: ["102", 0],
            categoryId: ["81", -1],
            homeFacilityId: ["101", 0],
            equipmentName: [false, {}],
            serialNumber: [[], 123],
            totalQuantity: ["1", -1, 1.5],
            availableQuantity: ["1", -1],
            conditionStatus: [null, {}],
            createdAt: [secret, {}, null],
        },
    };
    for (const [index, collection] of collections.entries()) {
        for (const [field, values] of Object.entries(invalid[collection])) {
            for (const value of values)
                await rejectedResponse(
                    index,
                    (response) => {
                        response.body[keys[collection]][field] = value;
                    },
                    "RESPONSE_FIELD_TYPE",
                );
        }
        for (const row of [null, [], secret, 42])
            await rejectedResponse(
                index,
                (response) => {
                    response.body[keys[collection]] = row;
                },
                "RESPONSE_SHAPE",
            );
    }
});

test("validly typed but altered names, relationships, quantities and metadata never enter snapshots", async () => {
    const altered = {
        buildings: { buildingName: secret, floorCount: 3, locationNote: null },
        facilities: {
            buildingId: 999,
            facilityTypeId: 999,
            facilityName: secret,
            floorNumber: 2,
            capacity: 3,
            status: secret.slice(0, 15),
        },
        equipment: {
            categoryId: 999,
            homeFacilityId: null,
            equipmentName: secret,
            serialNumber: null,
            totalQuantity: 2,
            availableQuantity: 0,
            conditionStatus: "Other",
        },
    };
    for (const [index, collection] of collections.entries())
        for (const [field, value] of Object.entries(altered[collection])) {
            await rejectedResponse(
                index,
                (response) => {
                    response.body[keys[collection]][field] = value;
                },
                "RESPONSE_IDENTITY",
            );
        }
    // All six pre-PUT/DELETE guards must check both the ID and generated timestamp.
    for (const index of [3, 6, 9, 12, 15, 18]) {
        await rejectedResponse(
            index,
            (response, collection) => {
                response.body[keys[collection]][fields[collection][0]] = 1;
            },
            "RESPONSE_IDENTITY",
        );
        if (![3, 18].includes(index))
            await rejectedResponse(
                index,
                (response, collection) => {
                    response.body[keys[collection]].createdAt =
                        "2026-10-24T00:00:00.000Z";
                },
                "RESPONSE_IDENTITY",
            );
    }
});

test("accessors, symbols, inherited fields, hidden fields and toJSON hooks cannot smuggle data into receipts", async () => {
    let invoked = 0;
    for (const [transform, code] of [
        [
            (row) => {
                row.toJSON = () => {
                    invoked++;
                    return { password: secret };
                };
            },
            "RESPONSE_UNEXPECTED_FIELDS",
        ],
        [
            (row) => {
                Object.defineProperty(row, secretName, { value: secret });
            },
            "RESPONSE_UNEXPECTED_FIELDS",
        ],
        [
            (row) => {
                row[Symbol(secretName)] = secret;
            },
            "RESPONSE_UNEXPECTED_FIELDS",
        ],
        [
            (row) => {
                Object.setPrototypeOf(row, { [secretName]: secret });
            },
            "RESPONSE_SHAPE",
        ],
        [
            (row) => {
                Object.defineProperty(row, "buildingName", {
                    get: () => {
                        invoked++;
                        return secret;
                    },
                });
            },
            "RESPONSE_SHAPE",
        ],
    ])
        await rejectedResponse(
            0,
            (response) => transform(response.body.building),
            code,
        );
    assert.equal(invoked, 0);
});

test("receipt snapshots contain exactly the approved fields and detach from raw response objects", async () => {
    const f = fixture();
    const raw = [];
    await f.run({
        request: async (...args) => {
            const response = await f.request(...args);
            raw.push(response);
            return response;
        },
        record: (entry) => {
            if (entry.row) {
                assert.ok(Object.isFrozen(entry.row));
                assert.deepEqual(
                    Object.keys(entry.row).sort(),
                    fields[entry.collection].slice().sort(),
                );
                const latest = raw.at(-1).body[keys[entry.collection]];
                assert.notEqual(entry.row, latest);
                latest[secretName] = secret;
            }
            f.entries.push(structuredClone(entry));
        },
    });
    assert.doesNotMatch(JSON.stringify(f.entries), /PRIVATE_RESPONSE_/);
    assert.equal(f.rows.size, 0);
});

test("lost responses at every request stop immediately, including all uncertain DELETE outcomes", async () => {
    const baseline = fixture();
    await baseline.run();
    for (let index = 0; index < baseline.calls.length; index++)
        for (const after of [false, true]) {
            const f = fixture();
            let attempts = 0;
            await assert.rejects(
                f.run({
                    request: async (...args) => {
                        const current = attempts++;
                        if (current === index && !after)
                            throw new Error(secret);
                        const response = await f.request(...args);
                        if (current === index && after) throw new Error(secret);
                        return response;
                    },
                }),
                (error) => {
                    assert.equal(error.code, "HTTP_RESPONSE_UNCERTAIN");
                    noLeak(error, f.entries);
                    return true;
                },
            );
            assert.equal(attempts, index + 1);
            if (baseline.calls[index].method === "DELETE") {
                const path = baseline.calls[index].path;
                assert.equal(f.rows.has(path), !after);
                assert.equal(
                    f.entries.filter((entry) => entry.action === "deleted")
                        .length,
                    baseline.calls
                        .slice(0, index)
                        .filter((call) => call.method === "DELETE").length,
                );
            }
        }
});

test("every receipt write failure preserves earlier validated entries and stops without recovery writes", async () => {
    const baseline = fixture();
    await baseline.run();
    for (let index = 0; index < baseline.entries.length; index++) {
        const f = fixture();
        let attempted = 0;
        await assert.rejects(
            f.run({
                record: (entry) => {
                    if (attempted++ === index) throw new Error(secret);
                    f.entries.push(structuredClone(entry));
                },
            }),
            (error) => {
                assert.equal(error.code, "RECEIPT_WRITE_FAILED");
                noLeak(error, f.entries);
                return true;
            },
        );
        assert.deepEqual(f.entries, baseline.entries.slice(0, index));
        assert.equal(attempted, index + 1);
    }
});

test("orchestration diagnostics, lookup receipts and cleanup failures never expose response or credential data", async () => {
    for (const failure of [
        "extra-field",
        "wrong-type",
        "missing-field",
        "identity",
        "receipt-start",
        "receipt-complete",
        "http",
        "cleanup",
        "none",
    ]) {
        const f = fixture();
        const saved = [];
        let closed = 0;
        const user = {
            email: input.email,
            role: { roleName: "System Administrator" },
        };
        const result = await runLiveCrud({
            input: { ...input, password: secret },
            env,
            readCa: () => rootCertificates[0],
            start: async () => ({
                request: async (...args) => {
                    if (args[1] === "/api/auth/login")
                        return {
                            status: 200,
                            body: { success: true, user, token: secret },
                        };
                    if (args[1] === "/api/auth/me")
                        return { status: 200, body: { success: true, user } };
                    if (failure === "http") throw new Error(secret);
                    const response = await f.request(...args);
                    if (f.calls.length === 1) {
                        if (failure === "extra-field")
                            response.body.building[secretName] = secret;
                        if (failure === "wrong-type")
                            response.body.building.floorCount = secret;
                        if (failure === "missing-field")
                            delete response.body.building.buildingName;
                        if (failure === "identity")
                            response.body.building.buildingName = secret;
                    }
                    return response;
                },
                setToken: () => {},
                lookups: async () => ({
                    facilityTypeId: 71,
                    categoryId: 81,
                    [secretName]: secret,
                }),
                close: async () => {
                    closed++;
                    if (["extra-field", "cleanup"].includes(failure))
                        throw new Error(secret);
                },
            }),
            openReceipt: () => ({
                record: (entry) => {
                    if (
                        (failure === "receipt-start" &&
                            entry.action === "start") ||
                        (failure === "receipt-complete" &&
                            entry.action === "complete")
                    )
                        throw new Error(secret);
                    saved.push(structuredClone(entry));
                },
                close: () => {},
            }),
        });
        assert.equal(result.success, failure === "none");
        const codes = {
            "extra-field": "RESPONSE_UNEXPECTED_FIELDS",
            "wrong-type": "RESPONSE_FIELD_TYPE",
            "missing-field": "RESPONSE_MISSING_FIELDS",
            identity: "RESPONSE_IDENTITY",
            "receipt-start": "RECEIPT_WRITE_FAILED",
            "receipt-complete": "RECEIPT_WRITE_FAILED",
            http: "HTTP_RESPONSE_UNCERTAIN",
            cleanup: "RESOURCE_CLEANUP_FAILED",
        };
        if (failure !== "none") assert.equal(result.code, codes[failure]);
        if (failure === "extra-field")
            assert.equal(result.cleanupCode, "RESOURCE_CLEANUP_FAILED");
        assert.doesNotMatch(
            JSON.stringify(result) + JSON.stringify(saved),
            /PRIVATE_RESPONSE_/,
        );
        for (const forbidden of [
            env.DATABASE_URL,
            input.email,
            secret,
            secretName,
        ])
            assert.ok(
                !(JSON.stringify(result) + JSON.stringify(saved)).includes(
                    forbidden,
                ),
            );
        assert.equal(closed, 1);
        assert.deepEqual(
            Object.keys(saved[0] || {}).sort(),
            failure === "receipt-start"
                ? []
                : [
                      "action",
                      "runId",
                      "projectRef",
                      "facilityTypeId",
                      "categoryId",
                  ].sort(),
        );
        if (
            ["extra-field", "wrong-type", "missing-field", "identity"].includes(
                failure,
            )
        )
            assert.equal(f.calls.length, 1);
    }
});
