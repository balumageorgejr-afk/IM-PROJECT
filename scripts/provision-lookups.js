const { createInterface } = require("node:readline/promises");
const { connectionConfig } = require("./reset-admin-password");

// Suggestions only. Operator/instructor must approve this exact list before use.
const facilityTypes = Object.freeze([
    "Classroom",
    "Lecture Hall",
    "Laboratory",
    "Computer Laboratory",
    "Conference Room",
    "Auditorium",
    "Gymnasium",
    "Study Room",
]);
const equipmentCategories = Object.freeze([
    "Audio Visual Equipment",
    "Computer Equipment",
    "Laboratory Equipment",
    "Sports Equipment",
    "Furniture",
    "Maintenance Tools",
]);
const statements = Object.freeze([
    "INSERT INTO public.facility_types (type_name) VALUES ($1) ON CONFLICT (type_name) DO NOTHING",
    "INSERT INTO public.equipment_categories (category_name) VALUES ($1) ON CONFLICT (category_name) DO NOTHING",
]);

class LookupError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

// Only fixed local codes and classifications are printable, never raw errors.
const configReasons = new Set([
    "DATABASE_URL_FORMAT",
    "DATABASE_URL_SHAPE",
    "TLS_CONFIGURATION",
    "V2_PROJECT_IDENTITY",
    "CA_PATH_REQUIRED",
    "CA_READ",
    "CA_CERTIFICATE",
]);
const driverReasons = new Map(
    Object.entries({
        CERT_HAS_EXPIRED: "TLS_CERTIFICATE_EXPIRED",
        CERT_NOT_YET_VALID: "TLS_CERTIFICATE_NOT_YET_VALID",
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
        "42P10": "DATABASE_CONFLICT_CONSTRAINT",
        23502: "DATABASE_NOT_NULL",
        23503: "DATABASE_FOREIGN_KEY",
        23505: "DATABASE_UNIQUENESS",
        23514: "DATABASE_CHECK",
        22001: "DATABASE_VALUE_LENGTH",
        40001: "SERIALIZATION_CONFLICT",
        "40P01": "DEADLOCK",
        "55P03": "LOCK_TIMEOUT",
        57014: "STATEMENT_CANCELLED",
        "25P02": "TRANSACTION_ABORTED",
        25006: "DATABASE_READ_ONLY",
        53300: "DATABASE_CONNECTION_LIMIT",
        "57P01": "DATABASE_SHUTDOWN",
        ENOTFOUND: "NETWORK_DNS",
        EAI_AGAIN: "NETWORK_DNS",
        ECONNREFUSED: "NETWORK_CONNECTION",
        ECONNRESET: "NETWORK_CONNECTION",
        EPIPE: "NETWORK_CONNECTION",
        ETIMEDOUT: "NETWORK_TIMEOUT",
    }),
);

function reasonCode(error, stage) {
    if (error instanceof LookupError) return error.code;
    if (stage === "CONFIGURATION" && configReasons.has(error?.code))
        return error.code;
    return driverReasons.get(error?.code) || "DETAILS_WITHHELD";
}

function validateConfirmation(projectRef, approval) {
    if (typeof projectRef !== "string" || !/^[a-z0-9]{20}$/.test(projectRef))
        throw new LookupError("PROJECT_REFERENCE_FORMAT");
    const expected = `APPROVE SUGGESTED LOOKUPS IN ${projectRef}`;
    if (approval === expected) return;
    if (typeof approval !== "string" || !approval)
        throw new LookupError("CONFIRMATION_REQUIRED");
    if (
        [...approval].some(
            (character) =>
                character.codePointAt(0) < 32 ||
                character.codePointAt(0) === 127,
        )
    )
        throw new LookupError("CONFIRMATION_CONTROL_CHARACTERS");
    if (approval.trim() === expected)
        throw new LookupError("CONFIRMATION_WHITESPACE");
    if (expected.startsWith(approval))
        throw new LookupError("CONFIRMATION_INCOMPLETE");
    throw new LookupError("CONFIRMATION_MISMATCH");
}

