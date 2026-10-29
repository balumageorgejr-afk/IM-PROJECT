const { Router } = require("express");
const c = require("./core-support");
const itemSelect = {
    loanId: true,
    equipmentId: true,
    quantity: true,
    conditionOut: true,
    conditionIn: true,
};
const loanSelect = {
    loanId: true,
    userId: true,
    approvedBy: true,
    requestedAt: true,
    dueDate: true,
    returnDate: true,
    loanStatus: true,
    items: { select: itemSelect, orderBy: { equipmentId: "asc" } },
};
function items(value, returning = false) {
    if (!Array.isArray(value) || !value.length || value.length > 50) c.refuse();
    const seen = new Set();
    return value
        .map((item) => {
            c.body(
                item,
                returning
                    ? ["equipmentId", "conditionIn"]
                    : ["equipmentId", "quantity"],
            );
            if (!c.integer(item.equipmentId) || seen.has(item.equipmentId))
                c.refuse();
            seen.add(item.equipmentId);
            if (returning) {
                if (!["Good", "Damaged"].includes(item.conditionIn)) c.refuse();
                return {
                    equipmentId: item.equipmentId,
                    conditionIn: item.conditionIn,
                };
            }
            if (!c.integer(item.quantity)) c.refuse();
            return { equipmentId: item.equipmentId, quantity: item.quantity };
        })
        .sort((a, b) => a.equipmentId - b.equipmentId);
}
function createLoans({ getPrisma, requireRoles }) {
    const router = Router(),
        readers = requireRoles(c.roles),
        reviewers = requireRoles(c.roles.slice(0, 2)),
        run = c.transaction(getPrisma);
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    const scope = (user) => (c.reviewer(user) ? {} : { userId: user.userId });
    router.get(
        "/",
        readers,
        c.handle(async (req, res) => {
            const p = c.pagination(req.query, ["status"]),
                where = scope(req.user);
            if (req.query.status !== undefined) {
                if (
                    !["Pending", "Approved", "Rejected", "Returned"].includes(
                        req.query.status,
                    )
                )
                    c.refuse();
                where.loanStatus = req.query.status;
            }
            const rows = await getPrisma().equipmentLoan.findMany({
                where,
                select: loanSelect,
                orderBy: { loanId: "desc" },
                skip: p.skip,
                take: p.take,
            });
            res.json(c.list(rows, p, "loans"));
        }),
    );
    router.get(
        "/:id",
        readers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const loan = await getPrisma().equipmentLoan.findFirst({
                where: { loanId: c.id(req.params.id), ...scope(req.user) },
                select: loanSelect,
            });
            if (!loan) c.refuse("C4041");
            res.json({ success: true, loan });
        }),
    );
    router.post(
        "/",
        readers,
        c.handle(async (req, res) => {
            c.noQuery(req);
            const input = c.body(req.body, ["dueDate", "items"]),
                dueDate = c.timestamp(input.dueDate),
                entries = items(input.items);
            const loan = await run(req.user, async (tx, user) => {
                const current = await c.now(tx);
                if (dueDate <= current || dueDate - current > 90 * 86400000)
                    c.refuse();
                for (const item of entries) {
                    const equipment = await tx.equipment.findUnique({
                        where: { equipmentId: item.equipmentId },
                        select: {
                            equipmentId: true,
                            conditionStatus: true,
                            totalQuantity: true,
                        },
                    });
                    if (!equipment) c.refuse("C4041");
                    if (
                        equipment.conditionStatus !== "Good" ||
                        item.quantity > equipment.totalQuantity
                    )
                        c.refuse("C4091");
                }
                return tx.equipmentLoan.create({
                    data: {
                        userId: user.userId,
                        dueDate,
                        items: { create: entries },
                    },
                    select: loanSelect,
                });
            });
            res.status(201).json({ success: true, loan });
        }),
    );
    for (const [action, state] of [
        ["approve", "Approved"],
        ["reject", "Rejected"],
        ["return", "Returned"],
    ]) {
        router.post(
            `/:id/${action}`,
            reviewers,
            c.handle(async (req, res) => {
                c.noQuery(req);
                const loanId = c.id(req.params.id);
                const input = c.body(
                    req.body ?? {},
                    action === "return" ? ["items"] : [],
                );
                const returned =
                    action === "return" ? items(input.items, true) : null;
                const loan = await run(req.user, async (tx, user) => {
                    if (!c.reviewer(user)) c.refuse("C4031");
                    await tx.$queryRaw`SELECT loan_id FROM public.equipment_loans WHERE loan_id=${loanId} FOR UPDATE`;
                    const current = await tx.equipmentLoan.findUnique({
                        where: { loanId },
                        select: loanSelect,
                    });
                    if (!current) c.refuse("C4041");
                    if (current.userId === user.userId) c.refuse("C4031");
                    if (
                        current.loanStatus !==
                        (action === "return" ? "Approved" : "Pending")
                    )
                        c.refuse("C4091");
                    if (returned) {
                        if (
                            returned.length !== current.items.length ||
                            returned.some(
                                (item, i) =>
                                    item.equipmentId !==
                                    current.items[i].equipmentId,
                            )
                        )
                            c.refuse();
                        for (const item of returned)
                            await tx.loanItem.update({
                                where: {
                                    loanId_equipmentId: {
                                        loanId,
                                        equipmentId: item.equipmentId,
                                    },
                                },
                                data: { conditionIn: item.conditionIn },
                            });
                    }
                    // The additive database trigger performs inventory changes atomically.
                    return tx.equipmentLoan.update({
                        where: { loanId },
                        data: {
                            loanStatus: state,
                            ...(action === "approve"
                                ? { approvedBy: user.userId }
                                : {}),
                        },
                        select: loanSelect,
                    });
                });
                res.json({ success: true, loan });
            }),
        );
    }
    return router;
}
module.exports = { createLoans, items, loanSelect };
