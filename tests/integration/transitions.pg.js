const assert = require("node:assert/strict");
const fs = require("node:fs");

async function run({
    pool,
    prisma,
    runtimePool,
    gateway,
    create,
    check,
    transaction,
    start,
    end,
}) {
    await pool.query(
        fs.readFileSync(
            "prisma/migrations/20261026030000_reservation_approve/migration.sql",
            "utf8",
        ),
    );
    async function approve(id, actor = 101) {
        return gateway(
            { userId: actor },
            (tx) =>
                tx.$queryRaw`CALL im101_private.approve_reservation(${id}::integer,NULL::integer)`,
        );
    }
    async function row(id) {
        return prisma.reservation.findUnique({ where: { reservationId: id } });
    }
    await check(
        "approval role self-review Pending transition eligibility and audit checks in PostgreSQL",
        async () => {
            const own = await create(101);
            await assert.rejects(approve(own.reservationId), {
                code: "RESERVATION_ACCESS",
            });
            const booking = await create(
                201,
                1,
                new Date(Date.parse(start) + 2 * 86400000).toISOString(),
                new Date(Date.parse(end) + 2 * 86400000).toISOString(),
            );
            for (const actor of [201, 301])
                await assert.rejects(approve(booking.reservationId, actor), {
                    code: "RESERVATION_ACCESS",
                });
            const result = await approve(booking.reservationId);
            assert.equal(result[0].p_result_id, booking.reservationId);
            const approved = await row(booking.reservationId);
            assert.equal(approved.requestedBy, 201);
            assert.equal(approved.approvedBy, 101);
            assert.equal(approved.statusId, 29);
            await assert.rejects(approve(booking.reservationId), {
                code: "RESERVATION_CONFLICT",
            });
            await assert.rejects(approve(2147483647), {
                code: "RESERVATION_NOT_FOUND",
            });
            const audit = (
                await pool.query(
                    "SELECT changed_by,new_value FROM audit_logs WHERE record_id=$1 AND action_type='UPDATE' ORDER BY log_id DESC LIMIT 1",
                    [booking.reservationId],
                )
            ).rows[0];
            assert.equal(audit.changed_by, 101);
            assert.equal(audit.new_value.status_id, 29);
        },
    );
    async function race(
        first,
        second,
        actors = [101, 102],
        allowedErrors = ["40001", "40P01", "R4091"],
    ) {
        const a = await runtimePool.connect(),
            b = await runtimePool.connect();
        let bPending;
        try {
            const pids = await Promise.all([
                a.query("SELECT pg_backend_pid() AS pid"),
                b.query("SELECT pg_backend_pid() AS pid"),
            ]);
            assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);
            await Promise.all([
                a.query("BEGIN ISOLATION LEVEL SERIALIZABLE"),
                b.query("BEGIN ISOLATION LEVEL SERIALIZABLE"),
            ]);
            await Promise.all([
                a.query("SELECT set_config('im101.actor_id',$1,true)", [
                    String(actors[0]),
                ]),
                b.query("SELECT set_config('im101.actor_id',$1,true)", [
                    String(actors[1]),
                ]),
            ]);
            await first(a);
            let settled = false;
            bPending = second(b).then(
                () => {
                    settled = true;
                    return null;
                },
                (error) => {
                    settled = true;
                    return error;
                },
            );
            // Observe actual PostgreSQL lock waiting before releasing the first transaction.
            let blocked = false;
            for (let attempt = 0; attempt < 100 && !settled; attempt++) {
                const locks = (
                    await pool.query(
                        "SELECT cardinality(pg_blocking_pids($1)) AS n",
                        [pids[1].rows[0].pid],
                    )
                ).rows[0].n;
                if (locks > 0) {
                    blocked = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            let aError = null;
            try {
                await a.query("COMMIT");
            } catch (error) {
                aError = error;
                await a.query("ROLLBACK");
            }
            let bError = await bPending;
            if (!bError) {
                try {
                    await b.query("COMMIT");
                } catch (error) {
                    bError = error;
                    await b.query("ROLLBACK");
                }
            } else await b.query("ROLLBACK");
            for (const error of [aError, bError])
                if (error) assert.ok(allowedErrors.includes(error.code));
            return { aError, bError, blocked };
        } finally {
            await Promise.all([a.query("ROLLBACK"), b.query("ROLLBACK")]);
            a.release();
            b.release();
        }
    }
    await check(
        "independent PostgreSQL connections prevent two overlapping approvals from committing",
        async () => {
            const s = new Date(Date.parse(start) + 3 * 86400000).toISOString(),
                e = new Date(Date.parse(end) + 3 * 86400000).toISOString();
            const a = await create(201, 1, s, e),
                b = await create(301, 1, s, e);
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
            assert.equal(results.blocked, true);
            assert.equal(
                [results.aError, results.bError].filter(Boolean).length,
                1,
            );
            const rows = await Promise.all([
                row(a.reservationId),
                row(b.reservationId),
            ]);
            assert.equal(rows.filter((item) => item.statusId === 29).length, 1);
        },
    );
    await check(
        "adjacent intervals can both be approved while overlap is rejected",
        async () => {
            const s = new Date(Date.parse(start) + 4 * 86400000).toISOString(),
                mid = new Date(Date.parse(s) + 3600000).toISOString(),
                e = new Date(Date.parse(mid) + 3600000).toISOString();
            const a = await create(201, 1, s, mid),
                b = await create(301, 1, mid, e);
            await approve(a.reservationId);
            await approve(b.reservationId);
            assert.equal((await row(b.reservationId)).statusId, 29);
        },
    );
    await check(
        "approval rechecks expired dates and unavailable facilities",
        async () => {
            const a = await create(201, 2);
            await transaction("101", (client) =>
                client.query(
                    "UPDATE reservations SET start_datetime=now()-interval '1 hour' WHERE reservation_id=$1",
                    [a.reservationId],
                ),
            );
            await assert.rejects(approve(a.reservationId), {
                code: "RESERVATION_INPUT",
            });
            const b = await create(201, 2);
            await transaction("101", (client) =>
                client.query(
                    "UPDATE facilities SET status='Closed' WHERE facility_id=2",
                ),
            );
            try {
                await assert.rejects(approve(b.reservationId), {
                    code: "RESERVATION_CONFLICT",
                });
            } finally {
                await transaction("101", (client) =>
                    client.query(
                        "UPDATE facilities SET status='Available' WHERE facility_id=2",
                    ),
                );
            }
        },
    );
    const { reject } = await require("./rejections.pg").run({
        pool,
        gateway,
        create,
        check,
        race,
        approve,
        row,
        start,
        end,
    });
    await require("./cancellations.pg").run({
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
    });
    return { race, approve, row };
}
module.exports = { run };
