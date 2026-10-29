const { Router } = require("express");
const c = require("./core-support");
const { scope } = require("./maintenance");
function createCatalog({ getPrisma, requireRoles }) {
    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    for (const [url, model, key, select, order] of [
        [
            "facility-types",
            "facilityType",
            "facilityTypes",
            { facilityTypeId: true, typeName: true },
            "facilityTypeId",
        ],
        [
            "equipment-categories",
            "equipmentCategory",
            "equipmentCategories",
            { categoryId: true, categoryName: true },
            "categoryId",
        ],
    ])
        router.get(
            "/" + url,
            requireRoles(c.roles),
            c.handle(async (req, res) => {
                const p = c.pagination(req.query);
                res.json(
                    c.list(
                        await getPrisma()[model].findMany({
                            select,
                            orderBy: { [order]: "asc" },
                            skip: p.skip,
                            take: p.take,
                        }),
                        p,
                        key,
                    ),
                );
            }),
        );
    router.get(
        "/staff",
        requireRoles([c.roles[0]]),
        c.handle(async (req, res) => {
            const p = c.pagination(req.query);
            res.json(
                c.list(
                    await getPrisma().user.findMany({
                        where: {
                            isActive: true,
                            role: { roleName: c.roles[1] },
                        },
                        select: { userId: true, fname: true, lname: true },
                        orderBy: { userId: "asc" },
                        skip: p.skip,
                        take: p.take,
                    }),
                    p,
                    "staff",
                ),
            );
        }),
    );
    router.get(
        "/overview",
        requireRoles(c.roles),
        c.handle(async (req, res) => {
            c.noQuery(req);
            const prisma = getPrisma();
            const pairs = await Promise.all(
                [
                    ["buildings", "building", {}],
                    ["facilities", "facility", {}],
                    ["equipment", "equipment", {}],
                    [
                        "reservations",
                        "reservation",
                        c.admin(req.user)
                            ? {}
                            : { requestedBy: req.user.userId },
                    ],
                    [
                        "loans",
                        "equipmentLoan",
                        c.reviewer(req.user) ? {} : { userId: req.user.userId },
                    ],
                    ["maintenance", "maintenanceRequest", scope(req.user)],
                    ...(c.reviewer(req.user)
                        ? [
                              [
                                  "assignments",
                                  "facilityStaffAssignment",
                                  c.admin(req.user)
                                      ? {}
                                      : { staffId: req.user.userId },
                              ],
                          ]
                        : []),
                ].map(async ([key, model, where]) => [
                    key,
                    await prisma[model].count({ where }),
                ]),
            );
            res.json({ success: true, overview: Object.fromEntries(pairs) });
        }),
    );
    return router;
}
module.exports = { createCatalog };
