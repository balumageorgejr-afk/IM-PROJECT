const { Router } = require("express");
const { reservationErrorCode } = require("./reservation-errors");

const facilitySelect = {
    facilityId: true,
    buildingId: true,
    facilityTypeId: true,
    facilityName: true,
    floorNumber: true,
    capacity: true,
    status: true,
    createdAt: true,
};
const readRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];

class FacilityError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function positiveInteger(value, max = 2147483647) {
    return typeof value === "string" &&
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) <= max
        ? Number(value)
        : null;
}

function validText(value, max) {
    return (
        typeof value === "string" &&
        value.isWellFormed() &&
        value.trim() &&
        [...value.trim()].length <= max &&
        ![...value].some((character) => {
            const code = character.codePointAt(0);
            return code < 32 || (code >= 127 && code <= 159);
        })
    );
}

function facilityData(body, creating) {
    const fields = [
        "buildingId",
        "facilityTypeId",
        "facilityName",
        "floorNumber",
        "capacity",
        "status",
    ];
    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some((key) => !fields.includes(key))
    )
        return null;
    const data = {};
    for (const [field, max] of [
        ["buildingId", 2147483647],
        ["facilityTypeId", 2147483647],
        ["floorNumber", 32767],
        ["capacity", 2147483647],
    ]) {
        if (creating || Object.hasOwn(body, field)) {
            if (
                !Number.isInteger(body[field]) ||
                body[field] < 1 ||
                body[field] > max
            )
                return null;
            data[field] = body[field];
        }
    }
    if (creating || Object.hasOwn(body, "facilityName")) {
        if (!validText(body.facilityName, 100)) return null;
        data.facilityName = body.facilityName.trim();
    }
    if (Object.hasOwn(body, "status")) {
        if (!validText(body.status, 20)) return null;
        data.status = body.status.trim();
    }
    // Leave omitted status and createdAt to the approved database defaults.
    return data;
}

function createFacilities({ getPrisma, requireRoles }) {
    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    const readers = requireRoles(readRoles);
    const writers = requireRoles(["System Administrator"]);
    const invalid = (res) =>
        res.status(400).json({
            success: false,
            message: "Invalid facility input, filter or pagination.",
        });
    const missing = (res) =>
        res
            .status(404)
            .json({ success: false, message: "Facility not found." });
    const id = (req, res, next) => {
        req.facilityId = positiveInteger(req.params.id);
        if (req.facilityId === null) return invalid(res);
        next();
    };

    router.get("/", readers, async (req, res) => {
        const page =
            req.query.page === undefined ? 1 : positiveInteger(req.query.page);
        const limit =
            req.query.limit === undefined
                ? 20
                : positiveInteger(req.query.limit, 100);
        const where = {};
        if (
            page === null ||
            limit === null ||
            (page - 1) * limit > 2147483647 ||
            Object.keys(req.query).some(
                (key) =>
                    !["page", "limit", "buildingId", "facilityTypeId"].includes(
                        key,
                    ),
            )
        )
            return invalid(res);
        for (const field of ["buildingId", "facilityTypeId"]) {
            if (req.query[field] !== undefined) {
                const value = positiveInteger(req.query[field]);
                if (value === null) return invalid(res);
                where[field] = value;
            }
        }
        const rows = await getPrisma().facility.findMany({
            where,
            select: facilitySelect,
            orderBy: { facilityId: "asc" },
            skip: (page - 1) * limit,
            take: limit + 1,
        });
        res.json({
            success: true,
            facilities: rows.slice(0, limit),
            pagination: { page, limit, hasMore: rows.length > limit },
        });
    });
    router.get("/:id", readers, id, async (req, res) => {
        const facility = await getPrisma().facility.findUnique({
            where: { facilityId: req.facilityId },
            select: facilitySelect,
        });
        if (!facility) return missing(res);
        res.json({ success: true, facility });
    });

    function write(method) {
        return async (req, res, next) => {
            const data =
                method === "delete"
                    ? undefined
                    : facilityData(req.body, method === "create");
            if (method !== "delete" && !data) return invalid(res);
            try {
                const prisma = getPrisma();
                let facility;
                if (method === "delete") {
                    // A single delete lets all approved NO ACTION foreign keys
                    // protect dependent records, including concurrent inserts.
                    facility = await prisma.facility.delete({
                        where: { facilityId: req.facilityId },
                        select: facilitySelect,
                    });
                } else {
                    facility = await prisma.$transaction(
                        async (tx) => {
                            // Buildings floor-count edits use the same isolation
                            // and check facilities. Keep both paths Serializable.
                            const current =
                                method === "update"
                                    ? await tx.facility.findUnique({
                                          where: { facilityId: req.facilityId },
                                          select: facilitySelect,
                                      })
                                    : null;
                            if (method === "update" && !current)
                                throw new FacilityError(
                                    404,
                                    "Facility not found.",
                                );
                            const result = { ...current, ...data };
                            const building = await tx.building.findUnique({
                                where: { buildingId: result.buildingId },
                                select: { buildingId: true, floorCount: true },
                            });
                            if (!building)
                                throw new FacilityError(
                                    400,
                                    "The referenced building does not exist.",
                                );
                            const type = await tx.facilityType.findUnique({
                                where: {
                                    facilityTypeId: result.facilityTypeId,
                                },
                                select: { facilityTypeId: true },
                            });
                            if (!type)
                                throw new FacilityError(
                                    400,
                                    "The referenced facility type does not exist.",
                                );
                            if (
                                result.floorNumber < 1 ||
                                result.floorNumber > building.floorCount
                            ) {
                                throw new FacilityError(
                                    400,
                                    "Floor number must be within the selected building's floor count.",
                                );
                            }
                            return tx.facility[method]({
                                ...(method === "update"
                                    ? { where: { facilityId: req.facilityId } }
                                    : {}),
                                data,
                                select: facilitySelect,
                            });
                        },
                        {
                            isolationLevel: "Serializable",
                            maxWait: 10000,
                            timeout: 15000,
                        },
                    );
                }
                res.status(method === "create" ? 201 : 200).json({
                    success: true,
                    facility,
                });
            } catch (error) {
                if (error instanceof FacilityError)
                    return res
                        .status(error.status)
                        .json({ success: false, message: error.message });
                if (method !== "delete" && error?.code === "P2002")
                    return res.status(409).json({
                        success: false,
                        message:
                            "A facility with that name already exists on this floor in the building.",
                    });
                if (method !== "create" && error?.code === "P2025")
                    return missing(res);
                if (error?.code === "P2003")
                    return res.status(409).json({
                        success: false,
                        message:
                            method === "delete"
                                ? "Facility has dependent records and cannot be deleted."
                                : "The referenced building or facility type is no longer available.",
                    });
                if (error?.code === "P2034")
                    return res.status(409).json({
                        success: false,
                        message:
                            "Concurrent changes prevented this operation. Reload the facility before retrying.",
                    });
                const reservationCode = reservationErrorCode(error);
                if (reservationCode === "RESERVATION_CONFLICT")
                    return res.status(409).json({
                        success: false,
                        message:
                            "Facility has active or future Approved reservations, or a concurrent change prevented closure. Reload before retrying.",
                    });
                if (reservationCode === "RESERVATION_CONFIGURATION")
                    return res.status(503).json({
                        success: false,
                        message: "Reservation configuration unavailable.",
                    });
                next(error);
            }
        };
    }
    router.post("/", writers, write("create"));
    router.put("/:id", writers, id, write("update"));
    router.delete("/:id", writers, id, write("delete"));
    return router;
}

module.exports = { createFacilities };
