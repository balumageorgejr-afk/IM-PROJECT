const { Router } = require("express");

const statusNames = ["Pending", "Approved", "Rejected", "Cancelled"];
const readRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];

function createReservationStatuses({ getPrisma, requireRoles }) {
    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.get("/", requireRoles(readRoles), async (req, res) => {
        if (Object.keys(req.query).length) {
            return res.status(400).json({
                success: false,
                message: "Invalid reservation status query.",
            });
        }
        const rows = await getPrisma().reservationStatus.findMany({
            where: { statusName: { in: statusNames } },
            select: { statusId: true, statusName: true },
            orderBy: { statusId: "asc" },
        });
        res.json({
            success: true,
            reservationStatuses: rows.map(({ statusId, statusName }) => ({
                statusId,
                statusName,
            })),
        });
    });
    return router;
}

module.exports = { createReservationStatuses };
