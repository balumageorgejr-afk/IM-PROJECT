const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createApp } = require("../src/app");
const {
    validateAccount,
    registrationLimiter,
} = require("../src/account-registration");

const rep = "Faculty / Student Organization Representative",
    staff = "Facility/Maintenance Staff",
    admin = "System Administrator";
const fixture = {
    fname: "Test",
    lname: "Person",
    email: "new@example.test",
    password: "Synthetic passphrase 827!",
    passwordConfirmation: "Synthetic passphrase 827!",
};

function project(row, select) {
    if (!row) return null;
    return Object.fromEntries(
        Object.entries(select).map(([key, spec]) => [
            key,
            spec === true ? row[key] : project(row[key], spec.select),
        ]),
    );
}
async function setup(t, options = {}) {
    const secret = randomBytes(48).toString("hex"),
        created = [],
        calls = [];
    const actors = [admin, rep, staff, "Unsupported"].map(
        (roleName, index) => ({
            userId: index + 1,
            fname: "Fixture",
            lname: "Actor",
            email: `actor${index}@example.test`,
            isActive: options.inactive ? false : true,
            role: { roleId: 900 + index, roleName },
        }),
    );
    const prisma = {
        user: {
            findUnique: async (q) =>
                project(
                    [...actors, ...created].find((u) =>
                        q.where.userId
                            ? u.userId === q.where.userId
                            : u.email === q.where.email,
                    ),
                    q.select,
                ),
        },
        $transaction: async (operation, config) => {
            calls.push({ config });
            if (options.failure)
                throw Object.assign(
                    new Error("PRIVATE database secret SQL details"),
                    { code: options.failure },
                );
            const pending = [];
            const tx = {
                role: {
                    findUnique: async (q) => {
                        calls.push(q);
                        return options.missingRole
                            ? null
                            : { roleId: q.where.roleName === rep ? 303 : 701 };
                    },
                },
                user: {
                    findUnique: async (q) =>
                        options.revoked ? null : prisma.user.findUnique(q),
                    findFirst: async (q) => {
                        calls.push(q);
                        return options.duplicate
                            ? { userId: 50 }
                            : [...created, ...pending].find(
                                  (u) =>
                                      u.email.toLowerCase() ===
                                      q.where.email.equals.toLowerCase(),
                              ) || null;
                    },
                    create: async (q) => {
                        calls.push(q);
                        const row = {
                            ...q.data,
                            userId: 100 + created.length,
                            role: {
                                roleId: q.data.roleId,
                                roleName: q.data.roleId === 303 ? rep : staff,
                            },
                        };
                        pending.push(row);
                        return project(row, q.select);
                    },
                },
            };
            const value = await operation(tx);
            if (options.commitFailure)
                throw new Error("PRIVATE uncertain commit");
            created.push(...pending);
            return value;
        },
    };
    const server = createApp({
        jwtSecret: secret,
        getPrisma: () => prisma,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const request = async (url, body = fixture, actor, headers = {}) => {
        const token = actor
            ? jwt.sign({}, secret, {
                  subject: String(actor),
                  algorithm: "HS256",
                  issuer: "im101-api",
                  audience: "im101-client",
                  expiresIn: 900,
              })
            : null;
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}${url}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...headers,
                },
                body: JSON.stringify(body),
            },
        );
        return {
            status: response.status,
            body: await response.json(),
            headers: response.headers,
        };
    };
    return { request, created, calls };
}

test("public signup uses real Representative role, bcrypt, explicit projection and compatible login", async (t) => {
    const { request, created, calls } = await setup(t);
    const input = { ...fixture, fname: "  Test  ", email: "New@Example.test" };
    const result = await request("/api/auth/register", input);
    assert.equal(result.status, 201);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.body.user.role.roleName, rep);
    assert.equal(result.body.user.role.roleId, 303);
    assert.equal(result.body.user.email, "new@example.test");
    assert.deepEqual(Object.keys(result.body.user).sort(), [
        "email",
        "fname",
        "lname",
        "role",
        "userId",
    ]);
    assert.equal(
        await bcrypt.compare(fixture.password, created[0].passwordHash),
        true,
    );
    assert.equal(bcrypt.getRounds(created[0].passwordHash), 12);
    assert.equal(created[0].isActive, true);
    assert.equal(JSON.stringify(result.body).includes("password"), false);
    assert.deepEqual(calls[0].config, {
        isolationLevel: "Serializable",
        maxWait: 10000,
        timeout: 15000,
    });
    assert.deepEqual(calls.find((q) => q.where?.roleName)?.where, {
        roleName: rep,
    });
    assert.deepEqual(calls.find((q) => q.where?.email)?.where, {
        email: { equals: "new@example.test", mode: "insensitive" },
    });
    assert.equal(
        (
            await request("/api/auth/login", {
                email: "new@example.test",
                password: fixture.password,
            })
        ).status,
        200,
    );
});

test("unknown and privileged fields are rejected without any transaction", async (t) => {
    const { request, created, calls } = await setup(t);
    for (const [key, value] of [
        ["roleId", 1],
        ["roleName", admin],
        ["isActive", true],
        ["passwordHash", "fake"],
        ["userId", 1],
        ["role", { roleName: staff }],
    ]) {
        const result = await request("/api/auth/register", {
            ...fixture,
            [key]: value,
        });
        assert.equal(result.status, 400);
        assert.deepEqual(result.body.errors, [
            { field: "body", code: "UNEXPECTED_FIELDS" },
        ]);
    }
    assert.equal(calls.length, 0);
    assert.equal(created.length, 0);
});

