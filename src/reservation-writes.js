const { Router } = require("express");
const { validateReservationCreation } = require("./reservation-validation");
const { createReservationTransaction } = require("./reservation-transaction");
const { publicErrors } = require("./reservation-errors");

function createReservationWrites({
    getPrisma,
    requireRoles,
    readRoles,
    reservationSelect,
    reservationResponse,
    positiveInteger,
}) {
    const router = Router();
    const creators = requireRoles(readRoles);
    const reviewers = requireRoles(["System Administrator"]);
    const run = createReservationTransaction({ getPrisma });
    function respondError(error, res, next) {
        const code = error?.code;
        const mapped =
            typeof code === "string" && Object.hasOwn(publicErrors, code)
                ? publicErrors[code]
                : null;
        if (!mapped) return next(error);
        return res
            .status(mapped[0])
            .json({ success: false, code, message: mapped[1] });
    }
    router.post("/", creators, async (req, res, next) => {
        if (Object.keys(req.query).length)
            return res.status(400).json({
                success: false,
                message: "Invalid reservation input.",
            });
        const validated = validateReservationCreation(req.body);
        if (!validated.success) return res.status(400).json(validated);
        const { facilityId, purpose, startDatetime, endDatetime } =
            validated.data;
        try {
            const reservation = await run(req.user, async (tx) => {
                const rows =
                    await tx.$queryRaw`CALL im101_private.create_reservation(${facilityId}::integer, ${purpose}::text, ${startDatetime}::timestamptz, ${endDatetime}::timestamptz, NULL::integer)`;
                const id =
                    rows?.length === 1 ? rows[0]?.p_reservation_id : null;
                if (!Number.isInteger(id) || id < 1 || id > 2147483647)
                    throw new Error(
                        "Reservation procedure acknowledgement invalid.",
                    );
                const row = await tx.reservation.findFirst({
                    where: { reservationId: id, requestedBy: req.user.userId },
                    select: reservationSelect,
                });
                if (!row)
                    throw new Error(
                        "Reservation procedure acknowledgement invalid.",
                    );
                return reservationResponse(row);
            });
            res.status(201).json({ success: true, reservation });
        } catch (error) {
            respondError(error, res, next);
        }
    });
    function actionRoute(name, authorization, call) {
        router.post(`/:id/${name}`, authorization, async (req, res, next) => {
            const id = positiveInteger(req.params.id);
            const hasBody =
                (req.get("content-length") !== undefined &&
                    req.get("content-length") !== "0") ||
                Boolean(req.get("transfer-encoding"));
            if (
                id === null ||
                Object.keys(req.query).length ||
                (hasBody && !req.is("application/json")) ||
                (req.body !== undefined &&
                    (!req.body ||
                        typeof req.body !== "object" ||
                        Array.isArray(req.body) ||
                        Object.keys(req.body).length))
            )
                return res.status(400).json({
                    success: false,
                    message: "Invalid reservation transition input.",
                });
            try {
                const reservation = await run(req.user, async (tx) => {
                    const result = await call(tx, id);
                    if (result?.length !== 1 || result[0]?.p_result_id !== id)
                        throw Error(
                            "Reservation procedure acknowledgement invalid.",
                        );
                    const row = await tx.reservation.findFirst({
                        where: {
                            reservationId: id,
                            ...(req.user.role.roleName ===
                            "System Administrator"
                                ? {}
                                : { requestedBy: req.user.userId }),
                        },
                        select: reservationSelect,
                    });
                    if (!row)
                        throw Error(
                            "Reservation procedure acknowledgement invalid.",
                        );
                    return reservationResponse(row);
                });
                res.json({ success: true, reservation });
            } catch (error) {
                respondError(error, res, next);
            }
        });
    }
    actionRoute(
        "approve",
        reviewers,
        (tx, id) =>
            tx.$queryRaw`CALL im101_private.approve_reservation(${id}::integer, NULL::integer)`,
    );
    actionRoute(
        "reject",
        reviewers,
        (tx, id) =>
            tx.$queryRaw`CALL im101_private.reject_reservation(${id}::integer, NULL::integer)`,
    );
    actionRoute(
        "cancel",
        creators,
        (tx, id) =>
            tx.$queryRaw`CALL im101_private.cancel_reservation(${id}::integer, NULL::integer)`,
    );
    return router;
}
module.exports = { createReservationWrites };
