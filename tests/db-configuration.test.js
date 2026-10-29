const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
test("database adapter pins UTC startup options and refuses URL overrides without opening a connection", () => {
    for (const [url, accepted] of [
        [
            "postgresql://fixture:synthetic@database.example.test/disposable?sslmode=verify-full",
            true,
        ],
        [
            "postgresql://fixture:synthetic@database.example.test/disposable?options=-c%20timezone%3DAsia%2FManila",
            false,
        ],
        ["malformed", false],
    ]) {
        let constructed = 0;
        const context = vm.createContext({
            module: { exports: {} },
            process: { env: { DATABASE_URL: url } },
            URL,
            require(name) {
                if (name === "dotenv") return { config() {} };
                if (name === "@prisma/client")
                    return {
                        PrismaClient: class {
                            constructor() {
                                constructed++;
                            }
                        },
                    };
                if (name === "@prisma/adapter-pg")
                    return {
                        PrismaPg: class {
                            constructor(config) {
                                assert.equal(config.options, "-c timezone=UTC");
                                assert.equal(config.max, 5);
                                assert.equal(config.query_timeout, 10000);
                            }
                        },
                    };
                throw Error("UNEXPECTED_IMPORT");
            },
        });
        vm.runInContext(fs.readFileSync("src/db.js", "utf8"), context);
        if (accepted) {
            context.module.exports.getPrisma();
            assert.equal(constructed, 1);
        } else {
            assert.throws(
                () => context.module.exports.getPrisma(),
                (error) => !String(error).includes("synthetic"),
            );
            assert.equal(constructed, 0);
        }
    }
});
