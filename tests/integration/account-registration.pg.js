const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const jwt = require("jsonwebtoken");
const { createApp } = require("../../src/app");
const {
    validateDisposableConfig,
} = require("../../scripts/test-reservations-postgres");

async function run({ pool, config, check }) {
    validateDisposableConfig(config);
    const identity = (
        await pool.query(
            "SELECT current_database() AS name, host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS actor",
        )
    ).rows[0];
    assert.equal(identity.name, config.database);
    assert.equal(identity.host, "127.0.0.1");
    assert.equal(identity.port, config.port);
    assert.equal(identity.actor, "im101_test_admin");
    const password = randomBytes(32).toString("hex"),
        secret = randomBytes(48).toString("hex");
    // This role exists only in the harness-created disposable local cluster.
    await pool.query(`CREATE ROLE im101_registration_test_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        GRANT USAGE ON SCHEMA public TO im101_registration_test_runtime;
        GRANT SELECT(user_id,role_id,fname,lname,email,password_hash,is_active) ON public.users TO im101_registration_test_runtime;
        GRANT SELECT(role_id,role_name) ON public.roles TO im101_registration_test_runtime;`);
    const connection = {
        host: config.host,
        port: config.port,
        database: config.database,
        user: "im101_registration_test_runtime",
        password,
        max: 4,
        options: "-c timezone=UTC",
    };
    const runtime = new Pool(connection);
    const prisma = new PrismaClient({
        adapter: new PrismaPg(connection),
        log: [{ emit: "event", level: "query" }],
    });
    const queries = [];
    prisma.$on("query", (event) => queries.push(event.query)); // Never retain parameters or print SQL.
    const server = createApp({
        getPrisma: () => prisma,
        jwtSecret: secret,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const data = (email) => ({
        fname: "Registration",
        lname: "Fixture",
        email,
        password: "Synthetic local passphrase 827!",
        passwordConfirmation: "Synthetic local passphrase 827!",
    });
    async function request(path, body, actor) {
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
            `http://127.0.0.1:${server.address().port}/api${path}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: "Bearer " + token } : {}),
                },
                body: JSON.stringify(body),
            },
        );
        return { status: response.status, body: await response.json() };
    }
    try {
        await check(
            "registration fails closed with production-equivalent read-only user grants",
            async () => {
                assert.equal(
                    (
                        await request(
                            "/auth/register",
                            data("denied-registration@example.test"),
                        )
                    ).status,
                    500,
                );
                assert.equal(
                    (
                        await pool.query(
                            "SELECT count(*)::int AS n FROM users WHERE email='denied-registration@example.test'",
                        )
                    ).rows[0].n,
                    0,
                );
            },
        );
        await pool.query(`GRANT INSERT(role_id,fname,lname,email,password_hash,is_active,created_at,updated_at) ON public.users TO im101_registration_test_runtime;
            GRANT USAGE ON SEQUENCE public.users_user_id_seq TO im101_registration_test_runtime;`);
        await check(
            "column-scoped registration grants support actual Prisma signup and login",
            async () => {
                const response = await request(
                    "/auth/register",
                    data("restricted-signup@example.test"),
                );
                assert.equal(response.status, 201);
                assert.equal(
                    response.body.user.role.roleName,
                    "Faculty / Student Organization Representative",
                );
                assert.equal(
                    (
                        await request("/auth/login", {
                            email: "restricted-signup@example.test",
                            password: data("").password,
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    JSON.stringify(response.body).includes("password"),
                    false,
                );
                const insert = queries.find((query) =>
                    /INSERT INTO "public"\."users"/.test(query),
                );
                assert.ok(insert);
                const columns = [
                    ...insert
                        .match(/\(([^)]+)\) VALUES/)[1]
                        .matchAll(/"([a-z_]+)"/g),
                ]
                    .map((match) => match[1])
                    .sort();
                assert.deepEqual(
                    columns,
                    [
                        "role_id",
                        "fname",
                        "lname",
                        "email",
                        "password_hash",
                        "is_active",
                        "created_at",
                        "updated_at",
                    ].sort(),
                );
            },
        );
        await check(
            "column-scoped registration grants support administrator Staff creation and deny Representatives",
            async () => {
                const result = await request(
                    "/accounts/staff",
                    data("restricted-staff@example.test"),
                    101,
                );
                assert.equal(result.status, 201);
                assert.equal(
                    result.body.user.role.roleName,
                    "Facility/Maintenance Staff",
                );
                assert.equal(
                    (
                        await request(
                            "/accounts/staff",
                            data("forbidden-staff@example.test"),
                            301,
                        )
                    ).status,
                    403,
                );
            },
        );
        await check(
            "registration grants preserve denied user updates deletes private columns and audit access",
            async () => {
                for (const sql of [
                    "UPDATE users SET is_active=false WHERE false",
                    "DELETE FROM users WHERE false",
                    "SELECT id_number FROM users",
                    "SELECT contact_number FROM users",
                    "SELECT * FROM audit_logs",
                    "INSERT INTO audit_logs DEFAULT VALUES",
                    "SELECT setval('users_user_id_seq',1)",
                ])
                    await assert.rejects(runtime.query(sql), { code: "42501" });
            },
        );
        await check(
            "concurrent case-variant signup commits at most one account using real Serializable transactions",
            async () => {
                const results = await Promise.all([
                    request(
                        "/auth/register",
                        data("registration-race@example.test"),
                    ),
                    request(
                        "/auth/register",
                        data("REGISTRATION-RACE@example.test"),
                    ),
                ]);
                assert.deepEqual(
                    results.map((result) => result.status).sort(),
                    [201, 409],
                );
                assert.equal(
                    (
                        await pool.query(
                            "SELECT count(*)::int AS n FROM users WHERE lower(email)='registration-race@example.test'",
                        )
                    ).rows[0].n,
                    1,
                );
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
        await runtime.end();
    }
}

module.exports = { run };
