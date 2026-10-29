const { Router } = require("express");

const buildingSelect = {
    buildingId: true,
    buildingName: true,
    floorCount: true,
    locationNote: true,
};
const readRoles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];

class BuildingFloorConflict extends Error {}

function positiveInteger(value, max) {
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
        [...value.trim()].length <= max &&
        ![...value].some((character) => {
            const code = character.codePointAt(0);
            return code < 32 || (code >= 127 && code <= 159);
        })
    );
}

function buildingData(body, creating) {
    if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length === 0 ||
        Object.keys(body).some(
            (key) =>
                !["buildingName", "floorCount", "locationNote"].includes(key),
        )
    )
        return null;
    const data = {};
    if (creating || Object.hasOwn(body, "buildingName")) {
        if (!validText(body.buildingName, 100) || !body.buildingName.trim())
            return null;
        data.buildingName = body.buildingName.trim();
    }
    if (creating || Object.hasOwn(body, "floorCount")) {
        if (
            !Number.isInteger(body.floorCount) ||
            body.floorCount < 1 ||
            body.floorCount > 32767
        )
            return null;
        data.floorCount = body.floorCount;
    }
    if (Object.hasOwn(body, "locationNote")) {
        if (body.locationNote !== null && !validText(body.locationNote, 150))
            return null;
        data.locationNote =
            body.locationNote === null ? null : body.locationNote.trim();
    }
    return data;
}

function createBuildings({ getPrisma, requireRoles }) {
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
            message: "Invalid building input or pagination.",
        });
    const missing = (res) =>
        res
            .status(404)
            .json({ success: false, message: "Building not found." });
    const id = (req, res, next) => {
        req.buildingId = positiveInteger(req.params.id, 2147483647);
        if (req.buildingId === null) return invalid(res);
        next();
    };

    router.get("/", readers, async (req, res) => {
        const page =
            req.query.page === undefined
                ? 1
                : positiveInteger(req.query.page, 2147483647);
        const limit =
            req.query.limit === undefined
                ? 20
                : positiveInteger(req.query.limit, 100);
        if (
            page === null ||
            limit === null ||
            Object.keys(req.query).some(
                (key) => !["page", "limit"].includes(key),
            ) ||
            (page - 1) * limit > 2147483647
        )
            return invalid(res);
        const rows = await getPrisma().building.findMany({
            select: buildingSelect,
            orderBy: { buildingId: "asc" },
            skip: (page - 1) * limit,
            take: limit + 1,
        });
        res.json({
            success: true,
            buildings: rows.slice(0, limit),
            pagination: { page, limit, hasMore: rows.length > limit },
        });
    });
    router.get("/:id", readers, id, async (req, res) => {
        const building = await getPrisma().building.findUnique({
            where: { buildingId: req.buildingId },
            select: buildingSelect,
        });
        if (!building) return missing(res);
        res.json({ success: true, building });
    });

    function write(method) {
        return async (req, res, next) => {
            const data =
                method === "delete"
                    ? undefined
                    : buildingData(req.body, method === "create");
            if (method !== "delete" && !data) return invalid(res);
            try {
                const prisma = getPrisma();
                const query = {
                    ...(method === "create"
                        ? {}
                        : { where: { buildingId: req.buildingId } }),
                    ...(data ? { data } : {}),
                    select: buildingSelect,
                };
                const building =
                    method === "update" && Object.hasOwn(data, "floorCount")
                        ? await prisma.$transaction(
                              async (tx) => {
                                  // Pair this predicate read + building write with the
                                  // Serializable building read + write in Facilities.
                                  // Both paths must keep this isolation to prevent write skew.
                                  const outside = await tx.facility.findFirst({
                                      where: {
                                          buildingId: req.buildingId,
                                          floorNumber: { gt: data.floorCount },
                                      },
                                      select: { facilityId: true },
                                  });
                                  if (outside)
                                      throw new BuildingFloorConflict();
                                  return tx.building.update(query);
                              },
                              {
                                  isolationLevel: "Serializable",
                                  maxWait: 10000,
                                  timeout: 15000,
                              },
                          )
                        : await prisma.building[method](query);
                res.status(method === "create" ? 201 : 200).json({
                    success: true,
                    building,
                });
            } catch (error) {
                if (error instanceof BuildingFloorConflict) {
                    return res.status(409).json({
                        success: false,
                        message:
                            "Floor count cannot be below an existing facility's floor number.",
                    });
                }
                if (error?.code === "P2034") {
                    return res.status(409).json({
                        success: false,
                        message:
                            "Concurrent changes prevented this operation. Reload the building before retrying.",
                    });
                }
                if (method !== "delete" && error?.code === "P2002") {
                    return res.status(409).json({
                        success: false,
                        message: "A building with that name already exists.",
                    });
                }
                if (method !== "create" && error?.code === "P2025")
                    return missing(res);
                if (method === "delete" && error?.code === "P2003") {
                    return res.status(409).json({
                        success: false,
                        message:
                            "Building has dependent facilities and cannot be deleted.",
                    });
                }
                next(error);
            }
        };
    }
    router.post("/", writers, write("create"));
    router.put("/:id", writers, id, write("update"));
    // The approved NO ACTION foreign key enforces this atomically, including
    // concurrent facility inserts. Never delete facilities or use nested deletes.
    router.delete("/:id", writers, id, write("delete"));
    return router;
}

module.exports = { createBuildings };
