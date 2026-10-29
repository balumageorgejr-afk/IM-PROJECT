const { Router } = require("express");
const bcrypt = require("bcryptjs");

const representative = "Faculty / Student Organization Representative";
const staff = "Facility/Maintenance Staff";
const administrator = "System Administrator";
const fields = ["fname", "lname", "email", "password", "passwordConfirmation"];
const userSelect = {
    userId: true,
    fname: true,
    lname: true,
    email: true,
    role: { select: { roleId: true, roleName: true } },
};

function validateAccount(payload) {
    const errors = [];
    const invalid = (field, code) => errors.push({ field, code });
    let data;
    try {
        if (
            !payload ||
            Array.isArray(payload) ||
            typeof payload !== "object" ||
            Object.getPrototypeOf(payload) !== Object.prototype
        )
            throw new Error();
        const descriptors = Object.getOwnPropertyDescriptors(payload);
        if (
            Reflect.ownKeys(descriptors).some(
                (key) =>
                    !fields.includes(key) ||
                    !Object.hasOwn(descriptors[key], "value"),
            )
        ) {
            invalid("body", "UNEXPECTED_FIELDS");
        }
        data = Object.fromEntries(
            fields.map((field) => [field, descriptors[field]?.value]),
        );
        for (const field of ["fname", "lname"]) {
            if (
                typeof data[field] !== "string" ||
                !data[field].isWellFormed() ||
                !data[field].trim() ||
                [...data[field].trim()].length > 60 ||
                /[\p{Cc}\p{Cf}]/u.test(data[field])
            )
                invalid(field, "INVALID_NAME");
            else data[field] = data[field].trim();
        }
        if (
            typeof data.email !== "string" ||
            data.email.length > 150 ||
            !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
                data.email.trim(),
            ) ||
            data.email.trim().startsWith(".") ||
            data.email.trim().split("@")[0].endsWith(".") ||
            data.email.trim().split("@")[0].includes("..")
        )
            invalid("email", "INVALID_EMAIL");
        else data.email = data.email.trim().toLowerCase();
        if (
            typeof data.password !== "string" ||
            !data.password.isWellFormed() ||
            [...data.password].length < 15 ||
            Buffer.byteLength(data.password) > 72 ||
            /\p{Cc}/u.test(data.password) ||
            !data.password.trim() ||
            [
                "passwordpassword",
                "123456789012345",
                "1234567890123456",
                "abcdefghijklmnop",
            ].includes(data.password.toLowerCase())
        )
            invalid("password", "PASSWORD_POLICY");
        if (
            typeof data.passwordConfirmation !== "string" ||
            data.password !== data.passwordConfirmation
        )
            invalid("passwordConfirmation", "PASSWORD_MISMATCH");
    } catch {
        return { errors: [{ field: "body", code: "INVALID_PAYLOAD" }] };
    }
    return errors.length ? { errors } : { data };
}

// Bounded, process-local limiter. Never trust client-supplied forwarding headers.
// Distributed limiting is a deployment prerequisite for multiple instances.
function registrationLimiter({
    max = 10,
    windowMs = 60 * 60 * 1000,
    now = Date.now,
} = {}) {
    const buckets = new Map();
    return (req, res, next) => {
        const time = now();
        for (const [key, entry] of buckets)
            if (entry.reset <= time) buckets.delete(key);
        const key = req.user ? `actor:${req.user.userId}` : `address:${req.ip}`;
        let entry = buckets.get(key);
        if (!entry) {
            if (buckets.size >= 5000) return refuse(windowMs);
            entry = { count: 0, reset: time + windowMs };
            buckets.set(key, entry);
        }
        if (entry.count >= max) return refuse(entry.reset - time);
        entry.count++;
        next();
        function refuse(delay) {
            res.set(
                "Retry-After",
                String(Math.max(1, Math.ceil(delay / 1000))),
            );
            return res.status(429).json({
                success: false,
                message: "Too many account creation attempts. Try again later.",
            });
        }
    };
}

function createAccountRegistration({ getPrisma, requireRoles }) {
    const publicRouter = Router(),
        adminRouter = Router();
    for (const router of [publicRouter, adminRouter])
        router.use((req, res, next) => {
            res.set("Cache-Control", "no-store");
            next();
        });
    function create(roleName) {
        return async (req, res) => {
            if (Object.keys(req.query).length)
                return res.status(400).json({
                    success: false,
                    errors: [{ field: "body", code: "UNEXPECTED_FIELDS" }],
                });
            const result = validateAccount(req.body);
            if (result.errors)
                return res
                    .status(400)
                    .json({ success: false, errors: result.errors });
            const { fname, lname, email, password } = result.data;
            try {
                const passwordHash = await bcrypt.hash(password, 12);
                const user = await getPrisma().$transaction(
                    async (tx) => {
                        if (roleName === staff) {
                            const actor = await tx.user.findUnique({
                                where: { userId: req.user.userId },
                                select: {
                                    isActive: true,
                                    role: { select: { roleName: true } },
                                },
                            });
                            if (
                                !actor?.isActive ||
                                actor.role?.roleName !== administrator
                            )
                                throw Object.assign(new Error(), {
                                    accountCode: "FORBIDDEN",
                                });
                        }
                        const role = await tx.role.findUnique({
                            where: { roleName },
                            select: { roleId: true },
                        });
                        if (!Number.isInteger(role?.roleId) || role.roleId <= 0)
                            throw Object.assign(new Error(), {
                                accountCode: "CONFIGURATION",
                            });
                        const existing = await tx.user.findFirst({
                            where: {
                                email: { equals: email, mode: "insensitive" },
                            },
                            select: { userId: true },
                        });
                        if (existing)
                            throw Object.assign(new Error(), {
                                accountCode: "DUPLICATE",
                            });
                        return tx.user.create({
                            data: {
                                fname,
                                lname,
                                email,
                                passwordHash,
                                roleId: role.roleId,
                                isActive: true,
                            },
                            select: userSelect,
                        });
                    },
                    {
                        isolationLevel: "Serializable",
                        maxWait: 10000,
                        timeout: 15000,
                    },
                );
                // Only acknowledge account creation after Prisma confirms COMMIT.
                return res.status(201).json({ success: true, user });
            } catch (error) {
                const status =
                    error.accountCode === "FORBIDDEN"
                        ? 403
                        : error.accountCode === "CONFIGURATION"
                          ? 503
                          : error.accountCode === "DUPLICATE" ||
                              error.code === "P2002" ||
                              error.code === "P2034"
                            ? 409
                            : 500;
                return res.status(status).json({
                    success: false,
                    message:
                        status === 403
                            ? "Access denied."
                            : status === 503
                              ? "Account registration is not configured."
                              : status === 409
                                ? "Account could not be created. Try signing in or contact your administrator."
                                : "Account creation could not be confirmed. Try signing in before submitting again.",
                });
            }
        };
    }
    publicRouter.post(
        "/register",
        registrationLimiter(),
        create(representative),
    );
    adminRouter.post(
        "/staff",
        requireRoles([administrator]),
        registrationLimiter({ max: 20 }),
        create(staff),
    );
    return { publicRouter, adminRouter };
}

module.exports = {
    createAccountRegistration,
    validateAccount,
    registrationLimiter,
};
