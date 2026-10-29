const bcrypt = require("bcryptjs");
const { createInterface } = require("node:readline/promises");

const roles = Object.freeze([
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
]);

class ProvisioningError extends Error {}

function validateInput(env) {
    const input = {};
    for (const [field, key, limit] of [
        ["email", "PROVISION_ADMIN_EMAIL", 150],
        ["fname", "PROVISION_ADMIN_FIRST_NAME", 60],
        ["lname", "PROVISION_ADMIN_LAST_NAME", 60],
    ]) {
        const value = env[key];
        if (
            typeof value !== "string" ||
            !value.isWellFormed() ||
            !value.trim() ||
            value.trim().length > limit ||
            [...value].some(
                (character) =>
                    character.charCodeAt(0) < 32 ||
                    (character.charCodeAt(0) >= 127 &&
                        character.charCodeAt(0) <= 159),
            )
        ) {
            throw new ProvisioningError(`Invalid or missing ${key}.`);
        }
        input[field] = value.trim();
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.email)) {
        throw new ProvisioningError(
            "Invalid or missing PROVISION_ADMIN_EMAIL.",
        );
    }
    const password = env.PROVISION_ADMIN_PASSWORD;
    if (
        typeof password !== "string" ||
        !password.isWellFormed() ||
        [...password].length < 15 ||
        !password.trim() ||
        Buffer.byteLength(password) > 72 ||
        password.includes("\0")
    ) {
        throw new ProvisioningError(
            "PROVISION_ADMIN_PASSWORD must have at least 15 characters and at most 72 UTF-8 bytes.",
        );
    }
    return { ...input, password };
}

async function confirmWrite(phrase) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return "";
    const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    try {
        return await prompt.question(
            `This writes to the configured database. Verify DATABASE_URL targets the intended V2 database. Type ${phrase} to continue: `,
        );
    } finally {
        prompt.close();
    }
}

async function runProvisioning({
    args = process.argv.slice(2),
    env = process.env,
    confirm = confirmWrite,
    getClient = () => require("../src/db").getPrisma(),
} = {}) {
    let prisma;
    let result;
    try {
        if (args.length !== 1 || !["roles", "admin"].includes(args[0])) {
            throw new ProvisioningError(
                "Usage: npm run provision:initial -- roles|admin",
            );
        }
        const mode = args[0];
        if (typeof env.DATABASE_URL !== "string" || !env.DATABASE_URL.trim()) {
            throw new ProvisioningError("DATABASE_URL is required.");
        }
        let url;
        try {
            url = new URL(env.DATABASE_URL);
        } catch {
            throw new ProvisioningError(
                "DATABASE_URL must be a PostgreSQL connection URL.",
            );
        }
        if (!["postgres:", "postgresql:"].includes(url.protocol)) {
            throw new ProvisioningError(
                "DATABASE_URL must be a PostgreSQL connection URL.",
            );
        }
        if (
            env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
            url.searchParams.getAll("sslmode").length !== 1 ||
            url.searchParams.get("sslmode") !== "verify-full"
        ) {
            throw new ProvisioningError(
                "Provisioning requires sslmode=verify-full and enabled TLS certificate verification.",
            );
        }
        const input = mode === "admin" ? validateInput(env) : null;
        const phrase =
            mode === "admin"
                ? "CREATE FIRST ADMINISTRATOR"
                : "INITIALIZE ROLES";
        if ((await confirm(phrase)) !== phrase) {
            throw new ProvisioningError(
                "Provisioning cancelled; no database changes requested.",
            );
        }
        const passwordHash = input
            ? await bcrypt.hash(input.password, 12)
            : null;
        prisma = getClient();
        await prisma.$transaction(
            async (tx) => {
                if (input) {
                    if (
                        await tx.user.findUnique({
                            where: { email: input.email },
                            select: { userId: true },
                        })
                    ) {
                        throw new ProvisioningError(
                            "Email already exists; no account changed.",
                        );
                    }
                    if (
                        await tx.user.findFirst({
                            where: { role: { roleName: roles[0] } },
                            select: { userId: true },
                        })
                    ) {
                        throw new ProvisioningError(
                            "An administrator already exists; initial provisioning refused.",
                        );
                    }
                }
                let adminRole;
                for (const roleName of roles) {
                    const role = await tx.role.upsert({
                        where: { roleName },
                        create: { roleName },
                        update: {},
                        select: { roleId: true },
                    });
                    if (roleName === roles[0]) adminRole = role;
                }
                if (input) {
                    await tx.user.create({
                        data: {
                            email: input.email,
                            fname: input.fname,
                            lname: input.lname,
                            passwordHash,
                            roleId: adminRole.roleId,
                            isActive: true,
                        },
                        select: { userId: true },
                    });
                }
            },
            // Empty-update upserts can require several round trips per role.
            // Allow a bounded window beyond Prisma's default five seconds.
            { isolationLevel: "Serializable", maxWait: 10000, timeout: 30000 },
        );
        result = {
            success: true,
            message: input
                ? "Initial administrator created; approved roles initialized."
                : "Approved roles initialized.",
        };
    } catch (error) {
        const message =
            error instanceof ProvisioningError
                ? error.message
                : error?.code === "P2002"
                  ? "A record already exists; provisioning was not completed."
                  : error?.code === "P2034"
                    ? "Concurrent provisioning conflict; review the database state before retrying."
                    : error?.code === "P1011"
                      ? "TLS verification failed. Configure the trusted CA before starting Node; keep certificate verification enabled."
                      : error?.code === "P2028"
                        ? "Provisioning transaction failed or expired. Verify database state before retrying; no automatic retry was attempted."
                        : ["P2000", "P2021", "P2022"].includes(error?.code)
                          ? "Provisioning schema or column mismatch. Review the approved schema; no automatic changes were attempted."
                          : "Provisioning failed. Check database access and configuration; details withheld.";
        result = { success: false, message };
    } finally {
        if (prisma) {
            try {
                await prisma.$disconnect();
            } catch {
                result = {
                    success: false,
                    message:
                        "Database cleanup failed. Provisioning may have completed; verify the database state before retrying.",
                };
            }
        }
    }
    return result;
}

if (require.main === module) {
    require("dotenv").config({ quiet: true });
    runProvisioning()
        .then((result) => {
            console.log(result.message);
            process.exitCode = result.success ? 0 : 1;
        })
        .catch(() => {
            console.error("Provisioning failed; details withheld.");
            process.exitCode = 1;
        });
}

module.exports = { runProvisioning };
