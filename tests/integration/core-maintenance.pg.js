const assert = require("node:assert/strict");
const fs = require("node:fs");
async function run({ pool, prisma, check, request, race }) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261027020000_maintenance_assignments/migration.sql",
            "utf8",
        ),
    );
    await pool.query(
        "INSERT INTO users(user_id,role_id,fname,lname,email,password_hash) VALUES(202,22,'Fixture','Other Staff','other-staff@example.test','not-a-login-hash')",
    );
    await check(
        "maintenance report assignment progress logs and resolution enforce visibility and actual actors",
        async () => {
            for (const input of [
                { description: "Fixture" },
                { description: "Fixture", facilityId: 30, equipmentId: 101 },
            ])
                assert.equal(
                    (await request("POST", "/maintenance", input)).status,
                    400,
                );
            const created = await request("POST", "/maintenance", {
                description: "Fixture maintenance",
                facilityId: 30,
            });
            assert.equal(created.status, 201, "CHECK_MAINTENANCE_CREATE");
            const id = created.body.maintenanceRequest.requestId;
            assert.equal(
                (await request("GET", `/maintenance/${id}`, undefined, 201))
                    .status,
                404,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/assign`,
                        { staffId: 202 },
                        201,
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/assign`,
                        { staffId: 201 },
                        201,
                    )
                ).status,
                200,
                "CHECK_MAINTENANCE_ASSIGN",
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/progress`,
                        { status: "In Progress", actionTaken: "Fixture start" },
                        202,
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/progress`,
                        { status: "Resolved", actionTaken: "Skip" },
                        201,
                    )
                ).status,
                409,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/progress`,
                        { status: "In Progress", actionTaken: "Fixture start" },
                        201,
                    )
                ).status,
                200,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/logs`,
                        { actionTaken: "Fixture action" },
                        201,
                    )
                ).status,
                201,
            );
            assert.equal(
                (
                    await request(
                        "PATCH",
                        `/maintenance/${id}/priority`,
                        { priority: "High" },
                        201,
                    )
                ).status,
                200,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/progress`,
                        {
                            status: "Resolved",
                            actionTaken: "Fixture completed",
                        },
                        201,
                    )
                ).status,
                200,
                "CHECK_MAINTENANCE_RESOLVE",
            );
            const detail = await request("GET", `/maintenance/${id}`);
            assert.equal(detail.body.maintenanceRequest.status, "Resolved");
            assert.ok(detail.body.maintenanceRequest.resolvedAt);
            assert.ok(
                detail.body.maintenanceRequest.logs.every(
                    (log) => log.staffId === 201,
                ),
            );
            assert.equal(detail.body.maintenanceRequest.logs.length, 5);
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/logs`,
                        { actionTaken: "Late" },
                        201,
                    )
                ).status,
                409,
            );
        },
    );
    await check(
        "competing maintenance completion creates one final action and no invalid transition",
        async () => {
            const created = await request("POST", "/maintenance", {
                description: "Fixture race",
                equipmentId: 101,
            });
            const id = created.body.maintenanceRequest.requestId;
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/assign`,
                        { staffId: 201 },
                        101,
                    )
                ).status,
                200,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        `/maintenance/${id}/progress`,
                        { status: "In Progress", actionTaken: "Start" },
                        201,
                    )
                ).status,
                200,
            );
            const results = await Promise.all([
                request(
                    "POST",
                    `/maintenance/${id}/progress`,
                    { status: "Resolved", actionTaken: "Done" },
                    201,
                ),
                request(
                    "POST",
                    `/maintenance/${id}/progress`,
                    { status: "Resolved", actionTaken: "Done" },
                    201,
                ),
            ]);
            assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
            assert.equal(
                await prisma.maintenanceLog.count({
                    where: { requestId: id, actionTaken: "Done" },
                }),
                1,
            );
        },
    );
    await check(
        "independent PostgreSQL connections enforce the active assignment unique key",
        async () => {
            const sql =
                "INSERT INTO facility_staff_assignments(facility_id,staff_id,assigned_role) VALUES(30,202,'Maintenance Technician')";
            const result = await race(
                (client) => client.query(sql),
                (client) => client.query(sql),
                [101, 102],
                ["40001", "40P01", "23505", "C4091"],
            );
            assert.equal(result.blocked, true);
            assert.equal(
                [result.aError, result.bError].filter(Boolean).length,
                1,
            );
            assert.equal(
                await prisma.facilityStaffAssignment.count({
                    where: {
                        facilityId: 30,
                        staffId: 202,
                        assignedRole: "Maintenance Technician",
                        unassignedDate: null,
                    },
                }),
                1,
            );
        },
    );
    await check(
        "assignment lifecycle eligible staff duplicate-active races and historical ending",
        async () => {
            assert.equal(
                (
                    await request(
                        "POST",
                        "/assignments",
                        { facilityId: 30, staffId: 201 },
                        201,
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        "/assignments",
                        { facilityId: 30, staffId: 301 },
                        101,
                    )
                ).status,
                400,
            );
            const results = await Promise.all([
                request(
                    "POST",
                    "/assignments",
                    { facilityId: 30, staffId: 201, shift: "Day" },
                    101,
                ),
                request(
                    "POST",
                    "/assignments",
                    { facilityId: 30, staffId: 201, shift: "Night" },
                    102,
                ),
            ]);
            assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
            const winner = results.find((r) => r.status === 201).body
                .assignment;
            assert.equal(
                (
                    await request(
                        "GET",
                        `/assignments/${winner.assignmentId}`,
                        undefined,
                        202,
                    )
                ).status,
                404,
            );
            assert.equal(
                (
                    await request(
                        "GET",
                        "/assignments?staffId=201",
                        undefined,
                        202,
                    )
                ).status,
                403,
            );
            assert.equal(
                (
                    await request(
                        "PATCH",
                        `/assignments/${winner.assignmentId}`,
                        { shift: "Evening" },
                        101,
                    )
                ).status,
                200,
            );
            await pool.query(
                "UPDATE users SET is_active=false WHERE user_id=201",
            );
            try {
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/assignments/${winner.assignmentId}/end`,
                            {},
                            101,
                        )
                    ).status,
                    200,
                    "CHECK_ASSIGNMENT_END",
                );
            } finally {
                await pool.query(
                    "UPDATE users SET is_active=true WHERE user_id=201",
                );
            }
            assert.equal(
                (
                    await request(
                        "POST",
                        `/assignments/${winner.assignmentId}/end`,
                        {},
                        101,
                    )
                ).status,
                409,
            );
            assert.equal(
                await prisma.facilityStaffAssignment.count({
                    where: { assignmentId: winner.assignmentId },
                }),
                1,
            );
            assert.equal(
                (
                    await request(
                        "POST",
                        "/assignments",
                        { facilityId: 30, staffId: 201 },
                        101,
                    )
                ).status,
                201,
            );
        },
    );
}
module.exports = { run };
