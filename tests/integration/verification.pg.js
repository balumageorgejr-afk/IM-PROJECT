const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const {
    createReservationTransaction,
} = require("../../src/reservation-transaction");
const {
    validateDisposableConfig,
} = require("../../scripts/test-reservations-postgres");

async function run(context) {
    const {
        pool,
        config,
        prisma,
        runtimePool,
        gateway,
        create,
        check,
        race,
        row,
        start,
        end,
    } = context;
    await check(
        "same physical pooled connection isolates sequential actors and real rollback",
        async () => {
            const single = new PrismaClient({
                adapter: new PrismaPg({
                    host: config.host,
                    port: config.port,
                    database: config.database,
                    user: "im101_test_runtime",
                    password: runtimePool.options.password,
                    max: 1,
                    options: "-c timezone=UTC",
                }),
                log: [],
            });
            const isolated = createReservationTransaction({
                getPrisma: () => single,
            });
            try {
                const pids = [];
                for (const actor of [201, 301, 101]) {
                    const result = await isolated(
                        { userId: actor },
                        (tx) =>
                            tx.$queryRaw`SELECT current_setting('im101.actor_id',true) AS actor, pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation`,
                    );
                    assert.equal(result[0].actor, String(actor));
                    assert.equal(result[0].isolation, "serializable");
                    pids.push(result[0].pid);
                    const outside =
                        await single.$queryRaw`SELECT current_setting('im101.actor_id',true) AS actor`;
                    assert.ok([null, ""].includes(outside[0].actor));
                }
                assert.equal(new Set(pids).size, 1);
                await assert.rejects(
                    isolated({ userId: 201 }, async () => {
                        throw Error("Synthetic rollback");
                    }),
                );
                assert.ok(
                    [null, ""].includes(
                        (
                            await single.$queryRaw`SELECT current_setting('im101.actor_id',true) AS actor`
                        )[0].actor,
                    ),
                );
            } finally {
                await single.$disconnect();
            }
        },
    );
    await check(
        "runtime cannot disable triggers assume owners create functions or bypass missing actor",
        async () => {
            for (const sql of [
                "ALTER TABLE reservations DISABLE TRIGGER reservation_audit",
                "SET ROLE im101_reservation_owner",
                "SET ROLE im101_reservation_audit_writer",
                "SELECT im101_private.audit_reservation()",
                "CREATE FUNCTION im101_private.fixture_attack() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
            ])
                await assert.rejects(runtimePool.query(sql), { code: "42501" });
            const client = await runtimePool.connect();
            try {
                await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
                await assert.rejects(
                    client.query(
                        "CALL im101_private.create_reservation(1,'Fixture',now()+interval '1 day',now()+interval '1 day 1 hour',NULL)",
                    ),
                    { code: "R4011" },
                );
            } finally {
                await client.query("ROLLBACK");
                client.release();
            }
            const routines = (
                await pool.query(
                    "SELECT p.proname,p.prokind,p.prosecdef,pg_get_userbyid(p.proowner) AS owner,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='im101_private'",
                )
            ).rows;
            assert.equal(routines.filter((r) => r.prokind === "p").length, 4);
            assert.equal(routines.length, 6);
            for (const routine of routines) {
                assert.equal(routine.prosecdef, true);
                assert.equal(
                    routine.owner,
                    routine.proname === "audit_reservation"
                        ? "im101_reservation_audit_writer"
                        : "im101_reservation_owner",
                );
                assert.ok(
                    routine.proconfig.includes(
                        "search_path=pg_catalog, pg_temp",
                    ),
                );
            }
            assert.equal(
                (
                    await pool.query(
                        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='im101_private' AND a.grantee=0 AND a.privilege_type='EXECUTE'",
                    )
                ).rows[0].count,
                "0",
            );
        },
    );
    await check(
        "unknown future sensitive columns cannot enter audit snapshots",
        async () => {
            await pool.query(
                "ALTER TABLE reservations ADD COLUMN fixture_sensitive text DEFAULT 'PRIVATE-synthetic-field'",
            );
            try {
                const booking = await create(
                    201,
                    1,
                    new Date(Date.parse(start) + 40 * 86400000).toISOString(),
                    new Date(Date.parse(end) + 40 * 86400000).toISOString(),
                );
                const snapshot = (
                    await pool.query(
                        "SELECT new_value FROM audit_logs WHERE record_id=$1 AND action_type='INSERT'",
                        [booking.reservationId],
                    )
                ).rows[0].new_value;
                assert.equal(Object.keys(snapshot).length, 8);
                assert.ok(!JSON.stringify(snapshot).includes("PRIVATE"));
                assert.ok(!Object.hasOwn(snapshot, "fixture_sensitive"));
            } finally {
                await pool.query(
                    "ALTER TABLE reservations DROP COLUMN fixture_sensitive",
                );
            }
        },
    );
    await check(
        "different-facility simultaneous approvals preserve independent schedules without unsafe outcomes",
        async () => {
            const s = new Date(Date.parse(start) + 35 * 86400000).toISOString(),
                e = new Date(Date.parse(end) + 35 * 86400000).toISOString();
            const a = await create(201, 1, s, e),
                b = await create(301, 2, s, e);
            const results = await race(
                (client) =>
                    client.query(
                        "CALL im101_private.approve_reservation($1,NULL)",
                        [a.reservationId],
                    ),
                (client) =>
                    client.query(
                        "CALL im101_private.approve_reservation($1,NULL)",
                        [b.reservationId],
                    ),
            );
            const successful = [results.aError, results.bError].filter(
                (error) => !error,
            ).length;
            assert.ok(successful >= 1);
            assert.equal(
                (
                    await Promise.all([
                        row(a.reservationId),
                        row(b.reservationId),
                    ])
                ).filter((item) => item.statusId === 29).length,
                successful,
            );
            // SSI can conservatively abort a nonconflicting transaction; never auto-retry.
            if (results.aError)
                assert.equal((await row(a.reservationId)).statusId, 17);
            if (results.bError)
                assert.equal((await row(b.reservationId)).statusId, 17);
        },
    );
    await check(
        "real transaction timeout rolls back business and audit inserts without actor leakage",
        async () => {
            const before = (
                await pool.query("SELECT count(*) FROM reservations")
            ).rows[0].count;
            const auditBefore = (
                await pool.query("SELECT count(*) FROM audit_logs")
            ).rows[0].count;
            let callbacks = 0;
            const s = new Date(Date.parse(start) + 60 * 86400000).toISOString(),
                e = new Date(Date.parse(end) + 60 * 86400000).toISOString();
            await assert.rejects(
                gateway({ userId: 201 }, async (tx) => {
                    callbacks++;
                    await tx.$queryRaw`CALL im101_private.create_reservation(1,'Timeout fixture',${s}::timestamptz,${e}::timestamptz,NULL::integer)`;
                    await new Promise((resolve) => setTimeout(resolve, 15500));
                    await tx.$queryRaw`SELECT 1`;
                }),
            );
            assert.equal(callbacks, 1);
            assert.equal(
                (await pool.query("SELECT count(*) FROM reservations")).rows[0]
                    .count,
                before,
            );
            assert.equal(
                (await pool.query("SELECT count(*) FROM audit_logs")).rows[0]
                    .count,
                auditBefore,
            );
        },
    );
    await check(
        "real commit followed by synthetic lost acknowledgement remains an error without duplicate writes",
        async () => {
            let id,
                callbacks = 0;
            const uncertain = createReservationTransaction({
                getPrisma: () => ({
                    async $transaction(callback, options) {
                        await prisma.$transaction(callback, options);
                        throw Error(
                            "Synthetic lost acknowledgement after real commit",
                        );
                    },
                }),
            });
            const s = new Date(Date.parse(start) + 61 * 86400000).toISOString(),
                e = new Date(Date.parse(end) + 61 * 86400000).toISOString();
            await assert.rejects(
                uncertain({ userId: 201 }, async (tx) => {
                    callbacks++;
                    id = (
                        await tx.$queryRaw`CALL im101_private.create_reservation(1,'Lost acknowledgement fixture',${s}::timestamptz,${e}::timestamptz,NULL::integer)`
                    )[0].p_reservation_id;
                }),
                { code: "TRANSACTION_FAILED" },
            );
            assert.equal(callbacks, 1);
            assert.equal((await row(id)).statusId, 17);
            assert.equal(
                (
                    await pool.query(
                        "SELECT count(*) FROM audit_logs WHERE record_id=$1",
                        [id],
                    )
                ).rows[0].count,
                "1",
            );
        },
    );
    await check(
        "eight elapsed hours accepted and short intervals crossing the 90-day horizon refused",
        async () => {
            const s = new Date(Date.parse(start) + 62 * 86400000).toISOString();
            const e = new Date(Date.parse(s) + 8 * 3600000).toISOString();
            assert.equal((await create(201, 1, s, e)).statusId, 17);
            const horizon = Date.now() + 90 * 86400000;
            await assert.rejects(
                create(
                    201,
                    1,
                    new Date(horizon - 3600000).toISOString(),
                    new Date(horizon + 3600000).toISOString(),
                ),
                { code: "RESERVATION_INPUT" },
            );
        },
    );
    await check(
        "audit failure inside the real creation procedure rolls back its business insert",
        async () => {
            const before = (
                await pool.query("SELECT count(*) FROM reservations")
            ).rows[0].count;
            await pool.query(
                "REVOKE INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON audit_logs FROM im101_reservation_audit_writer",
            );
            try {
                await assert.rejects(
                    create(
                        201,
                        1,
                        new Date(
                            Date.parse(start) + 63 * 86400000,
                        ).toISOString(),
                        new Date(Date.parse(end) + 63 * 86400000).toISOString(),
                    ),
                    { code: "TRANSACTION_CALLBACK_FAILED" },
                );
            } finally {
                await pool.query(
                    "GRANT INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON audit_logs TO im101_reservation_audit_writer",
                );
            }
            assert.equal(
                (await pool.query("SELECT count(*) FROM reservations")).rows[0]
                    .count,
                before,
            );
        },
    );
    await check(
        "audit retains microseconds and records purpose-only updates without persisting purpose",
        async () => {
            const id = await context.transaction(
                "201",
                async (client) =>
                    (
                        await client.query(
                            "INSERT INTO reservations(facility_id,requested_by,status_id,purpose,start_datetime,end_datetime) VALUES(1,201,17,'Synthetic private purpose','2030-01-01T00:00:00.123456Z','2030-01-01T01:00:00.654321Z') RETURNING reservation_id",
                        )
                    ).rows[0].reservation_id,
            );
            await context.transaction("201", (client) =>
                client.query(
                    "UPDATE reservations SET purpose='Changed synthetic purpose' WHERE reservation_id=$1",
                    [id],
                ),
            );
            const audit = (
                await pool.query(
                    "SELECT old_value,new_value FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE'",
                    [id],
                )
            ).rows[0];
            assert.deepEqual(audit.old_value, audit.new_value);
            assert.ok(audit.new_value.start_datetime.endsWith(".123456Z"));
            assert.ok(audit.new_value.end_datetime.endsWith(".654321Z"));
            assert.ok(!Object.hasOwn(audit.new_value, "purpose"));
            await context.transaction("201", (client) =>
                client.query(
                    "DELETE FROM reservations WHERE reservation_id=$1",
                    [id],
                ),
            );
        },
    );
    await require("./http.pg").run(context);
    await check(
        "original plus additive migrations replay cleanly without statuses or altered table definitions",
        async () => {
            const name =
                "im101_reservation_disposable_" +
                randomBytes(12).toString("hex");
            validateDisposableConfig({ ...config, database: name });
            await pool.query(`CREATE DATABASE "${name}"`);
            const replay = new Pool({ ...config, database: name, max: 1 });
            try {
                await replay.query(
                    fs.readFileSync(
                        "prisma/migrations/20261019020000_supabase_v2_init/migration.sql",
                        "utf8",
                    ),
                );
                await replay.query(
                    "GRANT INSERT(purpose) ON reservations TO im101_reservation_runtime",
                );
                await assert.rejects(
                    replay.query(
                        fs.readFileSync(
                            "prisma/migrations/20261026010000_reservation_audit/migration.sql",
                            "utf8",
                        ),
                    ),
                    { code: "R5031" },
                );
                await replay.query("ROLLBACK");
                await replay.query(
                    "REVOKE INSERT(purpose) ON reservations FROM im101_reservation_runtime",
                );
                for (const dir of fs
                    .readdirSync("prisma/migrations")
                    .filter((dir) => /^20261026\d+_/.test(dir))
                    .sort())
                    await replay.query(
                        fs.readFileSync(
                            `prisma/migrations/${dir}/migration.sql`,
                            "utf8",
                        ),
                    );
                assert.equal(
                    (
                        await replay.query(
                            "SELECT count(*) FROM reservation_status",
                        )
                    ).rows[0].count,
                    "0",
                );
                assert.equal(
                    (await replay.query("SELECT count(*) FROM reservations"))
                        .rows[0].count,
                    "0",
                );
                const columns = (
                    await replay.query(
                        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='reservations' ORDER BY ordinal_position",
                    )
                ).rows.map((r) => r.column_name);
                assert.deepEqual(columns, [
                    "reservation_id",
                    "facility_id",
                    "requested_by",
                    "approved_by",
                    "status_id",
                    "purpose",
                    "start_datetime",
                    "end_datetime",
                    "created_at",
                ]);
                assert.equal(
                    (
                        await replay.query(
                            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='im101_private' AND prokind='p'",
                        )
                    ).rows[0].count,
                    "4",
                );
            } finally {
                await replay.end();
            }
        },
    );
}
module.exports = { run };