function failure(stage, error, outcome = "REFUSED_BEFORE_BEGIN") {
    return {
        success: false,
        code: `${stage}/${reasonCode(error, stage)}`,
        outcome,
        rollback: "NOT_REQUESTED",
        cleanup: "NOT_REQUESTED",
    };
}

function describe(result) {
    if (result.success) return result;
    const outcomes = {
        REFUSED_BEFORE_BEGIN:
            "Refused or failed before BEGIN; no lookup writes requested.",
        BEGIN_UNCONFIRMED:
            "BEGIN acknowledgement failed; no lookup inserts or COMMIT requested.",
        FAILED_BEFORE_COMMIT:
            "Failed before COMMIT; no COMMIT requested by this run.",
        COMMIT_UNCERTAIN:
            "COMMIT outcome uncertain; verify privately before any retry. A later ROLLBACK does not resolve this uncertainty.",
        COMMITTED_CLEANUP_FAILED:
            "COMMIT confirmed, but connection cleanup failed; verify privately before any retry.",
    };
    result.message = `FAIL [${result.code}]: ${outcomes[result.outcome]} Rollback=${result.rollback}${result.rollbackCode ? ` [${result.rollbackCode}]` : ""}; cleanup=${result.cleanup}${result.cleanupCode ? ` [${result.cleanupCode}]` : ""}. Details withheld.`;
    return result;
}

async function provisionLookups({
    projectRef,
    approval,
    env = process.env,
    readCa,
    createClient = (config) => new (require("pg").Client)(config),
}) {
    let client,
        beginAttempted = false,
        active = false,
        commitAttempted = false,
        committed = false;
    let stage = "INPUT_VALIDATION";
    let result;
    try {
        validateConfirmation(projectRef, approval);
        stage = "CONFIGURATION";
        const config = connectionConfig(env, projectRef, readCa);
        stage = "CLIENT_SETUP";
        client = createClient({
            ...config,
            application_name: "im101-lookup-provisioning",
        });
        client.on("error", () => {});
        stage = "DATABASE_CONNECTION";
        await client.connect();
        stage = "TRANSACTION_BEGIN";
        beginAttempted = true;
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        active = true;
        let inserted = 0;
        for (const [index, names] of [
            facilityTypes,
            equipmentCategories,
        ].entries()) {
            stage =
                index === 0
                    ? "FACILITY_TYPES_INSERT"
                    : "EQUIPMENT_CATEGORIES_INSERT";
            for (const name of names) {
                const row = await client.query(statements[index], [name]);
                if (![0, 1].includes(row?.rowCount))
                    throw new LookupError("INSERT_CARDINALITY");
                inserted += row.rowCount;
            }
        }
        stage = "TRANSACTION_COMMIT";
        commitAttempted = true;
        const commit = await client.query("COMMIT");
        // PostgreSQL can answer COMMIT with ROLLBACK for an aborted transaction.
        if (commit?.command !== "COMMIT")
            throw new LookupError("COMMIT_NOT_CONFIRMED");
        committed = true;
        active = false;
        result = {
            success: true,
            message: `Lookup provisioning complete: ${inserted} inserted; ${facilityTypes.length + equipmentCategories.length - inserted} existing names skipped.`,
        };
    } catch (error) {
        result = failure(
            stage,
            error,
            commitAttempted
                ? "COMMIT_UNCERTAIN"
                : active
                  ? "FAILED_BEFORE_COMMIT"
                  : beginAttempted
                    ? "BEGIN_UNCONFIRMED"
                    : "REFUSED_BEFORE_BEGIN",
        );
        if (beginAttempted) {
            try {
                const rollback = await client.query("ROLLBACK");
                if (rollback?.command !== "ROLLBACK")
                    throw new LookupError("ROLLBACK_NOT_CONFIRMED");
                result.rollback = "CONFIRMED";
            } catch (rollbackError) {
                result.rollback = "FAILED";
                result.rollbackCode = `TRANSACTION_ROLLBACK/${reasonCode(rollbackError, "TRANSACTION_ROLLBACK")}`;
            }
        }
    } finally {
        if (client) {
            try {
                await client.end();
                if (!result.success) result.cleanup = "CONFIRMED";
            } catch (error) {
                if (committed)
                    result = failure(
                        "CONNECTION_CLEANUP",
                        error,
                        "COMMITTED_CLEANUP_FAILED",
                    );
                result.cleanup = "FAILED";
                result.cleanupCode = `CONNECTION_CLEANUP/${reasonCode(error, "CONNECTION_CLEANUP")}`;
            }
        }
    }
    return describe(result);
}

