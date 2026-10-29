const { Router } = require("express");
const c = require("./core-support");
const logSelect = {
    logId: true,
    requestId: true,
    staffId: true,
    actionTaken: true,
    loggedAt: true,
};
const select = {
    requestId: true,
    facilityId: true,
    equipmentId: true,
    reportedBy: true,
    assignedStaffId: true,
    description: true,
    priority: true,
    status: true,
    reportedAt: true,
    resolvedAt: true,
};
function scope(user) {
    return c.admin(user)
        ? {}
        : c.reviewer(user)
          ? {
                OR: [
                    { reportedBy: user.userId },
                    { assignedStaffId: user.userId },
                ],
            }
          : { reportedBy: user.userId };
}
const priorities = ["Low", "Normal", "High"];
async function locked(tx, id) {
    await tx.$queryRaw`SELECT request_id FROM public.maintenance_requests WHERE request_id=${id} FOR UPDATE`;
    const request = await tx.maintenanceRequest.findUnique({
        where: { requestId: id },
        select,
    });
    if (!request) c.refuse("C4041");
    return request;
}
function worker(user, request) {
    if (
        !c.admin(user) &&
        (!c.reviewer(user) || request.assignedStaffId !== user.userId)
    )
        c.refuse("C4031");
    if (!["Open", "In Progress"].includes(request.status)) c.refuse("C4091");
}
async function eligible(tx, staffId) {
    if (!c.integer(staffId)) c.refuse();
    if (
        !(
            await tx.$queryRaw`SELECT im101_private.core_staff(${staffId}::integer) AS eligible`
        )[0].eligible
    )
        c.refuse("C4001");
}
function createMaintenance({ getPrisma, requireRoles }) {
    const router = Router(),
        readers = requireRoles(c.roles),
        workers = requireRoles(c.roles.slice(0, 2)),
        run = c.transaction(getPrisma);
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.get(
        "/",
        readers,
        c.handle(async (req, res) => {
            const p = c.pagination(req.query, [
                    "status",
                    "priority",
                    "facilityId",
                    "equipmentId",
                    "assignedStaffId",
                ]),
                where = scope(req.user);
            for (const [key, values] of [
                ["status", ["Open", "In Progress", "Resolved"]],
                ["priority", priorities],
            ])
                if (req.query[key] !== undefined) {
                    if (!values.includes(req.query[key])) c.refuse();
                    where[key] = req.query[key];
                }
            for (const key of ["facilityId", "equipmentId", "assignedStaffId"])
                if (req.query[key] !== undefined)
                    where[key] = c.id(req.query[key]);
            res.json(
                c.list(
                    await getPrisma().maintenanceRequest.findMany({
                        where,
                        select,
                        orderBy: { requestId: "desc" },
                        skip: p.skip,
                        take: p.take,
                    }),
                    p,
                    "maintenanceRequests",
                ),
            );
        }),
    );
    router.get(
        "/:id",
        readers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const request = await getPrisma().maintenanceRequest.findFirst({
                where: { requestId: c.id(req.params.id), ...scope(req.user) },
                select: {
                    ...select,
                    logs: { select: logSelect, orderBy: { logId: "asc" } },
                },
            });
            if (!request) c.refuse("C4041");
            res.json({ success: true, maintenanceRequest: request });
        }),
    );
    router.post(
        "/",
        readers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const input = c.body(
                    req.body,
                    ["description"],
                    ["facilityId", "equipmentId", "priority"],
                ),
                description = c.text(input.description, 4000, true);
            const facilityId = input.facilityId ?? null,
                equipmentId = input.equipmentId ?? null;
            if (
                (facilityId === null) === (equipmentId === null) ||
                (facilityId !== null && !c.integer(facilityId)) ||
                (equipmentId !== null && !c.integer(equipmentId)) ||
                (input.priority !== undefined &&
                    !priorities.includes(input.priority))
            )
                c.refuse();
            const request = await run(req.user, async (tx, user) => {
                const target =
                    facilityId !== null
                        ? await tx.facility.findUnique({
                              where: { facilityId },
                              select: { facilityId: true },
                          })
                        : await tx.equipment.findUnique({
                              where: { equipmentId },
                              select: { equipmentId: true },
                          });
                if (!target) c.refuse("C4041");
                return tx.maintenanceRequest.create({
                    data: {
                        facilityId,
                        equipmentId,
                        reportedBy: user.userId,
                        description,
                        ...(input.priority ? { priority: input.priority } : {}),
                    },
                    select,
                });
            });
            res.status(201).json({
                success: true,
                maintenanceRequest: request,
            });
        }),
    );
    router.post(
        "/:id/assign",
        workers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const id = c.id(req.params.id),
                input = c.body(req.body, ["staffId"]);
            if (!c.integer(input.staffId)) c.refuse();
            const request = await run(req.user, async (tx, user) => {
                const current = await locked(tx, id);
                if (current.status === "Resolved") c.refuse("C4091");
                if (
                    !c.admin(user) &&
                    (!c.reviewer(user) ||
                        input.staffId !== user.userId ||
                        current.assignedStaffId !== null)
                )
                    c.refuse("C4031");
                if (current.assignedStaffId === input.staffId)
                    c.refuse("C4091");
                await eligible(tx, input.staffId);
                const result = await tx.maintenanceRequest.update({
                    where: { requestId: id },
                    data: { assignedStaffId: input.staffId },
                    select,
                });
                await tx.maintenanceLog.create({
                    data: {
                        requestId: id,
                        staffId: user.userId,
                        actionTaken: "Assigned maintenance work.",
                    },
                    select: logSelect,
                });
                return result;
            });
            res.json({ success: true, maintenanceRequest: request });
        }),
    );
    router.post(
        "/:id/progress",
        workers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const id = c.id(req.params.id),
                input = c.body(
                    req.body,
                    ["status", "actionTaken"],
                    ["priority"],
                ),
                actionTaken = c.text(input.actionTaken, 2000, true);
            if (
                !["In Progress", "Resolved"].includes(input.status) ||
                (input.priority !== undefined &&
                    !priorities.includes(input.priority))
            )
                c.refuse();
            const request = await run(req.user, async (tx, user) => {
                const current = await locked(tx, id);
                worker(user, current);
                if (!(
                    (current.status === "Open" &&
                        input.status === "In Progress") ||
                    (current.status === "In Progress" &&
                        input.status === "Resolved")
                ))
                    c.refuse("C4091");
                const result = await tx.maintenanceRequest.update({
                    where: { requestId: id },
                    data: {
                        status: input.status,
                        ...(input.priority ? { priority: input.priority } : {}),
                        ...(input.status === "Resolved"
                            ? { resolvedAt: await c.now(tx) }
                            : {}),
                    },
                    select,
                });
                await tx.maintenanceLog.create({
                    data: { requestId: id, staffId: user.userId, actionTaken },
                    select: logSelect,
                });
                return result;
            });
            res.json({ success: true, maintenanceRequest: request });
        }),
    );
    router.patch(
        "/:id/priority",
        workers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const id = c.id(req.params.id),
                input = c.body(req.body, ["priority"]);
            if (!priorities.includes(input.priority)) c.refuse();
            const request = await run(req.user, async (tx, user) => {
                const current = await locked(tx, id);
                worker(user, current);
                if (current.priority === input.priority) c.refuse("C4091");
                const result = await tx.maintenanceRequest.update({
                    where: { requestId: id },
                    data: { priority: input.priority },
                    select,
                });
                await tx.maintenanceLog.create({
                    data: {
                        requestId: id,
                        staffId: user.userId,
                        actionTaken: "Updated maintenance priority.",
                    },
                    select: logSelect,
                });
                return result;
            });
            res.json({ success: true, maintenanceRequest: request });
        }),
    );
    router.post(
        "/:id/logs",
        workers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const id = c.id(req.params.id),
                input = c.body(req.body, ["actionTaken"]),
                actionTaken = c.text(input.actionTaken, 2000, true);
            const log = await run(req.user, async (tx, user) => {
                const current = await locked(tx, id);
                worker(user, current);
                if (current.status !== "In Progress") c.refuse("C4091");
                return tx.maintenanceLog.create({
                    data: { requestId: id, staffId: user.userId, actionTaken },
                    select: logSelect,
                });
            });
            res.status(201).json({ success: true, maintenanceLog: log });
        }),
    );
    return router;
}
module.exports = { createMaintenance, scope, eligible };
