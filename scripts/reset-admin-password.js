const bcrypt = require("bcryptjs");
const { readFileSync } = require("node:fs");
const { X509Certificate } = require("node:crypto");
const { checkServerIdentity } = require("node:tls");

class RecoveryError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

function validateInput(input) {
    if (!input || typeof input !== "object")
        throw new RecoveryError("INPUT_FORMAT");
    const { email, password, confirmation, projectRef, approval } = input;
    if (
        typeof email !== "string" ||
        !email.isWellFormed() ||
        email.length > 150 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
        [...email].some((character) => {
            const code = character.codePointAt(0);
            return code < 32 || (code >= 127 && code <= 159);
        })
    )
        throw new RecoveryError("EMAIL_FORMAT");
    if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/.test(projectRef))
        throw new RecoveryError("PROJECT_REFERENCE_FORMAT");
    if (
        typeof password !== "string" ||
        !password.isWellFormed() ||
        [...password].length < 15 ||
        Buffer.byteLength(password, "utf8") > 72 ||
        !password.trim() ||
        password.includes("\0")
    )
        throw new RecoveryError("PASSWORD_REQUIREMENTS");
    if (password !== confirmation)
        throw new RecoveryError("PASSWORD_CONFIRMATION");
    if (approval !== `RESET PASSWORD ${email} IN ${projectRef}`)
        throw new RecoveryError("APPROVAL_REQUIRED");
}

function connectionConfig(env, projectRef, readCa = readFileSync) {
    let url, user, password;
    try {
        url = new URL(env.DATABASE_URL);
        user = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
    } catch {
        throw new RecoveryError("DATABASE_URL_FORMAT");
    }
    if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        url.hash ||
        url.pathname !== "/postgres" ||
        !url.password ||
        (url.port && url.port !== "5432") ||
        url.searchParams.size !== 1
    )
        throw new RecoveryError("DATABASE_URL_SHAPE");
    if (
        url.searchParams.get("sslmode") !== "verify-full" ||
        env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ) {
        throw new RecoveryError("TLS_CONFIGURATION");
    }
    if (!(
        (url.hostname === `db.${projectRef}.supabase.co` &&
            user === "postgres") ||
        (/^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) &&
            user === `postgres.${projectRef}`)
    ))
        throw new RecoveryError("V2_PROJECT_IDENTITY");
    if (!env.NODE_EXTRA_CA_CERTS) throw new RecoveryError("CA_PATH_REQUIRED");
    let ca;
    try {
        ca = readCa(env.NODE_EXTRA_CA_CERTS, "utf8");
    } catch {
        throw new RecoveryError("CA_READ");
    }
    // Require an actual CA, not an empty file or arbitrary text. TLS still verifies
    // the certificate chain, validity and server hostname during the handshake.
    try {
        if (!new X509Certificate(ca).ca) throw new Error();
    } catch {
        throw new RecoveryError("CA_CERTIFICATE");
    }
    // Explicit fields prevent URL query options overriding the TLS configuration.
    return {
        host: url.hostname,
        port: 5432,
        user,
        password,
        database: "postgres",
        ssl: { ca, rejectUnauthorized: true, checkServerIdentity },
        connectionTimeoutMillis: 10000,
        query_timeout: 15000,
        statement_timeout: 10000,
        lock_timeout: 5000,
        idle_in_transaction_session_timeout: 15000,
        application_name: "im101-local-admin-recovery",
        options: "-c search_path=pg_catalog,public",
    };
}

