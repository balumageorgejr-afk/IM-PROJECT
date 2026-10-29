const assert = require("node:assert/strict");
const fs = require("node:fs");

async function run({ pool, config }) {
    let passed = 0;
    async function check(name, operation) {
        try {
            await operation();
            passed++;
            console.log(`PASS: ${name}`);
        } catch (error) {
            console.error(
                `FAIL: ${name}; diagnostic=${/^[A-Z0-9_]{5,30}$/.test(error.code || "") ? error.code : "ASSERTION_OR_DRIVER_FAILURE"}`,
            );
            const checkpoint = /^CHECK_[A-Z_]+-?\d*/.exec(error.message || "");
            if (checkpoint) console.error(checkpoint[0]);
            throw error;
        }
    }
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261019020000_supabase_v2_init/migration.sql",
            "utf8",
        ),
    );
    for (const role of [
        "im101_reservation_owner",
        "im101_reservation_audit_writer",
        "im101_reservation_runtime",
    ])
        await pool.query(
            `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`,
        );
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026010000_reservation_audit/migration.sql",
            "utf8",
        ),
    );
    await pool.query(`INSERT INTO roles(role_id, role_name) VALUES
        (11,'System Administrator'),(22,'Facility/Maintenance Staff'),(33,'Faculty / Student Organization Representative');
        INSERT INTO users(user_id,role_id,fname,lname,email,password_hash) VALUES
        (101,11,'Fixture','Admin','admin@example.test','not-a-login-hash'),
        (102,11,'Fixture','Other Admin','other@example.test','not-a-login-hash'),
        (201,22,'Fixture','Staff','staff@example.test','not-a-login-hash'),
        (301,33,'Fixture','Representative','representative@example.test','not-a-login-hash');
        INSERT INTO buildings(building_id,building_name,floor_count) VALUES (1,'Fixture building',2);
        INSERT INTO facility_types(facility_type_id,type_name) VALUES (1,'Fixture type');
        INSERT INTO facilities(facility_id,building_id,facility_type_id,facility_name,floor_number,capacity)
          VALUES (1,1,1,'Fixture facility',1,20),(2,1,1,'Other fixture facility',1,20);
        INSERT INTO reservation_status(status_id,status_name) VALUES (17,'Pending'),(29,'Approved'),(41,'Rejected'),(53,'Cancelled');`);
    async function transaction(actor, operation) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
            if (actor !== undefined)
                await client.query(
                    "SELECT set_config('im101.actor_id', $1, true)",
                    [actor],
                );
            const value = await operation(client);
            await client.query("COMMIT");
            return value;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }
    const insert = `INSERT INTO reservations(facility_id,requested_by,status_id,purpose,start_datetime,end_datetime)
      VALUES (1,201,17,'PRIVATE-purpose-fixture',now()+interval '2 days',now()+interval '2 days 1 hour') RETURNING reservation_id`;
    await check(
        "audit INSERT UPDATE DELETE snapshots and real transaction rollback",
        async () => {
            const id = await transaction(
                "201",
                async (client) =>
                    (await client.query(insert)).rows[0].reservation_id,
            );
            await transaction("101", (client) =>
                client.query(
                    "UPDATE reservations SET status_id=29, approved_by=101 WHERE reservation_id=$1",
                    [id],
                ),
            );
            await transaction("101", (client) =>
                client.query(
                    "DELETE FROM reservations WHERE reservation_id=$1",
                    [id],
                ),
            );
            const audit = (
                await pool.query(
                    "SELECT * FROM audit_logs WHERE record_id=$1 ORDER BY log_id",
                    [id],
                )
            ).rows;
            assert.deepEqual(
                audit.map((row) => row.action_type),
                ["INSERT", "UPDATE", "DELETE"],
            );
            assert.deepEqual(
                audit.map((row) => row.changed_by),
                [201, 101, 101],
            );
            assert.equal(audit[0].old_value, null);
            assert.equal(audit[2].new_value, null);
            const fields = [
                "reservation_id",
                "facility_id",
                "requested_by",
                "approved_by",
                "status_id",
                "start_datetime",
                "end_datetime",
                "created_at",
            ].sort();
            for (const row of audit)
                for (const snapshot of [row.old_value, row.new_value])
                    if (snapshot) {
                        assert.deepEqual(Object.keys(snapshot).sort(), fields);
                        assert.match(snapshot.start_datetime, /\.\d{6}Z$/);
                        assert.ok(
                            !JSON.stringify(snapshot).includes("PRIVATE"),
                        );
                    }
            const before = (await pool.query("SELECT count(*) FROM audit_logs"))
                .rows[0].count;
            await assert.rejects(
                transaction("201", async (client) => {
                    await client.query(insert);
                    throw Error("fixture rollback");
                }),
            );
            assert.equal(
                (await pool.query("SELECT count(*) FROM audit_logs")).rows[0]
                    .count,
                before,
            );
        },
    );
    await check(
        "missing malformed overflow nonexistent and inactive actors fail real writes",
        async () => {
            for (const actor of [
                undefined,
                "",
                "0",
                "-1",
                "1.5",
                "2147483648",
                "999999999999999999999999999999",
                "999",
                "01",
            ])
                await assert.rejects(
                    transaction(actor, (client) => client.query(insert)),
                    { code: "R4011" },
                );
            await pool.query(
                "UPDATE users SET is_active=false WHERE user_id=201",
            );
            await assert.rejects(
                transaction("201", (client) => client.query(insert)),
                { code: "R4011" },
            );
            await pool.query(
                "UPDATE users SET is_active=true WHERE user_id=201",
            );
        },
    );
    await check(
        "audit INSERT privilege failure rolls back reservation",
        async () => {
            const before = (
                await pool.query("SELECT count(*) FROM reservations")
            ).rows[0].count;
            await pool.query(
                "REVOKE INSERT ON audit_logs FROM im101_reservation_audit_writer",
            );
            // Column-level grants must also be removed for this deliberate failure.
            await pool.query(
                "REVOKE INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON audit_logs FROM im101_reservation_audit_writer",
            );
            try {
                await assert.rejects(
                    transaction("201", (client) => client.query(insert)),
                    { code: "42501" },
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
    await require("./workflow.pg").run({ pool, config, check, transaction });
    await require("./account-registration.pg").run({ pool, config, check });
    await require("./availability.pg").run({ pool, config, check });
    console.log(`Isolated PostgreSQL checks passed: ${passed}`);
}
module.exports = { run };
