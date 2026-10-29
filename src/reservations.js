const { Router } = require("express");

const reservationSelect = {
    reservationId: true,
    facilityId: true,
    requestedBy: true,
    approvedBy: true,
    statusId: true,
    purpose: true,
    startDatetime: true,
    endDatetime: true,
    createdAt: true,
};
const readRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];

function positiveInteger(value, max = 2147483647) {
    return typeof value === "string" &&
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) <= max
        ? Number(value)
        : null;
}

function ownershipScope(user) {
    return user.role.roleName === "System Administrator"
        ? {}
        : { requestedBy: user.userId };
}

function reservationResponse(row) {
    return Object.fromEntries(
        Object.keys(reservationSelect).map((field) => [field, row[field]]),
    );
}

function createReservations({ getPrisma, requireRoles }) {
    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    const readers = requireRoles(readRoles);
    const invalid = (res) =>
        res.status(400).json({
            success: false,
            message: "Invalid reservation input or pagination.",
        });

    router.get("/", readers, async (req, res) => {
        const page =
            req.query.page === undefined ? 1 : positiveInteger(req.query.page);
        const limit =
            req.query.limit === undefined
                ? 20
                : positiveInteger(req.query.limit, 100);
        if (
            page === null ||
            limit === null ||
            (page - 1) * limit > 2147483647 ||
            Object.keys(req.query).some(
                (key) => !["page", "limit"].includes(key),
            )
        )
            return invalid(res);
        const rows = await getPrisma().reservation.findMany({
            where: ownershipScope(req.user),
            select: reservationSelect,
            orderBy: { reservationId: "asc" },
            skip: (page - 1) * limit,
            take: limit + 1,
        });
        res.json({
            success: true,
            reservations: rows.slice(0, limit).map(reservationResponse),
            pagination: { page, limit, hasMore: rows.length > limit },
        });
    });
    router.get("/:id", readers, async (req, res) => {
        const reservationId = positiveInteger(req.params.id);
        if (reservationId === null || Object.keys(req.query).length)
            return invalid(res);
        const reservation = await getPrisma().reservation.findFirst({
            where: { reservationId, ...ownershipScope(req.user) },
            select: reservationSelect,
        });
        if (!reservation)
            return res
                .status(404)
                .json({ success: false, message: "Reservation not found." });
        res.json({
            success: true,
            reservation: reservationResponse(reservation),
        });
    });
    router.use(
        require("./reservation-writes").createReservationWrites({
            getPrisma,
            requireRoles,
            readRoles,
            reservationSelect,
            reservationResponse,
            positiveInteger,
        }),
    );
    return router;
}

module.exports = { createReservations };
