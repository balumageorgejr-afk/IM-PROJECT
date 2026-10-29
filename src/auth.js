const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("node:crypto");

const issuer = "im101-api";
const audience = "im101-client";
const profileSelect = {
    userId: true,
    fname: true,
    lname: true,
    email: true,
    isActive: true,
    role: { select: { roleId: true, roleName: true } },
};

function profile(user) {
    return {
        userId: user.userId,
        fname: user.fname,
        lname: user.lname,
        email: user.email,
        role: { roleId: user.role.roleId, roleName: user.role.roleName },
    };
}

function createAuth({ getPrisma, jwtSecret }) {
    if (
        typeof jwtSecret !== "string" ||
        Buffer.byteLength(jwtSecret.trim()) < 32
    ) {
        throw new Error(
            "JWT_SECRET must contain at least 32 bytes of random secret material.",
        );
    }
    // A dummy comparison reduces timing differences; stored costs may differ.
    const dummyHash = bcrypt.hashSync(randomBytes(32).toString("hex"), 12);
    const unauthorized = (res) =>
        res
            .status(401)
            .json({ success: false, message: "Authentication required." });

    async function authenticate(req, res, next) {
        const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") || "");
        if (!match) return unauthorized(res);
        let claims;
        try {
            claims = jwt.verify(match[1], jwtSecret, {
                algorithms: ["HS256"],
                issuer,
                audience,
                maxAge: "15m",
            });
            if (
                !Number.isInteger(claims.exp) ||
                typeof claims.sub !== "string" ||
                !/^[1-9]\d*$/.test(claims.sub) ||
                !Number.isSafeInteger(Number(claims.sub)) ||
                Number(claims.sub) > 2147483647
            )
                return unauthorized(res);
        } catch {
            return unauthorized(res);
        }
        try {
            const user = await getPrisma().user.findUnique({
                where: { userId: Number(claims.sub) },
                select: profileSelect,
            });
            if (!user?.isActive) return unauthorized(res);
            req.user = profile(user);
            next();
        } catch (error) {
            next(error);
        }
    }

    function requireRoles(allowedRoles) {
        if (
            !Array.isArray(allowedRoles) ||
            allowedRoles.length === 0 ||
            [...allowedRoles].some(
                (role) =>
                    typeof role !== "string" ||
                    !role.trim() ||
                    role !== role.trim(),
            )
        ) {
            throw new Error("A nonempty list of role names is required.");
        }
        const permitted = new Set(allowedRoles);
        return (req, res, next) =>
            authenticate(req, res, (error) => {
                if (error) return next(error);
                if (!permitted.has(req.user.role.roleName)) {
                    return res.status(403).json({
                        success: false,
                        message: "Access denied.",
                    });
                }
                next();
            });
    }

    const router = Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        next();
    });
    router.post("/login", async (req, res) => {
        const { email, password } = req.body || {};
        if (
            typeof email !== "string" ||
            !email.trim() ||
            email.trim().length > 150 ||
            typeof password !== "string" ||
            !password ||
            Buffer.byteLength(password) > 72
        )
            return res.status(400).json({
                success: false,
                message: "Valid email and password are required.",
            });

        const user = await getPrisma().user.findUnique({
            where: { email: email.trim() },
            select: { ...profileSelect, passwordHash: true },
        });
        const supported =
            /^\$2[ab]\$(0[4-9]|[12]\d|30|31)\$[./A-Za-z0-9]{53}$/.test(
                user?.passwordHash || "",
            );
        const valid = await bcrypt.compare(
            password,
            supported ? user.passwordHash : dummyHash,
        );
        if (!valid || !supported || !user?.isActive) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password.",
            });
        }
        const token = jwt.sign({}, jwtSecret, {
            algorithm: "HS256",
            subject: String(user.userId),
            issuer,
            audience,
            expiresIn: "15m",
        });
        res.json({
            success: true,
            token,
            tokenType: "Bearer",
            expiresIn: 900,
            user: profile(user),
        });
    });
    router.get("/me", authenticate, (req, res) =>
        res.json({ success: true, user: req.user }),
    );
    return { router, authenticate, requireRoles };
}

module.exports = { createAuth };
