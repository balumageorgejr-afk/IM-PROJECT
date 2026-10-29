require("dotenv").config({ quiet: true });

let prisma;

function getPrisma() {
    if (!prisma) {
        // Mocked routes and health checks do not need a generated client.
        const { PrismaClient } = require("@prisma/client");
        const { PrismaPg } = require("@prisma/adapter-pg");
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString || !connectionString.trim()) {
            throw new Error("DATABASE_URL is required.");
        }
        // adapter-pg 7.10.1 normalizes timestamptz offsets assuming server UTC.
        // Do not let URL-level startup options override the fixed UTC setting.
        let url;
        try {
            url = new URL(connectionString);
        } catch {
            throw new Error("Database connection configuration is invalid.");
        }
        if (url.searchParams.has("options"))
            throw new Error(
                "Database startup options require operator review.",
            );

        // The adapter owns one pool; Prisma disconnects it during cleanup.
        const adapter = new PrismaPg({
            connectionString,
            max: 5,
            connectionTimeoutMillis: 10000,
            query_timeout: 10000,
            options: "-c timezone=UTC",
        });
        prisma = new PrismaClient({ adapter, log: [] });
    }

    return prisma;
}

module.exports = { getPrisma };
