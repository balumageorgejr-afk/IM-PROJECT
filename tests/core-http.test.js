const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("node:crypto");
const { createApp } = require("../src/app");
const c = require("../src/core-support");
test("core HTTP read predicates RBAC malformed input and errors use offline DI", async (t) => {
    const secret = randomBytes(48).toString("hex");
    let role = c.roles[2],
        active = true,
        calls = [],
        writes = 0,
        failure = false;
    const prisma = {
        user: {
            async findUnique() {
                return {
                    userId: 301,
                    isActive: active,
                    fname: "Fixture",
                    lname: "Reader",
                    email: "reader@example.test",
                    role: { roleId: 33, roleName: role },
                };
            },
        },
        async $transaction() {
            writes++;
            throw Error("PRIVATE-fixture");
        },
    };
    for (const model of [
        "equipmentLoan",
        "maintenanceRequest",
        "facilityStaffAssignment",
    ])
        prisma[model] = {
            async findMany(query) {
                calls.push({ model, query });
                if (failure) throw Error("PRIVATE-fixture");
                return [];
            },
            async findFirst(query) {
                calls.push({ model, query });
                return null;
            },
        };
    const server = createApp({
        getPrisma: () => prisma,
        jwtSecret: secret,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    async function request(path, method = "GET", body, auth = true) {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api${path}`,
            {
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(auth
                        ? {
                              Authorization:
                                  "Bearer " +
                                  jwt.sign({}, secret, {
                                      subject: "301",
                                      issuer: "im101-api",
                                      audience: "im101-client",
                                      expiresIn: "15m",
                                  }),
                          }
                        : {}),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        const data = await response.json();
        assert.ok(!JSON.stringify(data).includes("PRIVATE"));
        return { status: response.status, data };
    }
    for (const userRole of c.roles) {
        role = userRole;
        calls = [];
        assert.equal((await request("/loans")).status, 200);
        assert.deepEqual(
            calls[0].query.where,
            c.reviewer({ role: { roleName: role } }) ? {} : { userId: 301 },
        );
        assert.equal((await request("/maintenance")).status, 200);
        assert.deepEqual(
            calls[1].query.where,
            c.admin({ role: { roleName: role } })
                ? {}
                : role === c.roles[1]
                  ? { OR: [{ reportedBy: 301 }, { assignedStaffId: 301 }] }
                  : { reportedBy: 301 },
        );
        assert.equal(calls[0].query.take, 21);
    }
    role = c.roles[2];
    assert.equal((await request("/loans/1")).status, 404);
    assert.deepEqual(calls.at(-1).query.where, { loanId: 1, userId: 301 });
    assert.equal((await request("/assignments")).status, 403);
    role = c.roles[1];
    calls = [];
    assert.equal((await request("/assignments")).status, 200);
    assert.deepEqual(calls[0].query.where, { staffId: 301 });
    assert.equal((await request("/assignments?staffId=201")).status, 403);
    for (const path of ["/loans", "/maintenance", "/assignments"]) {
        assert.equal(
            (await request(path, "GET", undefined, false)).status,
            401,
        );
        active = false;
        assert.equal((await request(path)).status, 401);
        active = true;
    }
    role = c.roles[2];
    for (const payload of [
        { description: "Issue" },
        { description: "Issue", facilityId: 1, equipmentId: 2 },
        { description: "", facilityId: 1 },
        { description: "Issue", facilityId: 1, reportedBy: 1 },
    ])
        assert.equal(
            (await request("/maintenance", "POST", payload)).status,
            400,
        );
    assert.equal(
        (
            await request("/loans", "POST", {
                userId: 1,
                dueDate: "invalid",
                items: [],
            })
        ).status,
        400,
    );
    assert.equal((await request("/loans?limit=101")).status, 400);
    assert.equal(writes, 0);
    failure = true;
    assert.equal((await request("/maintenance")).status, 500);
});