async function readOperatorInput({ mode, createPrompt = createInterface }) {
    const prompt = createPrompt({
        input: process.stdin,
        output: process.stdout,
    });
    const cancelled = new AbortController();
    prompt.on("close", () => cancelled.abort());
    prompt.on("SIGINT", () => cancelled.abort());
    const options = { signal: cancelled.signal };
    try {
        const projectRef = await prompt.question(
            "Intended V2 project reference from dashboard: ",
            options,
        );
        const approval =
            mode === "--apply"
                ? await prompt.question(
                      `Type the complete phrase on one input line (visual wrapping is OK; no trailing spaces): APPROVE SUGGESTED LOOKUPS IN ${projectRef}: `,
                      options,
                  )
                : undefined;
        return { projectRef, approval };
    } catch {
        throw new LookupError("INPUT_CANCELLED_OR_CLOSED");
    } finally {
        prompt.close();
    }
}

async function runLookupCommand({
    args = process.argv.slice(2),
    env = process.env,
    isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    readInput = readOperatorInput,
    loadEnv = () => require("dotenv").config({ quiet: true, processEnv: env }),
    readCa,
    createClient,
} = {}) {
    let stage = "CLI_VALIDATION";
    try {
        if (!args.length)
            return {
                success: true,
                message:
                    "Offline preview only. No database client created. Use --apply only after separate approval.",
            };
        if (
            args.length !== 1 ||
            !["--apply", "--check-config"].includes(args[0])
        )
            throw new LookupError("ARGUMENTS");
        if (!isTTY) throw new LookupError("INTERACTIVE_TERMINAL_REQUIRED");
        stage = "OPERATOR_INPUT";
        const input = await readInput({ mode: args[0] });
        stage = "INPUT_VALIDATION";
        if (
            typeof input.projectRef !== "string" ||
            !/^[a-z0-9]{20}$/.test(input.projectRef)
        )
            throw new LookupError("PROJECT_REFERENCE_FORMAT");
        if (args[0] === "--apply")
            validateConfirmation(input.projectRef, input.approval);
        stage = "ENVIRONMENT_LOADING";
        const loaded = loadEnv();
        // A deployment may supply the environment without a .env file.
        if (
            loaded?.error &&
            (loaded.error.code !== "ENOENT" || !env.DATABASE_URL)
        )
            throw new LookupError("ENVIRONMENT_READ");
        if (args[0] === "--check-config") {
            stage = "CONFIGURATION";
            connectionConfig(env, input.projectRef, readCa);
            return {
                success: true,
                message:
                    "PASS: offline configuration, project identity and CA parsing checks. No database client or connection created. Remote reachability, credentials, TLS handshake and database state remain unverified.",
            };
        }
        return await provisionLookups({ ...input, env, readCa, createClient });
    } catch (error) {
        return describe(failure(stage, error));
    }
}

async function main() {
    console.log("SUGGESTIONS REQUIRING OPERATOR/INSTRUCTOR APPROVAL:");
    console.log(
        JSON.stringify({ facilityTypes, equipmentCategories }, null, 2),
    );
    const result = await runLookupCommand();
    console.log(result.message);
    process.exitCode = result.success ? 0 : 1;
}
if (require.main === module)
    main().catch(() => {
        console.log(
            "FAIL [STARTUP/DETAILS_WITHHELD]: startup failed; no automatic retry. Details withheld.",
        );
        process.exitCode = 1;
    });
module.exports = {
    facilityTypes,
    equipmentCategories,
    provisionLookups,
    validateConfirmation,
    readOperatorInput,
    runLookupCommand,
};
