const assert = require("node:assert/strict");
const fs = require("node:fs");
async function run({
    pool,
    gateway,
    create,
    check,
    race,
    approve,
    row,
    start,
    end,
}) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026040000_reservation_reject/migration.sql",
            "utf8",
        ),
    );
    async function reject(id, actor = 102) {
        return gateway(
            { userId: actor },
            (tx) =>
                tx.$queryRaw`CALL im101_private.reject_reservation(${id}::integer,NULL::integer)`,
        );
    }
    const s = new Date(Date.parse(start) + 7 * 86400000).toISOString(),
        e = new Date(Date.parse(end) + 7 * 86400000).toISOString();
    await check(
        "rejection requires active admin and another user's Pending request; approver stays NULL",
        async () => {
            const own = await create(102, 2, s, e);
            await assert.rejects(reject(own.reservationId), {
                code: "RESERVATION_ACCESS",
            });
            const pending = await create(201, 2, s, e);
            for (const actor of [201, 301])
                await assert.rejects(reject(pending.reservationId, actor), {
                    code: "RESERVATION_ACCESS",
                });
            await reject(pending.reservationId);
            const rejected = await row(pending.reservationId);
            assert.equal(rejected.statusId, 41);
            assert.equal(rejected.approvedBy, null);
            assert.equal(rejected.requestedBy, 201);
            const audit = (
                await pool.query(
                    "SELECT changed_by FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE' ORDER BY log_id DESC LIMIT 1",
                    [pending.reservationId],
                )
            ).rows[0];
            assert.equal(audit.changed_by, 102);
            await assert.rejects(reject(pending.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            const approved = await create(201, 2, s, e);
            await approve(approved.reservationId);
            await assert.rejects(reject(approved.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
        },
    );
    await check(
        "competing approval and rejection commit only one audited Pending transition",
        async () => {
            const a = await create(
                201,
                2,
                new Date(Date.parse(s) + 86400000).toISOString(),
                new Date(Date.parse(e) + 86400000).toISOString(),
            );
            const results = await race(
                (client) =>
                    client.query(
                        "CALL im101_private.approve_reservation($1,NULL)",
                        [a.reservationId],
                    ),
                (client) =>
                    client.query(
                        "CALL im101_private.reject_reservation($1,NULL)",
                        [a.reservationId],
                    ),
            );
            assert.equal(
                [results.aError, results.bError].filter(Boolean).length,
                1,
            );
            assert.ok([29, 41].includes((await row(a.reservationId)).statusId));
            assert.equal(
                (
                    await pool.query(
                        "SELECT count(*) FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE'",
                        [a.reservationId],
                    )
                ).rows[0].count,
                "1",
            );
        },
    );
    return { reject };
}
module.exports = { run };
