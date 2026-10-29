const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createAuth } = require("../src/auth");

const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const secret = randomBytes(48).toString("hex");
let current;
let failDatabase;
let lookups;
let reached;
let server;
let base;
let requireRoles;
let forwardedError;

function user(roleName) {
    return {
        userId: 42,
        fname: "Test",
        lname: "Representative",
        email: "fixture@example.test",
        isActive: true,
        role: { roleId: 89, roleName },
        passwordHash: "PRIVATE-HASH",
        idNumber: "PRIVATE-ID",
        contactNumber: "PRIVATE-CONTACT",
    };
}
function token(payload = {}, options = {}) {
    return jwt.sign(payload, secret, {
        algorithm: "HS256",
        subject: "42",
        issuer: "im101-api",
        audience: "im101-client",
        expiresIn: "15m",
        ...options,
    });
}
async function request(path, bearer, options = {}) {
    const response = await fetch(base + path, {
        ...options,
        headers: {
            ...(bearer === undefined
                ? {}
                : { Authorization: `Bearer ${bearer}` }),
            ...options.headers,
        },
    });
    return { status: response.status, body: await response.json() };
}
function rejected(result, status) {
    assert.equal(result.status, status);
    assert.deepEqual(result.body, {
        success: false,
        message: status === 401 ? "Authentication required." : "Access denied.",
    });
    assert.equal(reached, 0);
}

before(async () => {
    const getPrisma = () => ({
        user: {
            findUnique: async (query) => {
                lookups.push(query);
                if (failDatabase)
                    throw new Error("PRIVATE database credentials and error");
                return query.where.userId === 42 ? current : null;
            },
        },
    });
    ({ requireRoles } = createAuth({ getPrisma, jwtSecret: secret }));
    const app = express();
    app.use(express.json());
    const success = (req, res) => {
        reached += 1;
        res.json({ success: true });
    };
    for (const [index, role] of roles.entries())
        app.get(`/role/${index}`, requireRoles([role]), success);
    app.get("/multiple", requireRoles([roles[0], roles[1]]), success);
    // Even a pre-populated request user must not bypass token authentication.
    app.get(
        "/spoofed",
        (req, res, next) => {
            req.user = user(roles[0]);
            next();
        },
        requireRoles([roles[0]]),
        success,
    );
    app.post("/client-role", requireRoles([roles[0]]), success);
    const allowed = [roles[0]];
    app.get("/snapshot", requireRoles(allowed), success);
    allowed.push(roles[2]);
    app.use((error, req, res, next) => {
        forwardedError = error;
        res.status(500).json({
            success: false,
            message: "Internal server error.",
        });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
    forwardedError = undefined;
    current = user(roles[0]);
    failDatabase = false;
    lookups = [];
    reached = 0;
});
after(async () => {
    if (server)
        await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
});

for (const [index, role] of roles.entries()) {
    test(`${role}: permitted access and denial on other role-only routes`, async () => {
        current = user(role);
        const bearer = token();
        const allowed = await request(`/role/${index}`, bearer);
        assert.equal(allowed.status, 200);
        assert.deepEqual(allowed.body, { success: true });
        assert.equal(reached, 1);
        for (const otherIndex of roles.keys()) {
            if (index === otherIndex) continue;
            reached = 0;
            rejected(await request(`/role/${otherIndex}`, bearer), 403);
        }
        for (const query of lookups) {
            assert.deepEqual(query.where, { userId: 42 });
            assert.equal(query.select.passwordHash, undefined);
            assert.deepEqual(query.select.role, {
                select: { roleId: true, roleName: true },
            });
        }
    });
}

test("missing authentication rejects even a pre-populated request user", async () => {
    rejected(await request("/role/0"), 401);
    rejected(await request("/spoofed"), 401);
    assert.equal(lookups.length, 0);
});
test("invalid and expired JWTs cannot reach role checks or the database", async () => {
    for (const bearer of [
        "invalid",
        token({}, { expiresIn: -1 }),
        jwt.sign({}, randomBytes(48)),
        token({}, { algorithm: "HS384" }),
    ]) {
        rejected(await request("/role/0", bearer), 401);
    }
    assert.equal(lookups.length, 0);
});
test("inactive and deleted users receive 401", async () => {
    const bearer = token();
    current.isActive = false;
    rejected(await request("/role/0", bearer), 401);
    current = null;
    rejected(await request("/role/0", bearer), 401);
});
test("the same token immediately follows database role changes", async () => {
    const bearer = token({ role: roles[0], roleId: 1 });
    assert.equal((await request("/role/0", bearer)).status, 200);
    current.role = { roleId: 901, roleName: roles[1] };
    reached = 0;
    rejected(await request("/role/0", bearer), 403);
    assert.equal((await request("/role/1", bearer)).status, 200);
    current.role = { roleId: 902, roleName: roles[0] };
    assert.equal((await request("/role/0", bearer)).status, 200);
});
test("multiple permitted roles allow either listed role and reject others", async () => {
    for (const role of roles.slice(0, 2)) {
        current = user(role);
        assert.equal((await request("/multiple", token())).status, 200);
    }
    current = user(roles[2]);
    reached = 0;
    rejected(await request("/multiple", token()), 403);
});
test("client role claims, headers, body, and query cannot grant access", async () => {
    current = user(roles[2]);
    rejected(
        await request(
            "/client-role?role=System%20Administrator",
            token({ role: roles[0], roleName: roles[0], roleId: 1 }),
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Role": roles[0],
                },
                body: JSON.stringify({
                    role: { roleName: roles[0], roleId: 1 },
                }),
            },
        ),
        403,
    );
});
test("role names match exactly and unknown roles fail closed", async () => {
    for (const role of ["Unknown", roles[0].toLowerCase(), `${roles[0]} `]) {
        current = user(role);
        rejected(await request("/role/0", token()), 403);
    }
});
test("allowed roles are validated at setup and copied", async () => {
    for (const allowed of [
        undefined,
        null,
        [],
        "System Administrator",
        [1],
        [""],
        [" "],
        [null],
        [roles[0], undefined],
        new Array(1),
    ]) {
        assert.throws(() => requireRoles(allowed), {
            message: "A nonempty list of role names is required.",
        });
    }
    current = user(roles[2]);
    rejected(await request("/snapshot", token()), 403);
});
test("database failures reach the error handler without entering the route", async () => {
    failDatabase = true;
    const result = await request("/role/0", token());
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, {
        success: false,
        message: "Internal server error.",
    });
    assert.equal(reached, 0);
    assert.equal(
        forwardedError.message,
        "PRIVATE database credentials and error",
    );
});
