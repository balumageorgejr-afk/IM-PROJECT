const { Router } = require("express");

const equipmentSelect = {
    equipmentId: true,
    categoryId: true,
    homeFacilityId: true,
    equipmentName: true,
    serialNumber: true,
    totalQuantity: true,
    availableQuantity: true,
    conditionStatus: true,
    createdAt: true,
};
const readRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const maxInteger = 2147483647;

class EquipmentError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function positiveInteger(value, max = maxInteger) {
    return typeof value === "string" &&
        /^[1-9]\d*$/.test(value) &&
        Number.isSafeInteger(Number(value)) &&
        Number(value) <= max
        ? Number(value)
        : null;
}
function quantity(value) {
    return Number.isInteger(value) && value >= 0 && value <= maxInteger;
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
function equipmentData(body, creating) {
    const fields = [
        "categoryId",
        "homeFacilityId",
        "equipmentName",
        "serialNumber",
        "totalQuantity",
        "availableQuantity",
        "conditionStatus",
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
    if (creating || Object.hasOwn(body, "categoryId")) {
        if (
            !Number.isInteger(body.categoryId) ||
            body.categoryId < 1 ||
            body.categoryId > maxInteger
        )
            return null;
        data.categoryId = body.categoryId;
    }
    if (Object.hasOwn(body, "homeFacilityId")) {
        if (
            body.homeFacilityId !== null &&
            (!Number.isInteger(body.homeFacilityId) ||
                body.homeFacilityId < 1 ||
                body.homeFacilityId > maxInteger)
        )
            return null;
        data.homeFacilityId = body.homeFacilityId;
    }
    for (const field of ["totalQuantity", "availableQuantity"]) {
        if (creating || Object.hasOwn(body, field)) {
            if (!quantity(body[field])) return null;
            data[field] = body[field];
        }
    }
    for (const [field, max] of [
        ["equipmentName", 100],
        ["serialNumber", 60],
        ["conditionStatus", 20],
    ]) {
        if (
            (creating && field === "equipmentName") ||
            Object.hasOwn(body, field)
        ) {
            if (field === "serialNumber" && body[field] === null)
                data[field] = null;
            else {
                if (!validText(body[field], max)) return null;
                data[field] = body[field].trim();
            }
        }
    }
    return data;
}

async function inventoryChange(tx, current, data) {
    if (
        !quantity(current.totalQuantity) ||
        !quantity(current.availableQuantity) ||
        current.availableQuantity > current.totalQuantity
    ) {
        throw new EquipmentError(
            409,
            "Stored inventory requires reconciliation before editing.",
        );
    }
    const total = data.totalQuantity ?? current.totalQuantity;
    if (
        Object.hasOwn(data, "availableQuantity") &&
        data.availableQuantity > total
    ) {
        throw new EquipmentError(
            400,
            "Available quantity cannot exceed total quantity.",
        );
    }
    const unavailable = current.totalQuantity - current.availableQuantity;
    const expectedAvailable = total - unavailable;
    if (!quantity(expectedAvailable))
        throw new EquipmentError(
            400,
            "Total quantity cannot be below unavailable stock.",
        );
    if (
        Object.hasOwn(data, "availableQuantity") &&
        data.availableQuantity !== expectedAvailable
    ) {
        throw new EquipmentError(
            409,
            "Availability changes require an inventory workflow; stock edits must preserve unavailable quantity.",
        );
    }
    if (total === current.totalQuantity) return;
    // Any history blocks stock edits: do not guess which loan/reservation/status
    // means active, returned, cancelled, or reserved before those workflows exist.
    for (const [model, id] of [
        ["loanItem", "equipmentId"],
        ["reservationEquipment", "equipmentId"],
        ["maintenanceRequest", "requestId"],
    ]) {
        if (
            await tx[model].findFirst({
                where: { equipmentId: current.equipmentId },
                select: { [id]: true },
            })
        ) {
            throw new EquipmentError(
                409,
                "Referenced equipment stock cannot be changed through CRUD.",
            );
        }
    }
    // Derive the other half of a stock adjustment from this transaction's snapshot.
    data.availableQuantity = expectedAvailable;
}

function createEquipment({ getPrisma, requireRoles }) {
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
            message: "Invalid equipment input, filter or pagination.",
        });
    const missing = (res) =>
        res
            .status(404)
            .json({ success: false, message: "Equipment not found." });
    const id = (req, res, next) => {
        req.equipmentId = positiveInteger(req.params.id);
        if (req.equipmentId === null) return invalid(res);
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
            (page - 1) * limit > maxInteger ||
            Object.keys(req.query).some(
                (key) =>
                    ![
                        "page",
                        "limit",
                        "categoryId",
                        "homeFacilityId",
                        "conditionStatus",
                    ].includes(key),
            )
        )
            return invalid(res);
        for (const field of ["categoryId", "homeFacilityId"]) {
            if (req.query[field] !== undefined) {
                const value =
                    field === "homeFacilityId" && req.query[field] === "null"
                        ? null
                        : positiveInteger(req.query[field]);
                if (
                    value === null &&
                    !(field === "homeFacilityId" && req.query[field] === "null")
                )
                    return invalid(res);
                where[field] = value;
            }
        }
        if (req.query.conditionStatus !== undefined) {
            if (!validText(req.query.conditionStatus, 20)) return invalid(res);
            where.conditionStatus = req.query.conditionStatus.trim();
        }
        const rows = await getPrisma().equipment.findMany({
            where,
            select: equipmentSelect,
            orderBy: { equipmentId: "asc" },
            skip: (page - 1) * limit,
            take: limit + 1,
        });
        res.json({
            success: true,
            equipment: rows.slice(0, limit),
            pagination: { page, limit, hasMore: rows.length > limit },
        });
    });
    router.get("/:id", readers, id, async (req, res) => {
        const equipment = await getPrisma().equipment.findUnique({
            where: { equipmentId: req.equipmentId },
            select: equipmentSelect,
        });
        if (!equipment) return missing(res);
        res.json({ success: true, equipment });
    });

    function write(method) {
        return async (req, res, next) => {
            const data =
                method === "delete"
                    ? undefined
                    : equipmentData(req.body, method === "create");
            if (method !== "delete" && !data) return invalid(res);
            if (
                method === "create" &&
                data.availableQuantity !== data.totalQuantity
            ) {
                return res.status(400).json({
                    success: false,
                    message: "New equipment stock must start fully available.",
                });
            }
            try {
                const equipment = await getPrisma().$transaction(
                    async (tx) => {
                        const current =
                            method === "create"
                                ? null
                                : await tx.equipment.findUnique({
                                      where: { equipmentId: req.equipmentId },
                                      select: equipmentSelect,
                                  });
                        if (method !== "create" && !current)
                            throw new EquipmentError(
                                404,
                                "Equipment not found.",
                            );
                        if (method === "delete") {
                            if (
                                !quantity(current.totalQuantity) ||
                                current.availableQuantity !==
                                    current.totalQuantity
                            ) {
                                throw new EquipmentError(
                                    409,
                                    "Unavailable or inconsistent stock must be reconciled before deletion.",
                                );
                            }
                            // NO ACTION foreign keys remain the authority for all
                            // dependent deletes, including references inserted late.
                            return tx.equipment.delete({
                                where: { equipmentId: req.equipmentId },
                                select: equipmentSelect,
                            });
                        }
                        if (current) await inventoryChange(tx, current, data);
                        const result = { ...current, ...data };
                        const category = await tx.equipmentCategory.findUnique({
                            where: { categoryId: result.categoryId },
                            select: { categoryId: true },
                        });
                        if (!category)
                            throw new EquipmentError(
                                400,
                                "The referenced equipment category does not exist.",
                            );
                        if (
                            result.homeFacilityId !== null &&
                            result.homeFacilityId !== undefined
                        ) {
                            const facility = await tx.facility.findUnique({
                                where: { facilityId: result.homeFacilityId },
                                select: { facilityId: true },
                            });
                            if (!facility)
                                throw new EquipmentError(
                                    400,
                                    "The referenced home facility does not exist.",
                                );
                        }
                        return tx.equipment[method]({
                            ...(method === "update"
                                ? { where: { equipmentId: req.equipmentId } }
                                : {}),
                            data,
                            select: equipmentSelect,
                        });
                    },
                    {
                        isolationLevel: "Serializable",
                        maxWait: 10000,
                        timeout: 15000,
                    },
                );
                res.status(method === "create" ? 201 : 200).json({
                    success: true,
                    equipment,
                });
            } catch (error) {
                if (error instanceof EquipmentError)
                    return res
                        .status(error.status)
                        .json({ success: false, message: error.message });
                if (method !== "delete" && error?.code === "P2002")
                    return res.status(409).json({
                        success: false,
                        message:
                            "Equipment with that serial number already exists.",
                    });
                if (method !== "create" && error?.code === "P2025")
                    return missing(res);
                if (error?.code === "P2003")
                    return res.status(409).json({
                        success: false,
                        message:
                            method === "delete"
                                ? "Equipment has dependent records and cannot be deleted."
                                : "The referenced category or home facility is no longer available.",
                    });
                if (error?.code === "P2034")
                    return res.status(409).json({
                        success: false,
                        message:
                            "Concurrent changes prevented this operation. Reload the equipment before retrying.",
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

module.exports = { createEquipment };
