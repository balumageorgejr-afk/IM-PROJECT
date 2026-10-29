const assert = require("node:assert/strict");
const fs = require("node:fs");
const { Pool } = require("pg");
const { randomBytes } = require("node:crypto");
const {
    validateDisposableConfig,
} = require("../../scripts/test-reservations-postgres");
async function run({ pool, config, prisma, runtimePool, check, request }) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261027030000_core_audit/migration.sql",
            "utf8",
        ),
    );
    await check(
        "extended audits exclude descriptions and actions and preserve real actors",
        async () => {
            const created = await request("POST", "/maintenance", {
                facilityId: 30,
                description: "PRIVATE-synthetic-description",
            });
            assert.equal(created.status, 201);
            const id = created.body.maintenanceRequest.requestId;
            await request(
                "POST",
                `/maintenance/${id}/assign`,
                { staffId: 201 },
                101,
            );
            await request(
                "POST",
                `/maintenance/${id}/progress`,
                {
                    status: "In Progress",
                    actionTaken: "PRIVATE-synthetic-action",
                },
                201,
            );
            const audit = (
                await pool.query(
                    "SELECT * FROM audit_logs WHERE table_name IN('maintenance_requests','maintenance_logs') ORDER BY log_id",
                )
            ).rows;
            assert.ok(audit.length >= 4);
            for (const entry of audit)
                for (const snapshot of [entry.old_value, entry.new_value])
                    if (snapshot) {
                        assert.ok(!Object.hasOwn(snapshot, "description"));
                        assert.ok(!Object.hasOwn(snapshot, "action_taken"));
                        assert.ok(
                            !JSON.stringify(snapshot).includes("PRIVATE"),
                        );
                    }
            assert.equal(audit[0].changed_by, 301);
            assert.ok(audit.some((entry) => entry.changed_by === 201));
            const assignment = await request(
                "POST",
                "/assignments",
                { facilityId: 30, staffId: 202 },
                101,
            );
            assert.equal(assignment.status, 201);
            assert.equal(
                (
                    await pool.query(
                        "SELECT changed_by FROM audit_logs WHERE table_name='facility_staff_assignments' AND record_id=$1",
                        [assignment.body.assignment.assignmentId],
                    )
                ).rows[0].changed_by,
                101,
            );
        },
    );
    await check(
        "audit failure rolls back loan inventory and related maintenance logs",
        async () => {
            const created = await request("POST", "/loans", {
                dueDate: new Date(Date.now() + 3 * 86400000).toISOString(),
                items: [{ equipmentId: 101, quantity: 1 }],
            });
            assert.equal(created.status, 201);
            const id = created.body.loan.loanId;
            const before = (
                await prisma.equipment.findUnique({
                    where: { equipmentId: 101 },
                })
            ).availableQuantity;
            await pool.query(
                "REVOKE INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON audit_logs FROM im101_core_audit_writer",
            );
            try {
                assert.equal(
                    (await request("POST", `/loans/${id}/approve`, {}, 101))
                        .status,
                    500,
                );
            } finally {
                await pool.query(
                    "GRANT INSERT(table_name,record_id,action_type,changed_by,old_value,new_value) ON audit_logs TO im101_core_audit_writer",
                );
            }
            assert.equal(
                (
                    await prisma.equipment.findUnique({
                        where: { equipmentId: 101 },
                    })
                ).availableQuantity,
                before,
            );
            assert.equal(
                (
                    await prisma.equipmentLoan.findUnique({
                        where: { loanId: id },
                    })
                ).loanStatus,
                "Pending",
            );
            await assert.rejects(
                runtimePool.query("SELECT * FROM audit_logs"),
                { code: "42501" },
            );
            for (const table of [
                "equipment_loans",
                "loan_items",
                "maintenance_requests",
                "maintenance_logs",
                "facility_staff_assignments",
            ])
                await assert.rejects(
                    runtimePool.query(`DELETE FROM ${table}`),
                    { code: "42501" },
                );
        },
    );
    await check(
        "maintenance log failure rolls back status and audit; nullable reporter cannot bypass attribution",
        async () => {
            const report = await request("POST", "/maintenance", {
                description: "Rollback fixture",
                facilityId: 30,
            });
            const id = report.body.maintenanceRequest.requestId;
            await request(
                "POST",
                `/maintenance/${id}/assign`,
                { staffId: 201 },
                101,
            );
            const before = await prisma.maintenanceLog.count({
                where: { requestId: id },
            });
            const auditBefore = (
                await pool.query(
                    "SELECT count(*) FROM audit_logs WHERE table_name='maintenance_requests' AND record_id=$1",
                    [id],
                )
            ).rows[0].count;
            await pool.query(
                "ALTER TABLE maintenance_logs ADD CONSTRAINT fixture_action_failure CHECK(action_taken<>'Fail synthetic log') NOT VALID",
            );
            try {
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/maintenance/${id}/progress`,
                            {
                                status: "In Progress",
                                actionTaken: "Fail synthetic log",
                            },
                            201,
                        )
                    ).status,
                    500,
                );
            } finally {
                await pool.query(
                    "ALTER TABLE maintenance_logs DROP CONSTRAINT fixture_action_failure",
                );
            }
            assert.equal(
                (
                    await prisma.maintenanceRequest.findUnique({
                        where: { requestId: id },
                    })
                ).status,
                "Open",
            );
            assert.equal(
                await prisma.maintenanceLog.count({ where: { requestId: id } }),
                before,
            );
            assert.equal(
                (
                    await pool.query(
                        "SELECT count(*) FROM audit_logs WHERE table_name='maintenance_requests' AND record_id=$1",
                        [id],
                    )
                ).rows[0].count,
                auditBefore,
            );
            const client = await runtimePool.connect();
            try {
                await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
                await client.query(
                    "SELECT set_config('im101.actor_id','301',true)",
                );
                await assert.rejects(
                    client.query(
                        "INSERT INTO maintenance_requests(facility_id,description,reported_by) VALUES(30,'Fixture',NULL)",
                    ),
                    { code: "C4001" },
                );
            } finally {
                await client.query("ROLLBACK");
                client.release();
            }
        },
    );
    await check(
        "catalogs staff selectors and role-scoped overview return only API-provided values",
        async () => {
            assert.equal((await request("GET", "/facility-types")).status, 200);
            assert.equal(
                (await request("GET", "/equipment-categories")).status,
                200,
            );
            assert.equal(
                (await request("GET", "/staff", undefined, 301)).status,
                403,
            );
            const roster = await request("GET", "/staff", undefined, 101);
            assert.equal(roster.status, 200);
            assert.deepEqual(Object.keys(roster.body.staff[0]).sort(), [
                "fname",
                "lname",
                "userId",
            ]);
            const overview = await request("GET", "/overview");
            assert.equal(overview.status, 200);
            assert.equal(
                overview.body.overview.loans,
                await prisma.equipmentLoan.count({ where: { userId: 301 } }),
            );
            assert.ok(!Object.hasOwn(overview.body.overview, "assignments"));
        },
    );
    await check(
        "every core snapshot uses its exact independent field allowlist",
        async () => {
            const fields = {
                equipment_loans:
                    "loan_id user_id approved_by requested_at due_date return_date loan_status",
                maintenance_requests:
                    "request_id facility_id equipment_id reported_by assigned_staff_id priority status reported_at resolved_at",
                maintenance_logs: "log_id request_id staff_id logged_at",
                facility_staff_assignments:
                    "assignment_id facility_id staff_id assigned_role shift assigned_date unassigned_date",
            };
            for (const [table, allowed] of Object.entries(fields)) {
                const entries = (
                    await pool.query(
                        "SELECT action_type,old_value,new_value FROM audit_logs WHERE table_name=$1",
                        [table],
                    )
                ).rows;
                assert.ok(entries.length > 0);
                for (const entry of entries) {
                    assert.equal(
                        entry.old_value === null,
                        entry.action_type === "INSERT",
                    );
                    assert.equal(
                        entry.new_value === null,
                        entry.action_type === "DELETE",
                    );
                    for (const value of [entry.old_value, entry.new_value])
                        if (value)
                            assert.deepEqual(
                                Object.keys(value).sort(),
                                allowed.split(" ").sort(),
                            );
                }
            }
        },
    );
    await check(
        "core audit captures privileged DELETE without granting runtime history deletion",
        async () => {
            const client = await pool.connect();
            try {
                await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
                await client.query(
                    "SELECT set_config('im101.actor_id','301',true)",
                );
                const id = (
                    await client.query(
                        "INSERT INTO equipment_loans(user_id,due_date) VALUES(301,clock_timestamp()+interval '1 day') RETURNING loan_id",
                    )
                ).rows[0].loan_id;
                await client.query(
                    "SELECT set_config('im101.actor_id','101',true)",
                );
                await client.query(
                    "UPDATE equipment_loans SET loan_status='Rejected' WHERE loan_id=$1",
                    [id],
                );
                await client.query(
                    "DELETE FROM equipment_loans WHERE loan_id=$1",
                    [id],
                );
                const entries = (
                    await client.query(
                        "SELECT action_type,changed_by,old_value,new_value FROM audit_logs WHERE table_name='equipment_loans' AND record_id=$1 ORDER BY log_id",
                        [id],
                    )
                ).rows;
                assert.deepEqual(
                    entries.map((entry) => [
                        entry.action_type,
                        entry.changed_by,
                    ]),
                    [
                        ["INSERT", 301],
                        ["UPDATE", 101],
                        ["DELETE", 101],
                    ],
                );
                assert.equal(entries[2].old_value.loan_status, "Rejected");
                assert.equal(entries[2].new_value, null);
            } finally {
                await client.query("ROLLBACK");
                client.release();
            }
        },
    );
    await check(
        "core effective grants and missing actor writes fail closed",
        async () => {
            const forbidden = await runtimePool.query(
                "SELECT has_table_privilege(current_user,'audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(current_user,'audit_logs','SELECT,INSERT,UPDATE') AS allowed",
            );
            assert.equal(forbidden.rows[0].allowed, false);
            for (const name of [
                "loan_workflow",
                "loan_item_guard",
                "maintenance_guard",
                "maintenance_log_guard",
                "assignment_guard",
                "audit_core",
            ]) {
                const routine = (
                    await pool.query(
                        "SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='im101_private' AND p.proname=$1",
                        [name],
                    )
                ).rows[0];
                assert.equal(routine.prosecdef, true);
                assert.ok(
                    routine.proconfig.includes(
                        "search_path=pg_catalog, pg_temp",
                    ),
                );
                assert.equal(
                    routine.rolname,
                    name === "audit_core"
                        ? "im101_core_audit_writer"
                        : "im101_core_owner",
                );
                assert.equal(
                    (
                        await pool.query(
                            "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='im101_private' AND p.proname=$1 AND a.grantee=0 AND a.privilege_type='EXECUTE'",
                            [name],
                        )
                    ).rows[0].count,
                    "0",
                );
            }
            const client = await runtimePool.connect();
            try {
                await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
                await client.query(
                    "SELECT set_config('im101.actor_id','',true)",
                );
                await assert.rejects(
                    client.query(
                        "INSERT INTO maintenance_requests(facility_id,reported_by,description) VALUES(30,301,'Synthetic context refusal')",
                    ),
                    { code: "C4011" },
                );
            } finally {
                await client.query("ROLLBACK");
                client.release();
            }
        },
    );
    await check(
        "existing management APIs still work with all core triggers installed",
        async () => {
            const created = await request(
                "POST",
                "/buildings",
                { buildingName: "Final core compatibility", floorCount: 2 },
                101,
            );
            assert.equal(created.status, 201);
            const bid = created.body.building.buildingId;
            const facility = await request(
                "POST",
                "/facilities",
                {
                    facilityName: "Final core facility",
                    buildingId: bid,
                    facilityTypeId: 1,
                    floorNumber: 1,
                    capacity: 20,
                },
                101,
            );
            assert.equal(facility.status, 201);
            const fid = facility.body.facility.facilityId;
            const equipment = await request(
                "POST",
                "/equipment",
                {
                    equipmentName: "Final core equipment",
                    categoryId: 1,
                    homeFacilityId: fid,
                    totalQuantity: 2,
                    availableQuantity: 2,
                },
                101,
            );
            assert.equal(equipment.status, 201);
            const eid = equipment.body.equipment.equipmentId;
            assert.equal(
                (
                    await request(
                        "PUT",
                        `/equipment/${eid}`,
                        { totalQuantity: 3, availableQuantity: 3 },
                        101,
                    )
                ).status,
                200,
            );
            assert.equal(
                (await request("DELETE", `/equipment/${eid}`, undefined, 101))
                    .status,
                200,
            );
            assert.equal(
                (await request("DELETE", `/facilities/${fid}`, undefined, 101))
                    .status,
                200,
            );
            assert.equal(
                (await request("DELETE", `/buildings/${bid}`, undefined, 101))
                    .status,
                200,
            );
            assert.equal(
                (await request("GET", "/reservations", undefined, 301)).status,
                200,
            );
        },
    );
    await check(
        "all immutable plus new core migrations replay without provisioning data",
        async () => {
            const database =
                "im101_reservation_disposable_" +
                randomBytes(12).toString("hex");
            validateDisposableConfig({ ...config, database });
            await pool.query(`CREATE DATABASE "${database}"`);
            const replay = new Pool({ ...config, database, max: 1 });
            try {
                for (const dir of fs
                    .readdirSync("prisma/migrations")
                    .filter((dir) => /^\d{14}_/.test(dir))
                    .sort())
                    await replay.query(
                        fs.readFileSync(
                            `prisma/migrations/${dir}/migration.sql`,
                            "utf8",
                        ),
                    );
                for (const table of [
                    "users",
                    "reservation_status",
                    "equipment_loans",
                    "maintenance_requests",
                    "facility_staff_assignments",
                    "audit_logs",
                ])
                    assert.equal(
                        (await replay.query(`SELECT count(*) FROM ${table}`))
                            .rows[0].count,
                        "0",
                    );
            } finally {
                await replay.end();
            }
        },
    );
}
module.exports = { run };
