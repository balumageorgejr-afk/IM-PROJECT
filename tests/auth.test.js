const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");

const secret = randomBytes(48).toString("hex");
const password = "Fixture-password-123";
const fixture = {
    userId: 7,
    fname: "Test",
    lname: "Student",
    email: "student@example.test",
    isActive: true,
    role: {
        roleId: 3,
        roleName: "Faculty / Student Organization Representative",
    },
    passwordHash: bcrypt.hashSync(password, 4),
    idNumber: "PRIVATE-ID",
    contactNumber: "PRIVATE-CONTACT",
};
const expected = {
    userId: 7,
    fname: "Test",
    lname: "Student",
    email: fixture.email,
    role: fixture.role,
};
let server;
let base;
let current;
let failDatabase = false;
let calls = [];
before(async () => {
    const app = createApp({
        jwtSecret: secret,
        getPrisma: () => ({
            user: {
                findUnique: async (query) => {
                    calls.push(query);
                    if (failDatabase)
                        throw new Error(
                            "PRIVATE database credentials and raw error",
                        );
                    return current &&
                        (query.where.email === current.email ||
                            query.where.userId === current.userId)
                        ? current
                        : null;
                },
            },
        }),
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
    await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
});
async function request(path, options = {}) {
    const response = await fetch(base + path, options);
    return {
        status: response.status,
        body: await response.json(),
        headers: response.headers,
    };
}
function login(body = { email: fixture.email, password }) {
    return request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
function signed(payload = {}, options = {}) {
    return jwt.sign(payload, secret, {
        algorithm: "HS256",
        subject: "7",
        issuer: "im101-api",
        audience: "im101-client",
        expiresIn: 900,
        ...options,
    });
}
function me(token) {
    return request("/api/auth/me", {
        headers:
            token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
}

test("authentication HTTP behavior with database-free fixtures", async (t) => {
    await t.test(
        "successful login and protected profile expose only approved fields",
        async () => {
            current = { ...fixture };
            calls = [];
            const result = await login();
            assert.equal(result.status, 200);
            assert.equal(result.headers.get("cache-control"), "no-store");
            assert.deepEqual(result.body.user, expected);
            const claims = jwt.verify(result.body.token, secret, {
                algorithms: ["HS256"],
                issuer: "im101-api",
                audience: "im101-client",
            });
            assert.deepEqual(Object.keys(claims).sort(), [
                "aud",
                "exp",
                "iat",
                "iss",
                "sub",
            ]);
            assert.equal(claims.exp - claims.iat, 900);
            const profile = await me(result.body.token);
            assert.equal(profile.status, 200);
            assert.equal(profile.headers.get("cache-control"), "no-store");
            assert.deepEqual(profile.body, { success: true, user: expected });
            assert.equal(calls[0].select.passwordHash, true);
            assert.equal(calls[1].select.passwordHash, undefined);
            assert.equal(
                JSON.stringify(result.body).includes(fixture.passwordHash),
                false,
            );
        },
    );
    await t.test(
        "incorrect passwords and nonexistent users receive the same rejection",
        async () => {
            current = { ...fixture };
            const wrong = await login({
                email: fixture.email,
                password: "wrong",
            });
            const missing = await login({
                email: "missing@example.test",
                password,
            });
            assert.equal(wrong.status, 401);
            assert.equal(missing.status, 401);
            assert.deepEqual(wrong.body, missing.body);
        },
    );
    await t.test(
        "inactive accounts and unsupported password storage fail closed",
        async () => {
            current = { ...fixture, isActive: false };
            assert.equal((await login()).status, 401);
            current = { ...fixture, passwordHash: password };
            assert.equal((await login()).status, 401);
        },
    );
    await t.test(
        "missing, invalid, expired, forged and wrong-algorithm JWTs fail",
        async () => {
            current = { ...fixture };
            const lookupCount = calls.length;
            for (const token of [
                undefined,
                "invalid",
                signed({}, { expiresIn: -1 }),
                jwt.sign({}, randomBytes(48), { subject: "7" }),
                signed({}, { algorithm: "HS384" }),
                jwt.sign({}, "", { algorithm: "none", subject: "7" }),
                signed({}, { notBefore: "1h" }),
                signed({}, { issuer: "other" }),
                signed({}, { audience: "other" }),
                signed({}, { subject: "abc" }),
                signed({}, { subject: "2147483648" }),
                jwt.sign(
                    { sub: "7", iss: "im101-api", aud: "im101-client" },
                    secret,
                ),
            ]) {
                assert.equal((await me(token)).status, 401);
            }
            assert.equal(calls.length, lookupCount);
        },
    );
    await t.test(
        "profile checks current account and current role",
        async () => {
            const token = signed();
            current = {
                ...fixture,
                role: { roleId: 2, roleName: "Facility/Maintenance Staff" },
            };
            assert.deepEqual((await me(token)).body.user.role, current.role);
            current.isActive = false;
            assert.equal((await me(token)).status, 401);
            current = null;
            assert.equal((await me(token)).status, 401);
        },
    );
    await t.test(
        "login returns each actual approved role without assigning roles",
        async () => {
            for (const role of [
                { roleId: 1, roleName: "System Administrator" },
                { roleId: 2, roleName: "Facility/Maintenance Staff" },
                fixture.role,
            ]) {
                current = { ...fixture, role };
                const result = await login();
                assert.equal(result.status, 200);
                assert.deepEqual(result.body.user.role, role);
            }
        },
    );
    await t.test(
        "bcrypt byte boundary, email trimming, and password whitespace",
        async () => {
            const boundaryPassword = "é".repeat(36);
            current = {
                ...fixture,
                passwordHash: bcrypt.hashSync(boundaryPassword, 4),
            };
            assert.equal(
                (
                    await login({
                        email: ` ${fixture.email} `,
                        password: boundaryPassword,
                    })
                ).status,
                200,
            );
            assert.equal(
                (
                    await login({
                        email: fixture.email,
                        password: boundaryPassword + "a",
                    })
                ).status,
                400,
            );
            const spacedPassword = " fixture password ";
            current.passwordHash = bcrypt.hashSync(spacedPassword, 4);
            assert.equal(
                (
                    await login({
                        email: fixture.email,
                        password: spacedPassword,
                    })
                ).status,
                200,
            );
            assert.equal(
                (
                    await login({
                        email: fixture.email,
                        password: spacedPassword.trim(),
                    })
                ).status,
                401,
            );
        },
    );
    await t.test("invalid input and malformed JSON are sanitized", async () => {
        for (const body of [
            {},
            { email: [], password },
            { email: fixture.email, password: "a".repeat(73) },
        ])
            assert.equal((await login(body)).status, 400);
        const response = await request("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{broken",
        });
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, {
            success: false,
            message: "Invalid request body.",
        });
    });
    await t.test(
        "oversized bodies and unsupported encodings have safe client errors",
        async () => {
            for (const [headers, body, status] of [
                [
                    { "Content-Type": "application/json" },
                    JSON.stringify({ padding: "a".repeat(9000) }),
                    413,
                ],
                [
                    { "Content-Type": "application/json; charset=iso-8859-1" },
                    "{}",
                    415,
                ],
                [
                    {
                        "Content-Type": "application/json",
                        "Content-Encoding": "unsupported",
                    },
                    "{}",
                    415,
                ],
            ]) {
                const response = await request("/api/auth/login", {
                    method: "POST",
                    headers,
                    body,
                });
                assert.equal(response.status, status);
                assert.deepEqual(response.body, {
                    success: false,
                    message: "Invalid request body.",
                });
            }
        },
    );
    await t.test("database errors never escape login or profile", async () => {
        failDatabase = true;
        try {
            for (const result of [await login(), await me(signed())]) {
                assert.equal(result.status, 500);
                assert.deepEqual(result.body, {
                    success: false,
                    message: "Internal server error.",
                });
            }
        } finally {
            failDatabase = false;
        }
    });
    await t.test("health remains available", async () => {
        assert.equal((await request("/api/health")).status, 200);
    });
});

test("missing or weak JWT secrets prevent startup", () => {
    for (const jwtSecret of [null, 123, "", "short", " ".repeat(40)])
        assert.throws(() => createApp({ jwtSecret }), /JWT_SECRET/);
});

test("server startup errors are sanitized and exit unsuccessfully", async () => {
    for (const env of [
        { JWT_SECRET: "" },
        { JWT_SECRET: secret, PORT: String(server.address().port) },
    ]) {
        const child = spawn(process.execPath, ["src/server.js"], {
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10000,
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
            output += chunk;
        });
        child.stderr.on("data", (chunk) => {
            output += chunk;
        });
        const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        assert.equal(code, 1);
        assert.match(
            output,
            /^Server (configuration invalid|could not start)\./m,
        );
        assert.equal(output.includes(secret), false);
        assert.equal(output.includes("Error:"), false);
    }
});
