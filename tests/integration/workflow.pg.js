const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const {
    createReservationTransaction,
} = require("../../src/reservation-transaction");

async function run({ pool, config, check, transaction }) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026020000_reservation_create/migration.sql",
            "utf8",
        ),
    );
    const password = randomBytes(32).toString("hex");
    // Fresh cluster only: generated hex password, fixed test role and explicit grants.
    await pool.query(
        `CREATE ROLE im101_test_runtime LOGIN PASSWORD '${password}' IN ROLE im101_reservation_runtime`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO im101_reservation_runtime;
        GRANT SELECT ON public.roles,public.users,public.buildings,public.facility_types,public.facilities,
          public.equipment_categories,public.equipment,public.reservation_status,public.reservations,
          public.loan_items,public.reservation_equipment,public.maintenance_requests,public.equipment_loans,
          public.maintenance_logs,public.facility_staff_assignments TO im101_reservation_runtime;
        GRANT INSERT,UPDATE,DELETE ON public.buildings,public.facilities,public.equipment TO im101_reservation_runtime;
        GRANT USAGE ON SEQUENCE public.buildings_building_id_seq,public.facilities_facility_id_seq,public.equipment_equipment_id_seq TO im101_reservation_runtime;`);
    const runtimePool = new Pool({
        ...config,
        user: "im101_test_runtime",
        password,
        max: 4,
        options: "-c timezone=UTC",
    });
    const prisma = new PrismaClient({
        adapter: new PrismaPg({
            ...config,
            user: "im101_test_runtime",
            password,
            max: 4,
            connectionTimeoutMillis: 5000,
            options: "-c timezone=UTC",
        }),
        log: [],
    });
    const gateway = createReservationTransaction({ getPrisma: () => prisma });
    const start = new Date(Date.now() + 2 * 86400000).toISOString();
    const end = new Date(Date.parse(start) + 3600000).toISOString();
    async function create(
        actor = 201,
        facility = 1,
        s = start,
        e = end,
        purpose = "Fixture purpose",
    ) {
        return gateway({ userId: actor }, async (tx) => {
            const result =
                await tx.$queryRaw`CALL im101_private.create_reservation(${facility}::integer,${purpose}::text,${s}::timestamptz,${e}::timestamptz,NULL::integer)`;
            assert.equal(result.length, 1, "CHECK_CALL_ROW_COUNT");
            const id = result[0].p_reservation_id;
            assert.ok(Number.isInteger(id), "CHECK_CALL_ID_TYPE");
            return tx.reservation.findUnique({ where: { reservationId: id } });
        });
    }
    try {
        await check(
            "Prisma 7.10.1 parameterized CALL INOUT results and creation for all approved roles",
            async () => {
                for (const actor of [101, 201, 301]) {
                    const row = await create(actor);
                    assert.equal(row.requestedBy, actor, "CHECK_REQUESTER");
                    assert.equal(row.statusId, 17, "CHECK_PENDING");
                    assert.equal(row.approvedBy, null, "CHECK_APPROVER");
                    assert.equal(
                        row.startDatetime.toISOString(),
                        start,
                        "CHECK_TIMESTAMP_DELTA_" +
                            (row.startDatetime.getTime() - Date.parse(start)),
                    );
                    const audit = (
                        await pool.query(
                            "SELECT changed_by,new_value FROM audit_logs WHERE record_id=$1 ORDER BY log_id DESC LIMIT 1",
                            [row.reservationId],
                        )
                    ).rows[0];
                    assert.equal(audit.changed_by, actor, "CHECK_AUDIT_ACTOR");
                    assert.ok(!Object.hasOwn(audit.new_value, "purpose"));
                }
            },
        );
        await check(
            "creation time policy facility eligibility lookup and rollback errors use sanitized codes",
            async () => {
                for (const [s, e] of [
                    [new Date(Date.now() - 1000).toISOString(), end],
                    [end, start],
                    [
                        start,
                        new Date(
                            Date.parse(start) + 8 * 3600000 + 1,
                        ).toISOString(),
                    ],
                    [start, new Date(Date.now() + 91 * 86400000).toISOString()],
                    [start.replace(/\.\d{3}Z$/, ".123456Z"), end],
                ])
                    await assert.rejects(create(201, 1, s, e), {
                        code: "RESERVATION_INPUT",
                    });
                await assert.rejects(create(201, 999), {
                    code: "RESERVATION_NOT_FOUND",
                });
                await pool.query(
                    "UPDATE facilities SET status='Closed' WHERE facility_id=2",
                );
                await assert.rejects(create(201, 2), {
                    code: "RESERVATION_CONFLICT",
                });
                await pool.query(
                    "UPDATE facilities SET status='Available' WHERE facility_id=2",
                );
                await pool.query(
                    "UPDATE reservation_status SET status_name='Fixture missing' WHERE status_id=53",
                );
                try {
                    await assert.rejects(create(), {
                        code: "RESERVATION_CONFIGURATION",
                    });
                } finally {
                    await pool.query(
                        "UPDATE reservation_status SET status_name='Cancelled' WHERE status_id=53",
                    );
                }
                const approved = await create();
                await transaction("101", (client) =>
                    client.query(
                        "UPDATE reservations SET status_id=29,approved_by=101 WHERE reservation_id=$1",
                        [approved.reservationId],
                    ),
                );
                try {
                    await assert.rejects(create(), {
                        code: "RESERVATION_SCHEDULE_CONFLICT",
                    });
                } finally {
                    await transaction("101", (client) =>
                        client.query(
                            "UPDATE reservations SET status_id=53 WHERE reservation_id=$1",
                            [approved.reservationId],
                        ),
                    );
                }
            },
        );
        await check(
            "runtime cannot directly mutate reservations or fabricate read modify delete audit logs",
            async () => {
                for (const sql of [
                    "INSERT INTO reservations DEFAULT VALUES",
                    "UPDATE reservations SET status_id=17",
                    "DELETE FROM reservations",
                    "TRUNCATE reservations",
                    "SELECT * FROM audit_logs",
                    "INSERT INTO audit_logs DEFAULT VALUES",
                    "UPDATE audit_logs SET changed_by=101",
                    "DELETE FROM audit_logs",
                    "TRUNCATE audit_logs",
                ])
                    await assert.rejects(runtimePool.query(sql)); // Fixed test attacks only; never application input.
            },
        );
        const transitions = await require("./transitions.pg").run({
            pool,
            prisma,
            runtimePool,
            gateway,
            create,
            check,
            transaction,
            start,
            end,
        });
        await require("./verification.pg").run({
            pool,
            config,
            prisma,
            runtimePool,
            gateway,
            create,
            check,
            transaction,
            start,
            end,
            ...transitions,
        });
        await require("./core.pg").run({
            ...transitions,
            pool,
            config,
            prisma,
            runtimePool,
            gateway,
            create,
            check,
            transaction,
        });
    } finally {
        await prisma.$disconnect();
        await runtimePool.end();
    }
}
module.exports = { run };