test("only active database-backed administrators can create staff; no privileged fields accepted", async (t) => {
    const { request, created } = await setup(t);
    assert.equal((await request("/api/accounts/staff")).status, 401);
    for (const actor of [2, 3, 4])
        assert.equal(
            (await request("/api/accounts/staff", fixture, actor)).status,
            403,
        );
    assert.equal(
        (await request("/api/accounts/staff", { ...fixture, roleId: 1 }, 1))
            .status,
        400,
    );
    const result = await request("/api/accounts/staff", fixture, 1);
    assert.equal(result.status, 201);
    assert.equal(result.body.user.role.roleName, staff);
    assert.equal(result.body.user.role.roleId, 701);
    assert.equal(created.length, 1);
    assert.equal(
        (
            await request("/api/auth/login", {
                email: fixture.email,
                password: fixture.password,
            })
        ).status,
        200,
    );
});

test("inactive and revoked administrators cannot create staff", async (t) => {
    for (const config of [{ inactive: true }, { revoked: true }]) {
        const { request, created } = await setup(t, config);
        assert.equal(
            (await request("/api/accounts/staff", fixture, 1)).status,
            config.inactive ? 401 : 403,
        );
        assert.equal(created.length, 0);
    }
});

test("duplicate emails, absent roles, database failures and uncertain commits fail safely without retries", async (t) => {
    for (const [config, status] of [
        [{ duplicate: true }, 409],
        [{ missingRole: true }, 503],
        [{ failure: "P2002" }, 409],
        [{ failure: "P2034" }, 409],
        [{ failure: "P2010" }, 500],
        [{ commitFailure: true }, 500],
    ]) {
        const { request, created, calls } = await setup(t, config);
        const result = await request("/api/auth/register");
        assert.equal(result.status, status);
        assert.equal(created.length, 0);
        assert.equal(calls.filter((q) => q.config).length, 1);
        assert.doesNotMatch(
            JSON.stringify(result.body),
            /PRIVATE|SQL|Synthetic|password_hash|passwordHash/,
        );
    }
});

test("case variants of registered email cannot create duplicate accounts", async (t) => {
    const { request, created } = await setup(t);
    assert.equal((await request("/api/auth/register")).status, 201);
    assert.equal(
        (
            await request("/api/auth/register", {
                ...fixture,
                email: fixture.email.toUpperCase(),
            })
        ).status,
        409,
    );
    assert.equal(created.length, 1);
});

test("public rate limit rejects attempts before hashing/database work and ignores forged forwarding headers", async (t) => {
    const { request, calls } = await setup(t);
    for (let i = 0; i < 10; i++)
        assert.equal(
            (
                await request("/api/auth/register", {}, undefined, {
                    "X-Forwarded-For": `192.0.2.${i}`,
                })
            ).status,
            400,
        );
    const response = await request("/api/auth/register");
    assert.equal(response.status, 429);
    assert.equal(Number(response.headers.get("retry-after")) > 0, true);
    assert.equal(calls.length, 0);
});

test("limiter expires windows and separates verified administrator IDs", () => {
    let time = 0,
        passed = 0,
        status;
    const limiter = registrationLimiter({
        max: 1,
        windowMs: 1000,
        now: () => time,
    });
    const res = {
        set() {},
        status(value) {
            status = value;
            return this;
        },
        json() {},
    };
    limiter({ user: { userId: 1 } }, res, () => passed++);
    limiter({ user: { userId: 1 } }, res, () => passed++);
    assert.equal(status, 429);
    limiter({ user: { userId: 2 } }, res, () => passed++);
    time = 1000;
    limiter({ user: { userId: 1 } }, res, () => passed++);
    assert.equal(passed, 3);
});

test("pure validation covers malformed objects, lengths, Unicode, exact passwords and sanitized errors", () => {
    for (const payload of [
        null,
        [],
        4,
        "text",
        {},
        Object.create(fixture),
        new Proxy(
            {},
            {
                getPrototypeOf() {
                    throw Error("SECRET");
                },
            },
        ),
    ])
        assert.ok(validateAccount(payload).errors);
    for (const changes of [
        { fname: " " },
        { lname: "a".repeat(61) },
        { fname: "bad\u0000name" },
        { email: "a..b@example.test" },
        { email: "missing-at" },
        { password: "short" },
        { password: "😀".repeat(19) },
        { password: "passwordpassword" },
        { passwordConfirmation: "mismatch" },
    ])
        assert.ok(validateAccount({ ...fixture, ...changes }).errors);
    const payload = Object.freeze({ ...fixture, fname: "😀".repeat(60) });
    assert.ok(validateAccount(payload).data);
    const exact = " leading passphrase ";
    assert.equal(
        validateAccount({
            ...fixture,
            password: exact,
            passwordConfirmation: exact,
        }).data.password,
        exact,
    );
    const accessor = { ...fixture };
    Object.defineProperty(accessor, "fname", {
        get() {
            throw Error("SECRET");
        },
    });
    assert.ok(validateAccount(accessor).errors);
    assert.doesNotMatch(
        JSON.stringify(validateAccount({ ...fixture, roleName: "SECRET" })),
        /SECRET|roleName/,
    );
});