async function resetAdminPassword({
    input,
    env = process.env,
    readCa = readFileSync,
    createClient = (config) => new (require("pg").Client)(config),
    hash = bcrypt.hash,
}) {
    let client;
    let transaction = false;
    let commitAttempted = false;
    let stage = "INPUT_VALIDATION";
    let result;
    try {
        validateInput(input);
        stage = "CONFIGURATION";
        const config = connectionConfig(env, input.projectRef, readCa);
        stage = "PASSWORD_HASHING";
        const passwordHash = await hash(input.password, 12);
        stage = "CLIENT_SETUP";
        client = createClient(config);
        // An idle connection error must never become an uncaught secret-bearing error.
        client.on("error", () => {});
        stage = "DATABASE_CONNECTION";
        await client.connect();
        stage = "TRANSACTION_BEGIN";
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        transaction = true;
        stage = "ACCOUNT_LOOKUP";
        const account = await client.query(
            `SELECT u.user_id, u.email, u.is_active, r.role_name
             FROM public.users AS u JOIN public.roles AS r ON r.role_id = u.role_id
             WHERE u.email = $1 FOR UPDATE OF u, r`,
            [input.email],
        );
        const user = account.rows[0];
        if (account.rowCount === 0)
            throw new RecoveryError("ACCOUNT_NOT_FOUND");
        if (account.rowCount !== 1 || !user)
            throw new RecoveryError("ACCOUNT_CARDINALITY");
        if (user.email !== input.email)
            throw new RecoveryError("ACCOUNT_EMAIL_MISMATCH");
        if (user.is_active !== true)
            throw new RecoveryError("ACCOUNT_INACTIVE");
        if (user.role_name !== "System Administrator")
            throw new RecoveryError("ACCOUNT_ROLE_REFUSED");
        if (!Number.isSafeInteger(user.user_id) || user.user_id <= 0) {
            throw new RecoveryError("ACCOUNT_ID_INVALID");
        }
        stage = "PASSWORD_UPDATE";
        const updated = await client.query(
            `UPDATE public.users AS u SET password_hash = $1
             WHERE u.user_id = $2 AND u.email = $3 AND u.is_active = true
             AND EXISTS (SELECT 1 FROM public.roles AS r
                         WHERE r.role_id = u.role_id AND r.role_name = $4)
             RETURNING u.user_id`,
            [passwordHash, user.user_id, input.email, "System Administrator"],
        );
        if (
            updated.rowCount !== 1 ||
            updated.rows[0]?.user_id !== user.user_id
        ) {
            throw new RecoveryError("UPDATE_CARDINALITY");
        }
        stage = "TRANSACTION_COMMIT";
        commitAttempted = true;
        await client.query("COMMIT");
        transaction = false;
        result = {
            success: true,
            message: "PASS: existing administrator password reset.",
        };
    } catch (error) {
        // Only our fixed codes and allowlisted driver classifications are emitted.
        // Never print error.message, detail, stack, query, or arbitrary error.code.
        const driverReasons = {
            CERT_HAS_EXPIRED: "TLS_CERTIFICATE_EXPIRED",
            DEPTH_ZERO_SELF_SIGNED_CERT: "TLS_CERTIFICATE_UNTRUSTED",
            SELF_SIGNED_CERT_IN_CHAIN: "TLS_CERTIFICATE_UNTRUSTED",
            UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS_CERTIFICATE_UNTRUSTED",
            UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "TLS_CERTIFICATE_UNTRUSTED",
            ERR_TLS_CERT_ALTNAME_INVALID: "TLS_HOSTNAME",
            "28P01": "DATABASE_AUTHENTICATION",
            28000: "DATABASE_AUTHENTICATION",
            42501: "DATABASE_PERMISSION",
            "42P01": "DATABASE_SCHEMA",
            42703: "DATABASE_SCHEMA",
            40001: "SERIALIZATION_CONFLICT",
            "40P01": "DEADLOCK",
            "55P03": "LOCK_TIMEOUT",
            57014: "STATEMENT_CANCELLED",
            ENOTFOUND: "NETWORK_DNS",
            EAI_AGAIN: "NETWORK_DNS",
            ECONNREFUSED: "NETWORK_CONNECTION",
            ETIMEDOUT: "NETWORK_TIMEOUT",
        };
        const reason =
            error instanceof RecoveryError
                ? error.code
                : Object.hasOwn(driverReasons, error?.code)
                  ? driverReasons[error.code]
                  : "DETAILS_WITHHELD";
        result = {
            success: false,
            code: `${stage}/${reason}`,
            message: commitAttempted
                ? `FAIL [${stage}/${reason}]: commit outcome uncertain; verify privately before retrying. Details withheld.`
                : `FAIL [${stage}/${reason}]: no COMMIT was sent by this run; verify privately before retrying. Details withheld.`,
        };
        if (transaction) {
            try {
                await client.query("ROLLBACK");
            } catch {
                result = {
                    success: false,
                    message:
                        "FAIL: rollback could not be confirmed; verify privately before retrying. Details withheld.",
                };
            }
        }
    } finally {
        if (client) {
            try {
                await client.end();
            } catch {
                result = {
                    success: false,
                    message:
                        "FAIL: connection cleanup failed; reset may have completed. Verify privately before retrying. Details withheld.",
                };
            }
        }
    }
    return result;
}

async function main() {
    try {
        // Only the PowerShell launcher supplies private input; never accept CLI secrets.
        if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
        require("dotenv").config({ quiet: true });
        let body = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) {
            body += chunk;
            if (Buffer.byteLength(body) > 8192) throw new Error();
        }
        const input = JSON.parse(body.replace(/^\uFEFF/, ""));
        body = "";
        const result = await resetAdminPassword({ input });
        input.password = input.confirmation = undefined;
        console.log(result.message);
        process.exitCode = result.success ? 0 : 1;
    } catch {
        console.log(
            "FAIL: recovery input or startup refused; details withheld.",
        );
        process.exitCode = 1;
    }
}

if (require.main === module) void main();
module.exports = { resetAdminPassword, validateInput, connectionConfig };
