const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createApp } = require("../../src/app");

async function run({ pool, prisma, gateway, create, check }) {
    const secret = randomBytes(48).toString("hex"),
        password = randomBytes(24).toString("hex");
    await pool.query("UPDATE users SET password_hash=$1 WHERE user_id=101", [
        await bcrypt.hash(password, 12),
    ]);
    const app = createApp({ getPrisma: () => prisma, jwtSecret: secret });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    function token(user) {
        return jwt.sign({}, secret, {
            subject: String(user),
            issuer: "im101-api",
            audience: "im101-client",
            expiresIn: "15m",
        });
    }
    async function request(
        method,
        path,
        body,
        user = 101,
        authorization,
        contentType = "application/json",
    ) {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}${path}`,
            {
                method,
                headers: {
                    "Content-Type": contentType,
                    ...(user !== null
                        ? {
                              Authorization:
                                  authorization ?? "Bearer " + token(user),
                          }
                        : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            },
        );
        const result = await response.json();
        assert.equal(response.headers.get("cache-control"), "no-store");
        const text = JSON.stringify(result);
        assert.ok(!text.includes(password));
        assert.ok(!text.includes(secret));
        assert.ok(!text.includes("passwordHash"));
        return { status: response.status, body: result };
    }
    let slot = 0;
    function payload(facilityId = 30) {
        const start = Date.now() + 45 * 86400000 + slot++ * 7200000;
        return {
            facilityId,
            purpose: "HTTP fixture purpose",
            startDatetime: new Date(start).toISOString(),
            endDatetime: new Date(start + 3600000).toISOString(),
        };
    }
    const scalarFields = [
        "reservationId",
        "facilityId",
        "requestedBy",
        "approvedBy",
        "statusId",
        "purpose",
        "startDatetime",
        "endDatetime",
        "createdAt",
    ].sort();
    try {
        await check(
            "real HTTP login JWT RBAC status API and reservation create approve reject cancel",
            async () => {
                const login = await request(
                    "POST",
                    "/api/auth/login",
                    { email: "admin@example.test", password },
                    null,
                );
                assert.equal(login.status, 200);
                assert.equal(typeof login.body.token, "string");
                assert.equal(
                    (
                        await request(
                            "GET",
                            "/api/auth/me",
                            undefined,
                            101,
                            "Bearer " + login.body.token,
                        )
                    ).status,
                    200,
                );
                const statuses = await request(
                    "GET",
                    "/api/reservation-statuses",
                    undefined,
                    201,
                );
                assert.equal(statuses.status, 200);
                assert.deepEqual(
                    statuses.body.reservationStatuses.map((r) => r.statusId),
                    [17, 29, 41, 53],
                );
                const created = await request(
                    "POST",
                    "/api/reservations",
                    payload(),
                    201,
                );
                assert.equal(created.status, 201, "CHECK_HTTP_CREATION");
                const id = created.body.reservation.reservationId;
                assert.deepEqual(
                    Object.keys(created.body.reservation).sort(),
                    scalarFields,
                );
                assert.equal(created.body.reservation.requestedBy, 201);
                assert.equal(
                    (
                        await request(
                            "GET",
                            `/api/reservations/${id}`,
                            undefined,
                            201,
                        )
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request(
                            "GET",
                            `/api/reservations/${id}`,
                            undefined,
                            301,
                        )
                    ).status,
                    404,
                );
                assert.equal(
                    (
                        await request(
                            "GET",
                            `/api/reservations/${id}`,
                            undefined,
                            101,
                        )
                    ).status,
                    200,
                );
                const own = await request(
                    "GET",
                    "/api/reservations?limit=100",
                    undefined,
                    301,
                );
                assert.equal(own.status, 200);
                assert.ok(
                    own.body.reservations.every((r) => r.requestedBy === 301),
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${id}/approve`,
                            {},
                            201,
                        )
                    ).status,
                    403,
                );
                const approved = await request(
                    "POST",
                    `/api/reservations/${id}/approve`,
                    {},
                    101,
                );
                assert.equal(approved.status, 200, "CHECK_HTTP_APPROVAL");
                assert.equal(approved.body.reservation.approvedBy, 101);
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${id}/approve`,
                            {},
                            102,
                        )
                    ).status,
                    409,
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${id}/cancel`,
                            {},
                            301,
                        )
                    ).status,
                    404,
                );
                const cancelled = await request(
                    "POST",
                    `/api/reservations/${id}/cancel`,
                    {},
                    201,
                );
                assert.equal(cancelled.status, 200);
                assert.equal(cancelled.body.reservation.approvedBy, 101);
                assert.equal(cancelled.body.reservation.statusId, 53);
                const pending = await request(
                    "POST",
                    "/api/reservations",
                    payload(),
                    201,
                );
                assert.equal(pending.status, 201);
                const rejected = await request(
                    "POST",
                    `/api/reservations/${pending.body.reservation.reservationId}/reject`,
                    {},
                    102,
                );
                assert.equal(rejected.status, 200);
                assert.equal(rejected.body.reservation.approvedBy, null);
                assert.equal(rejected.body.reservation.statusId, 41);
                const ownAdmin = await request(
                    "POST",
                    "/api/reservations",
                    payload(),
                    101,
                );
                const ownId = ownAdmin.body.reservation.reservationId;
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${ownId}/approve`,
                            {},
                            101,
                        )
                    ).status,
                    403,
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${ownId}/reject`,
                            {},
                            101,
                        )
                    ).status,
                    403,
                );
            },
        );
        await check(
            "real HTTP malformed input authentication inactive deleted unsupported and stale-role users fail closed",
            async () => {
                for (const body of [
                    { ...payload(), requestedBy: 301 },
                    { ...payload(), statusId: 29 },
                    { ...payload(), facilityId: "30" },
                    { ...payload(), purpose: "" },
                ])
                    assert.equal(
                        (await request("POST", "/api/reservations", body, 201))
                            .status,
                        400,
                    );
                assert.equal(
                    (
                        await request(
                            "POST",
                            "/api/reservations",
                            payload(),
                            null,
                        )
                    ).status,
                    401,
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            "/api/reservations",
                            payload(),
                            101,
                            "Bearer malformed",
                        )
                    ).status,
                    401,
                );
                assert.equal(
                    (await request("GET", "/api/reservations", undefined, 999))
                        .status,
                    401,
                );
                await pool.query(
                    "UPDATE users SET is_active=false WHERE user_id=201",
                );
                try {
                    assert.equal(
                        (
                            await request(
                                "GET",
                                "/api/reservations",
                                undefined,
                                201,
                            )
                        ).status,
                        401,
                    );
                    assert.equal(
                        (
                            await request(
                                "POST",
                                "/api/reservations",
                                payload(),
                                201,
                            )
                        ).status,
                        401,
                    );
                    await assert.rejects(create(201), {
                        code: "RESERVATION_AUTHENTICATION",
                    });
                } finally {
                    await pool.query(
                        "UPDATE users SET is_active=true WHERE user_id=201",
                    );
                }
                await pool.query(
                    "INSERT INTO roles(role_id,role_name) VALUES(44,'Fixture Unsupported'); INSERT INTO users(user_id,role_id,fname,lname,email,password_hash) VALUES(401,44,'Fixture','Unsupported','unsupported@example.test','not-a-login-hash')",
                );
                assert.equal(
                    (await request("POST", "/api/reservations", payload(), 401))
                        .status,
                    403,
                );
                await assert.rejects(create(401), {
                    code: "RESERVATION_ACCESS",
                });
                await pool.query(
                    "UPDATE users SET role_id=22 WHERE user_id=101",
                );
                try {
                    assert.equal(
                        (
                            await request(
                                "POST",
                                "/api/reservations/1/approve",
                                {},
                                101,
                            )
                        ).status,
                        403,
                    );
                    await assert.rejects(
                        gateway(
                            { userId: 101 },
                            (tx) =>
                                tx.$queryRaw`CALL im101_private.approve_reservation(1,NULL::integer)`,
                        ),
                        { code: "RESERVATION_ACCESS" },
                    );
                } finally {
                    await pool.query(
                        "UPDATE users SET role_id=11 WHERE user_id=101",
                    );
                }
            },
        );
        await check(
            "SQL injection-shaped purpose stays bound data and never enters audit snapshots",
            async () => {
                const before = (
                    await pool.query("SELECT count(*) FROM reservations")
                ).rows[0].count;
                const purpose =
                    "Fixture'); DELETE FROM public.reservations; --";
                const response = await request(
                    "POST",
                    "/api/reservations",
                    { ...payload(), purpose },
                    201,
                );
                assert.equal(response.status, 201);
                assert.equal(response.body.reservation.purpose, purpose);
                assert.equal(
                    Number(
                        (await pool.query("SELECT count(*) FROM reservations"))
                            .rows[0].count,
                    ),
                    Number(before) + 1,
                );
                const audit = (
                    await pool.query(
                        "SELECT new_value FROM audit_logs WHERE record_id=$1 AND action_type='INSERT'",
                        [response.body.reservation.reservationId],
                    )
                ).rows[0].new_value;
                assert.ok(!Object.hasOwn(audit, "purpose"));
            },
        );
        await check(
            "missing lookup configuration refuses every HTTP mutation without provisioning",
            async () => {
                const pending = await request(
                    "POST",
                    "/api/reservations",
                    payload(),
                    201,
                );
                assert.equal(pending.status, 201);
                const id = pending.body.reservation.reservationId;
                for (const action of ["approve", "reject", "cancel"])
                    assert.equal(
                        (
                            await request(
                                "POST",
                                `/api/reservations/${id}/${action}`,
                                { requestedBy: 101 },
                                101,
                                undefined,
                                "text/plain",
                            )
                        ).status,
                        400,
                    );
                await pool.query(
                    "UPDATE reservation_status SET status_name='Fixture unavailable' WHERE status_id=53",
                );
                try {
                    assert.equal(
                        (
                            await request(
                                "POST",
                                "/api/reservations",
                                payload(),
                                201,
                            )
                        ).status,
                        503,
                    );
                    for (const action of ["approve", "reject", "cancel"])
                        assert.equal(
                            (
                                await request(
                                    "POST",
                                    `/api/reservations/${id}/${action}`,
                                    {},
                                    101,
                                )
                            ).status,
                            503,
                        );
                } finally {
                    await pool.query(
                        "UPDATE reservation_status SET status_name='Cancelled' WHERE status_id=53",
                    );
                }
                assert.equal(
                    (
                        await prisma.reservation.findUnique({
                            where: { reservationId: id },
                        })
                    ).statusId,
                    17,
                );
            },
        );
        await check(
            "real HTTP Facilities closure conflict and Buildings Facilities Equipment CRUD compatibility",
            async () => {
                const booked = await request(
                    "POST",
                    "/api/reservations",
                    payload(),
                    201,
                );
                assert.equal(booked.status, 201);
                const id = booked.body.reservation.reservationId;
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${id}/approve`,
                            {},
                            101,
                        )
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request("PUT", "/api/facilities/30", {
                            status: "Closed",
                        })
                    ).status,
                    409,
                    "CHECK_HTTP_CLOSURE",
                );
                assert.equal(
                    (
                        await request(
                            "POST",
                            `/api/reservations/${id}/cancel`,
                            {},
                            201,
                        )
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request("PUT", "/api/facilities/30", {
                            status: "Closed",
                        })
                    ).status,
                    200,
                );
                assert.equal(
                    (
                        await request("PUT", "/api/facilities/30", {
                            status: "Available",
                        })
                    ).status,
                    200,
                );
                await pool.query(
                    "INSERT INTO equipment_categories(category_id,category_name) VALUES(1,'Fixture category'); SELECT setval('buildings_building_id_seq',(SELECT max(building_id) FROM buildings)); SELECT setval('facilities_facility_id_seq',(SELECT max(facility_id) FROM facilities));",
                );
                const building = await request("POST", "/api/buildings", {
                    buildingName: "HTTP compatibility building",
                    floorCount: 2,
                });
                assert.equal(building.status, 201);
                const bid = building.body.building.buildingId;
                assert.equal(
                    (
                        await request("PUT", `/api/buildings/${bid}`, {
                            floorCount: 3,
                        })
                    ).status,
                    200,
                );
                const facility = await request("POST", "/api/facilities", {
                    buildingId: bid,
                    facilityTypeId: 1,
                    facilityName: "HTTP compatibility facility",
                    floorNumber: 2,
                    capacity: 30,
                });
                assert.equal(facility.status, 201);
                const fid = facility.body.facility.facilityId;
                assert.equal(
                    (
                        await request("PUT", `/api/facilities/${fid}`, {
                            status: "Inspection",
                        })
                    ).status,
                    200,
                );
                const equipment = await request("POST", "/api/equipment", {
                    categoryId: 1,
                    homeFacilityId: fid,
                    equipmentName: "HTTP compatibility equipment",
                    totalQuantity: 2,
                    availableQuantity: 2,
                });
                assert.equal(equipment.status, 201);
                const eid = equipment.body.equipment.equipmentId;
                assert.equal(
                    (
                        await request("PUT", `/api/equipment/${eid}`, {
                            totalQuantity: 3,
                            availableQuantity: 3,
                        })
                    ).status,
                    200,
                );
                for (const [collection, item] of [
                    ["buildings", bid],
                    ["facilities", fid],
                    ["equipment", eid],
                ]) {
                    assert.equal(
                        (await request("GET", `/api/${collection}/${item}`))
                            .status,
                        200,
                    );
                    assert.equal(
                        (await request("GET", `/api/${collection}?limit=20`))
                            .status,
                        200,
                    );
                }
                assert.equal(
                    (await request("DELETE", `/api/equipment/${eid}`)).status,
                    200,
                );
                assert.equal(
                    (await request("DELETE", `/api/facilities/${fid}`)).status,
                    200,
                );
                assert.equal(
                    (await request("DELETE", `/api/buildings/${bid}`)).status,
                    200,
                );
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}
module.exports = { run };
