const assert = require("node:assert/strict");
const fs = require("node:fs");
async function run({
    pool,
    gateway,
    create,
    check,
    race,
    approve,
    reject,
    row,
    start,
    end,
    transaction,
}) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026050000_reservation_cancel/migration.sql",
            "utf8",
        ),
    );
    async function cancel(id, actor = 201) {
        return gateway(
            { userId: actor },
            (tx) =>
                tx.$queryRaw`CALL im101_private.cancel_reservation(${id}::integer,NULL::integer)`,
        );
    }
    let day = 12;
    const fresh = async (actor = 201) => {
        day++;
        return create(
            actor,
            2,
            new Date(Date.parse(start) + day * 86400000).toISOString(),
            new Date(Date.parse(end) + day * 86400000).toISOString(),
        );
    };
    await check(
        "Pending cancellation ownership 404 and provisional administrator override",
        async () => {
            const a = await fresh();
            await assert.rejects(cancel(a.reservationId, 301), {
                code: "RESERVATION_NOT_FOUND",
            });
            await assert.rejects(cancel(2147483647, 301), {
                code: "RESERVATION_NOT_FOUND",
            });
            await cancel(a.reservationId);
            assert.equal((await row(a.reservationId)).statusId, 53);
            assert.equal((await row(a.reservationId)).approvedBy, null);
            await assert.rejects(cancel(a.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            const b = await fresh(301);
            await cancel(b.reservationId, 101);
            assert.equal((await row(b.reservationId)).requestedBy, 301);
            const audit = (
                await pool.query(
                    "SELECT changed_by FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE' ORDER BY log_id DESC LIMIT 1",
                    [b.reservationId],
                )
            ).rows[0];
            assert.equal(audit.changed_by, 101);
        },
    );
    await check(
        "Approved cancellation preserves original approver and releases the occupied slot",
        async () => {
            const a = await fresh();
            await approve(a.reservationId);
            await cancel(a.reservationId);
            const after = await row(a.reservationId);
            assert.equal(after.statusId, 53);
            assert.equal(after.approvedBy, 101);
            const replacement = await create(
                301,
                2,
                after.startDatetime.toISOString(),
                after.endDatetime.toISOString(),
            );
            assert.equal(replacement.statusId, 17);
            const audit = (
                await pool.query(
                    "SELECT changed_by FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE' ORDER BY log_id DESC LIMIT 1",
                    [a.reservationId],
                )
            ).rows[0];
            assert.equal(audit.changed_by, 201);
        },
    );
    await check(
        "started and terminal reservations cannot be cancelled or reopened",
        async () => {
            const a = await fresh();
            await transaction("101", (client) =>
                client.query(
                    "UPDATE reservations SET start_datetime=now()-interval '1 minute' WHERE reservation_id=$1",
                    [a.reservationId],
                ),
            );
            await assert.rejects(cancel(a.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            const b = await fresh();
            await reject(b.reservationId);
            await assert.rejects(cancel(b.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            await assert.rejects(approve(b.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            const c = await fresh();
            await cancel(c.reservationId);
            await assert.rejects(reject(c.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            await assert.rejects(approve(c.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
        },
    );
    await check(
        "approval rejection and cancellation races allow one audited transition",
        async () => {
            for (const first of ["approve", "reject", "cancel"]) {
                const a = await fresh();
                const firstCall =
                    first === "approve"
                        ? (client) =>
                              client.query(
                                  "CALL im101_private.approve_reservation($1,NULL)",
                                  [a.reservationId],
                              )
                        : first === "reject"
                          ? (client) =>
                                client.query(
                                    "CALL im101_private.reject_reservation($1,NULL)",
                                    [a.reservationId],
                                )
                          : (client) =>
                                client.query(
                                    "CALL im101_private.cancel_reservation($1,NULL)",
                                    [a.reservationId],
                                );
                const secondCall =
                    first === "cancel"
                        ? (client) =>
                              client.query(
                                  "CALL im101_private.approve_reservation($1,NULL)",
                                  [a.reservationId],
                              )
                        : (client) =>
                              client.query(
                                  "CALL im101_private.cancel_reservation($1,NULL)",
                                  [a.reservationId],
                              );
                const results = await race(
                    firstCall,
                    secondCall,
                    first === "cancel" ? [201, 101] : [101, 201],
                );
                assert.equal(
                    [results.aError, results.bError].filter(Boolean).length,
                    1,
                );
                assert.equal(
                    (
                        await pool.query(
                            "SELECT count(*) FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE'",
                            [a.reservationId],
                        )
                    ).rows[0].count,
                    "1",
                );
            }
        },
    );
    await require("./closures.pg").run({
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
    });
    return { cancel, fresh };
}
module.exports = { run };
