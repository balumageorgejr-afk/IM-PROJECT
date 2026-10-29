const { Router } = require("express");
const c = require("./core-support");
const { eligible } = require("./maintenance");
const select = {
    assignmentId: true,
    facilityId: true,
    staffId: true,
    assignedRole: true,
    shift: true,
    assignedDate: true,
    unassignedDate: true,
};
const assignedRoles = ["Custodian", "Maintenance Technician"],
    shifts = ["Day", "Evening", "Night", null];
function details(input) {
    const result = {};
    if (Object.hasOwn(input, "assignedRole")) {
        if (!assignedRoles.includes(input.assignedRole)) c.refuse();
        result.assignedRole = input.assignedRole;
    }
    if (Object.hasOwn(input, "shift")) {
        if (!shifts.includes(input.shift)) c.refuse();
        result.shift = input.shift;
    }
    return result;
}
function createAssignments({ getPrisma, requireRoles }) {
    const router = Router(),
        readers = requireRoles(c.roles.slice(0, 2)),
        managers = requireRoles([c.roles[0]]),
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
                    "facilityId",
                    "staffId",
                    "active",
                ]),
                where = c.admin(req.user) ? {} : { staffId: req.user.userId };
            if (req.query.staffId !== undefined) {
                const staffId = c.id(req.query.staffId);
                if (!c.admin(req.user) && staffId !== req.user.userId)
                    c.refuse("C4031");
                where.staffId = staffId;
            }
            if (req.query.facilityId !== undefined)
                where.facilityId = c.id(req.query.facilityId);
            if (req.query.active !== undefined) {
                if (!["true", "false"].includes(req.query.active)) c.refuse();
                where.unassignedDate =
                    req.query.active === "true" ? null : { not: null };
            }
            res.json(
                c.list(
                    await getPrisma().facilityStaffAssignment.findMany({
                        where,
                        select,
                        orderBy: { assignmentId: "desc" },
                        skip: p.skip,
                        take: p.take,
                    }),
                    p,
                    "assignments",
                ),
            );
        }),
    );
    router.get(
        "/:id",
        readers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const assignment =
                await getPrisma().facilityStaffAssignment.findFirst({
                    where: {
                        assignmentId: c.id(req.params.id),
                        ...(c.admin(req.user)
                            ? {}
                            : { staffId: req.user.userId }),
                    },
                    select,
                });
            if (!assignment) c.refuse("C4041");
            res.json({ success: true, assignment });
        }),
    );
    router.post(
        "/",
        managers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const input = c.body(
                req.body,
                ["facilityId", "staffId"],
                ["assignedRole", "shift", "assignedDate"],
            );
            if (!c.integer(input.facilityId) || !c.integer(input.staffId))
                c.refuse();
            const data = {
                facilityId: input.facilityId,
                staffId: input.staffId,
                ...details(input),
                ...(input.assignedDate !== undefined
                    ? { assignedDate: c.day(input.assignedDate) }
                    : {}),
            };
            const assignment = await run(req.user, async (tx, user) => {
                if (!c.admin(user)) c.refuse("C4031");
                await eligible(tx, data.staffId);
                if (
                    !(await tx.facility.findUnique({
                        where: { facilityId: data.facilityId },
                        select: { facilityId: true },
                    }))
                )
                    c.refuse("C4041");
                if (data.assignedDate && data.assignedDate > (await c.now(tx)))
                    c.refuse();
                return tx.facilityStaffAssignment.create({ data, select });
            });
            res.status(201).json({ success: true, assignment });
        }),
    );
    for (const ending of [false, true])
        router[ending ? "post" : "patch"](
            ending ? "/:id/end" : "/:id",
            managers,
            c.handle(async (req, res) => {
                c.noQuery(req);
                const id = c.id(req.params.id),
                    input = c.body(
                        req.body ?? {},
                        [],
                        ending ? ["unassignedDate"] : ["assignedRole", "shift"],
                    );
                if (!ending && !Object.keys(input).length) c.refuse();
                const assignment = await run(req.user, async (tx, user) => {
                    if (!c.admin(user)) c.refuse("C4031");
                    await tx.$queryRaw`SELECT assignment_id FROM public.facility_staff_assignments WHERE assignment_id=${id} FOR UPDATE`;
                    const current = await tx.facilityStaffAssignment.findUnique(
                        { where: { assignmentId: id }, select },
                    );
                    if (!current) c.refuse("C4041");
                    if (current.unassignedDate) c.refuse("C4091");
                    let data = details(input);
                    if (ending) {
                        const today = await c.now(tx),
                            date =
                                input.unassignedDate === undefined
                                    ? c.day(today.toISOString().slice(0, 10))
                                    : c.day(input.unassignedDate);
                        if (date < current.assignedDate || date > today)
                            c.refuse();
                        data = { unassignedDate: date };
                    }
                    return tx.facilityStaffAssignment.update({
                        where: { assignmentId: id },
                        data,
                        select,
                    });
                });
                res.json({ success: true, assignment });
            }),
        );
    return router;
}
module.exports = { createAssignments, details };
