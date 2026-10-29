const { Router } = require("express");
const { validateReservationCreation } = require("./reservation-validation");
const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
function positive(value, max = 2147483647) {
    return typeof value === "string" &&
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) <= max
        ? Number(value)
        : null;
}
function createReservationAvailability({ getPrisma, requireRoles }) {
    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.get("/", requireRoles(roles), async (req, res) => {
        const { from, to, facilityId } = req.query;
        const range = validateReservationCreation({
            facilityId: 1,
            purpose: "Availability range",
            startDatetime: from,
            endDatetime: to,
        });
        const page =
            req.query.page === undefined ? 1 : positive(req.query.page, 100);
        const limit =
            req.query.limit === undefined
                ? 100
                : positive(req.query.limit, 100);
        const facility =
            facilityId === undefined ? undefined : positive(facilityId);
        if (
            !range.success ||
            !page ||
            !limit ||
            facility === null ||
            Date.parse(range.data.endDatetime) -
                Date.parse(range.data.startDatetime) >
                45 * 86400000 ||
            Object.keys(req.query).some(
                (key) =>
                    !["from", "to", "facilityId", "page", "limit"].includes(
                        key,
                    ),
            )
        )
            return res.status(400).json({
                success: false,
                message:
                    "Use a valid availability range of at most 45 days and supported filters.",
            });
        const rows = await getPrisma().reservation.findMany({
            where: {
                ...(facility === undefined ? {} : { facilityId: facility }),
                status: { statusName: { in: ["Pending", "Approved"] } },
                startDatetime: { lt: range.data.endDatetime },
                endDatetime: { gt: range.data.startDatetime },
            },
            select: {
                facilityId: true,
                facility: { select: { facilityName: true } },
                status: { select: { statusName: true } },
                startDatetime: true,
                endDatetime: true,
            },
            orderBy: { reservationId: "asc" },
            skip: (page - 1) * limit,
            take: limit + 1,
        });
        res.json({
            success: true,
            availability: rows.slice(0, limit).map((row) => ({
                facilityId: row.facilityId,
                facilityName: row.facility.facilityName,
                startDatetime: row.startDatetime,
                endDatetime: row.endDatetime,
                status: row.status.statusName,
            })),
            pagination: { page, limit, hasMore: rows.length > limit },
        });
    });
    return router;
}
module.exports = { createReservationAvailability };
