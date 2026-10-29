const express = require("express");

function createApp(options = {}) {
    const app = express();
    const { getPrisma } = require("./db");
    const { createAuth } = require("./auth");
    const { router, requireRoles } = createAuth({
        getPrisma: options.getPrisma || getPrisma,
        jwtSecret:
            options.jwtSecret !== undefined
                ? options.jwtSecret
                : process.env.JWT_SECRET,
    });
    app.use(express.json({ limit: "8kb" }));
    const registration =
        require("./account-registration").createAccountRegistration({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        });
    app.use("/api/auth", registration.publicRouter);
    app.use("/api/accounts", registration.adminRouter);
    app.use("/api/auth", router);
    app.use(
        "/api/reservation-availability",
        require("./reservation-availability").createReservationAvailability({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/buildings",
        require("./buildings").createBuildings({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/facilities",
        require("./facilities").createFacilities({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/equipment",
        require("./equipment").createEquipment({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/reservation-statuses",
        require("./reservation-statuses").createReservationStatuses({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/reservations",
        require("./reservations").createReservations({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/loans",
        require("./loans").createLoans({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/maintenance",
        require("./maintenance").createMaintenance({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api/assignments",
        require("./assignments").createAssignments({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.use(
        "/api",
        require("./catalog").createCatalog({
            getPrisma: options.getPrisma || getPrisma,
            requireRoles,
        }),
    );
    app.get("/api/health", (req, res) => {
        res.json({
            success: true,
            message: "Campus Facility Management API is running.",
        });
    });
    // Build assets only: never expose client sources, environment or repository files.
    app.use(
        express.static(require("node:path").join(__dirname, "../client/dist"), {
            setHeaders(res) {
                res.setHeader("X-Content-Type-Options", "nosniff");
                res.setHeader(
                    "Content-Security-Policy",
                    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
                );
            },
        }),
    );
    app.use((error, req, res, next) => {
        res.set("Cache-Control", "no-store");
        const status =
            error.type === "entity.parse.failed"
                ? 400
                : error.type === "entity.too.large"
                  ? 413
                  : error.type === "charset.unsupported" ||
                      error.type === "encoding.unsupported"
                    ? 415
                    : 500;
        res.status(status).json({
            success: false,
            message:
                status === 500
                    ? "Internal server error."
                    : "Invalid request body.",
        });
    });
    return app;
}

module.exports = { createApp };
