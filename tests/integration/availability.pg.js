const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const jwt = require("jsonwebtoken");
const { createApp } = require("../../src/app");
const {
    validateDisposableConfig,
} = require("../../scripts/test-reservations-postgres");

async function run({ pool, config, check }) {
    validateDisposableConfig(config);
    const password = randomBytes(32).toString("hex"),
        secret = randomBytes(48).toString("hex");
    await pool.query(`CREATE ROLE im101_availability_test_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS IN ROLE im101_reservation_runtime;
        GRANT USAGE ON SCHEMA public TO im101_availability_test_runtime;
        GRANT SELECT(user_id,role_id,fname,lname,email,password_hash,is_active) ON users TO im101_availability_test_runtime;
        GRANT SELECT(role_id,role_name) ON roles TO im101_availability_test_runtime;
        INSERT INTO facilities(facility_id,building_id,facility_type_id,facility_name,floor_number,capacity,status) VALUES (177777,1,1,'Availability Fixture Hall',1,20,'Available'),(177778,1,1,'Separate Fixture Hall',1,20,'Available');
        INSERT INTO users(user_id,role_id,fname,lname,email,password_hash)
        SELECT 177779,role_id,'Second','Representative','availability-rep-b@example.test','not-a-login-hash'
        FROM roles WHERE role_name='Faculty / Student Organization Representative';`);
    const prisma = new PrismaClient({
        adapter: new PrismaPg({
            host: config.host,
            port: config.port,
            database: config.database,
            user: "im101_availability_test_runtime",
            password,
            max: 4,
            options: "-c timezone=UTC",
        }),
        log: [],
    });
    const server = createApp({
        getPrisma: () => prisma,
        jwtSecret: secret,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    async function request(method, path, body, actor = 301) {
        const token = jwt.sign({}, secret, {
            subject: String(actor),
            algorithm: "HS256",
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: 900,
        });
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api${path}`,
            {
                method,
                headers: {
                    Authorization: "Bearer " + token,
                    "Content-Type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
        );
        return { status: response.status, body: await response.json() };
    }
    try {
        await check(
            "campus availability preserves privacy, tentative overlaps, confirmed conflicts and adjacent/different-facility bookings through real HTTP and PostgreSQL",
            async () => {
                const start = Date.now() + 20 * 86400000,
                    end = start + 3600000;
                const payload = (
                    facilityId = 177777,
                    from = start,
                    to = end,
                ) => ({
                    facilityId,
                    purpose: "PRIVATE availability test purpose",
                    startDatetime: new Date(from).toISOString(),
                    endDatetime: new Date(to).toISOString(),
                });
                const a = await request("POST", "/reservations", payload());
                const b = await request(
                    "POST",
                    "/reservations",
                    payload(),
                    177779,
                );
                assert.equal(a.status, 201, "CHECK_AVAILABILITY_CREATE_A");
                assert.equal(b.status, 201, "CHECK_AVAILABILITY_CREATE_B");
                assert.equal(
                    (
                        await request(
                            "GET",
                            `/reservations/${a.body.reservation.reservationId}`,
                            undefined,
                            177779,
                        )
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/reservations/${a.body.reservation.reservationId}/approve`,
                            {},
                            101,
                        )
                    ).status,
                    200,
                );
                const blocked = await request(
                    "POST",
                    "/reservations",
                    payload(),
                    177779,
                );
                assert.equal(blocked.status, 409, "CHECK_AVAILABILITY_OVERLAP");
                assert.equal(
                    blocked.body.code,
                    "RESERVATION_SCHEDULE_CONFLICT",
                    "CHECK_AVAILABILITY_OVERLAP_CODE",
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            "/reservations",
                            payload(177777, end, end + 3600000),
                            201,
                        )
                    ).status,
                    201,
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            "/reservations",
                            payload(177778),
                            201,
                        )
                    ).status,
                    201,
                );
                const query = new URLSearchParams({
                    from: new Date(start - 3600000).toISOString(),
                    to: new Date(end + 7200000).toISOString(),
                    facilityId: "177777",
                });
                for (const actor of [101, 201, 301, 177779]) {
                    const visible = await request(
                        "GET",
                        `/reservation-availability?${query}`,
                        undefined,
                        actor,
                    );
                    assert.equal(visible.status, 200);
                    assert.equal(visible.body.availability.length, 3);
                    assert.ok(
                        visible.body.availability.some(
                            (slot) => slot.status === "Approved",
                        ),
                    );
                    assert.ok(
                        visible.body.availability.some(
                            (slot) => slot.status === "Pending",
                        ),
                    );
                    assert.deepEqual(
                        Object.keys(visible.body.availability[0]).sort(),
                        [
                            "facilityId",
                            "facilityName",
                            "status",
                            "startDatetime",
                            "endDatetime",
                        ].sort(),
                    );
                    assert.doesNotMatch(
                        JSON.stringify(visible.body),
                        /PRIVATE|purpose|requestedBy|approvedBy|reservationId|email/,
                    );
                }
                await request(
                    "POST",
                    `/reservations/${b.body.reservation.reservationId}/reject`,
                    {},
                    101,
                );
                const afterReject = await request(
                    "GET",
                    `/reservation-availability?${query}`,
                );
                assert.equal(afterReject.body.availability.length, 2);
                await request(
                    "POST",
                    `/reservations/${a.body.reservation.reservationId}/cancel`,
                    {},
                    301,
                );
                const afterCancel = await request(
                    "GET",
                    `/reservation-availability?${query}`,
                );
                assert.equal(afterCancel.body.availability.length, 1);
                assert.equal(
                    afterCancel.body.availability[0].status,
                    "Pending",
                );
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    }
}
module.exports = { run };
