const assert = require("node:assert/strict");
const fs = require("node:fs");
async function run({
    pool,
    gateway,
    create,
    check,
    race,
    approve,
    cancel,
    row,
    start,
    end,
    transaction,
}) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026060000_facility_reservation_guard/migration.sql",
            "utf8",
        ),
    );
    await pool.query(
        "INSERT INTO facilities(facility_id,building_id,facility_type_id,facility_name,floor_number,capacity) VALUES(30,1,1,'Closure fixture',1,20)",
    );
    const s = new Date(Date.parse(start) + 25 * 86400000).toISOString(),
        e = new Date(Date.parse(end) + 25 * 86400000).toISOString();
    async function close() {
        return gateway({ userId: 101 }, (tx) =>
            tx.facility.update({
                where: { facilityId: 30 },
                data: { status: "Closed" },
            }),
        );
    }
    const reopen = () =>
        transaction("101", (client) =>
            client.query(
                "UPDATE facilities SET status='Available' WHERE facility_id=30",
            ),
        );
    await check(
        "future Approved bookings block closure while Pending and Cancelled do not",
        async () => {
            const pending = await create(201, 30, s, e);
            await close();
            await reopen();
            await approve(pending.reservationId);
            await assert.rejects(close(), { code: "RESERVATION_CONFLICT" });
            await cancel(pending.reservationId);
            await close();
            await reopen();
        },
    );
    await check(
        "active Approved bookings block closure; completed Approved bookings do not",
        async () => {
            const booking = await create(201, 30, s, e);
            await approve(booking.reservationId);
            await transaction("101", (client) =>
                client.query(
                    "UPDATE reservations SET start_datetime=now()-interval '1 hour',end_datetime=now()+interval '1 hour' WHERE reservation_id=$1",
                    [booking.reservationId],
                ),
            );
            await assert.rejects(close(), { code: "RESERVATION_CONFLICT" });
            await transaction("101", (client) =>
                client.query(
                    "UPDATE reservations SET end_datetime=now()-interval '1 minute' WHERE reservation_id=$1",
                    [booking.reservationId],
                ),
            );
            await close();
            await reopen();
        },
    );
    await check(
        "approval versus closure race cannot leave an unavailable facility with an Approved future booking",
        async () => {
            for (const first of ["approve", "close"]) {
                const booking = await create(201, 30, s, e);
                const approval = (client) =>
                    client.query(
                        "CALL im101_private.approve_reservation($1,NULL)",
                        [booking.reservationId],
                    );
                const closing = (client) =>
                    client.query(
                        "UPDATE facilities SET status='Closed' WHERE facility_id=30",
                    );
                const result = await race(
                    first === "approve" ? approval : closing,
                    first === "approve" ? closing : approval,
                );
                assert.equal(
                    [result.aError, result.bError].filter(Boolean).length,
                    1,
                );
                const status = (
                    await pool.query(
                        "SELECT status FROM facilities WHERE facility_id=30",
                    )
                ).rows[0].status;
                const bookingStatus = (await row(booking.reservationId))
                    .statusId;
                assert.ok(!(status !== "Available" && bookingStatus === 29));
                if (bookingStatus === 29) await cancel(booking.reservationId);
                await reopen();
            }
        },
    );
    await check(
        "direct nonserializable facility closure is refused",
        async () => {
            await assert.rejects(
                pool.query(
                    "UPDATE facilities SET status='Closed' WHERE facility_id=30",
                ),
                { code: "R4091" },
            );
        },
    );
}
module.exports = { run };
