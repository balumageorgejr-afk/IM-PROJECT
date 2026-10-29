// Opt-in only. Creates its own cluster; never uses DATABASE_URL or an existing DB.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { Pool } = require("pg");

function validateDisposableConfig(config) {
    if (
        !config ||
        Object.keys(config).some(
            (key) =>
                ![
                    "host",
                    "port",
                    "database",
                    "user",
                    "password",
                    "managedCluster",
                ].includes(key),
        ) ||
        config?.host !== "127.0.0.1" ||
        !Number.isInteger(config.port) ||
        config.port < 1024 ||
        config.port > 65535 ||
        !/^im101_reservation_disposable_[a-f0-9]{24}$/.test(
            config.database || "",
        ) ||
        config.user !== "im101_test_admin" ||
        !/^[a-f0-9]{64}$/.test(config.password || "") ||
        config.managedCluster !== true
    )
        throw new Error("ISOLATED_DATABASE_CONFIGURATION_REFUSED");
    return config;
}

function assertDisposableRoot(root, marker) {
    const resolved = path.resolve(root);
    if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith("im101-reservation-disposable-") ||
        fs.readFileSync(path.join(resolved, ".im101-disposable"), "utf8") !==
            marker
    )
        throw new Error("DISPOSABLE_CLEANUP_REFUSED");
    if (fs.lstatSync(resolved).isSymbolicLink())
        throw new Error("DISPOSABLE_CLEANUP_REFUSED");
    return resolved;
}

async function main() {
    if (process.argv.length !== 3 || process.argv[2] !== "--local")
        throw new Error("EXPLICIT_LOCAL_TEST_FLAG_REQUIRED");
    // Child process only: neither native tools nor drivers may inherit a service target.
    for (const key of [
        "DATABASE_URL",
        "DIRECT_URL",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSERVICE",
        "PGSERVICEFILE",
        "PGOPTIONS",
        "PGPASSFILE",
        "PGSSLMODE",
    ])
        delete process.env[key];
    const bin = process.env.IM101_TEST_PG_BIN;
    if (!bin || !path.isAbsolute(bin))
        throw new Error("LOCAL_POSTGRES_BIN_REQUIRED");
    const suffix = process.platform === "win32" ? ".exe" : "";
    function native(name, args, allowed = [0]) {
        const result = spawnSync(path.join(bin, name + suffix), args, {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30000,
        });
        if (!allowed.includes(result.status))
            throw new Error("LOCAL_POSTGRES_COMMAND_FAILED");
        return result.status;
    }
    for (const name of ["initdb", "pg_ctl"])
        if (!fs.existsSync(path.join(bin, name + suffix)))
            throw new Error("LOCAL_POSTGRES_BIN_REQUIRED");
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "im101-reservation-disposable-"),
    );
    const marker = randomBytes(24).toString("hex");
    fs.writeFileSync(path.join(root, ".im101-disposable"), marker, {
        mode: 0o600,
    });
    const data = path.join(root, "data");
    const password = randomBytes(32).toString("hex");
    const pwfile = path.join(root, "password");
    fs.writeFileSync(pwfile, password, { mode: 0o600 });
    let startAttempted = false,
        pool;
    try {
        native("initdb", [
            "-D",
            data,
            "-U",
            "im101_test_admin",
            "--pwfile",
            pwfile,
            "--auth-host=scram-sha-256",
            "--auth-local=scram-sha-256",
            "--encoding=UTF8",
            "--no-locale",
            "--no-sync",
        ]);
        const port = await new Promise((resolve, reject) => {
            const listener = net.createServer();
            listener.once("error", reject);
            listener.listen(0, "127.0.0.1", () => {
                const selected = listener.address().port;
                listener.close(() => resolve(selected));
            });
        });
        startAttempted = true;
        native("pg_ctl", [
            "-D",
            data,
            "-l",
            path.join(root, "postgres.log"),
            "-o",
            `-h 127.0.0.1 -p ${port}`,
            "-w",
            "start",
        ]);
        const database =
            "im101_reservation_disposable_" + randomBytes(12).toString("hex");
        const config = validateDisposableConfig({
            host: "127.0.0.1",
            port,
            database,
            user: "im101_test_admin",
            password,
            managedCluster: true,
        });
        pool = new Pool({
            ...config,
            database: "postgres",
            max: 4,
            connectionTimeoutMillis: 5000,
        });
        const actual = (await pool.query("SHOW data_directory")).rows[0]
            .data_directory;
        if (
            path.resolve(actual).toLowerCase() !==
            path.resolve(data).toLowerCase()
        )
            throw new Error("DISPOSABLE_CLUSTER_IDENTITY_FAILED");
        // Generated, regex-checked identifier; no caller-selected database name.
        await pool.query(`CREATE DATABASE "${database}"`);
        await pool.end();
        pool = new Pool({ ...config, max: 8, connectionTimeoutMillis: 5000 });
        await require("../tests/integration/reservations.pg").run({
            pool,
            config,
        });
    } finally {
        if (pool && !pool.ended) await pool.end();
        const resolved = assertDisposableRoot(root, marker);
        if (
            startAttempted &&
            native("pg_ctl", ["-D", data, "status"], [0, 3]) === 0
        )
            native("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
        fs.rmSync(resolved, { recursive: true });
    }
}

if (require.main === module)
    main().catch(() => {
        console.error(
            "ISOLATED_POSTGRES_VERIFICATION_FAILED: no live database was selected; review local prerequisites or test failures.",
        );
        process.exitCode = 1;
    });
module.exports = { validateDisposableConfig };
