const { randomUUID, randomBytes } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { connectionConfig } = require("./reset-admin-password");

class CrudVerificationError extends Error {
    constructor(code) {
        // Never retain an untrusted response, field name, value or cause in errors.
        super(code);
        this.code = code;
    }
}

function check(condition, code = "VERIFICATION_FAILED") {
    if (!condition) throw new CrudVerificationError(code);
}

const integer = (value, min = 1, max = 2147483647) =>
    Number.isInteger(value) && value >= min && value <= max;
const text =
    (max, nullable = false) =>
    (value) =>
        (nullable && value === null) ||
        (typeof value === "string" &&
            value.isWellFormed() &&
            [...value].length <= max &&
            value.trim() === value &&
            ![...value].some(
                (character) =>
                    character.codePointAt(0) < 32 ||
                    (character.codePointAt(0) >= 127 &&
                        character.codePointAt(0) <= 159),
            ));
const timestamp = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;

// Independently reviewed against the approved Prisma scalar fields. Do not import
// route select objects: a route regression must not expand these allowlists.
const responseSchemas = Object.freeze({
    buildings: Object.freeze({
        buildingId: integer,
        buildingName: text(100),
        floorCount: (value) => integer(value, 1, 32767),
        locationNote: text(150, true),
    }),
    facilities: Object.freeze({
        facilityId: integer,
        buildingId: integer,
        facilityTypeId: integer,
        facilityName: text(100),
        floorNumber: (value) => integer(value, 1, 32767),
        capacity: integer,
        status: text(20),
        createdAt: timestamp,
    }),
    equipment: Object.freeze({
        equipmentId: integer,
        categoryId: integer,
        homeFacilityId: (value) => value === null || integer(value),
        equipmentName: text(100),
        serialNumber: text(60, true),
        totalQuantity: (value) => integer(value, 0),
        availableQuantity: (value) => integer(value, 0),
        conditionStatus: text(20),
        createdAt: timestamp,
    }),
});
const responseKeys = Object.freeze({
    buildings: "building",
    facilities: "facility",
    equipment: "equipment",
});

function exactFields(value, fields) {
    check(
        value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            [Object.prototype, null].includes(Object.getPrototypeOf(value)),
        "RESPONSE_SHAPE",
    );
    const keys = Reflect.ownKeys(value);
    check(
        keys.every((key) => fields.includes(key)),
        "RESPONSE_UNEXPECTED_FIELDS",
    );
    check(
        fields.every((key) => Object.hasOwn(value, key)),
        "RESPONSE_MISSING_FIELDS",
    );
    const clean = {};
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        check(
            descriptor.enumerable && Object.hasOwn(descriptor, "value"),
            "RESPONSE_SHAPE",
        );
        clean[field] = descriptor.value;
    }
    return clean;
}

function validatedSnapshot(collection, value, expected) {
    const schema = responseSchemas[collection];
    const clean = exactFields(value, Object.keys(schema));
    for (const [field, valid] of Object.entries(schema))
        check(valid(clean[field]), "RESPONSE_FIELD_TYPE");
    // Expected values come from this run's fixed payload or a previously validated
    // snapshot. Pin generated IDs and timestamps after the successful POST.
    for (const [field, expectedValue] of Object.entries(expected))
        check(clean[field] === expectedValue, "RESPONSE_IDENTITY");
    if (collection === "equipment")
        check(
            clean.availableQuantity <= clean.totalQuantity,
            "RESPONSE_FIELD_TYPE",
        );
    return Object.freeze(clean);
}

function writeReceipt(record, entry) {
    try {
        record(entry);
    } catch {
        throw new CrudVerificationError("RECEIPT_WRITE_FAILED");
    }
}

// Transport is injected so tests never open sockets or load database configuration.
async function verifyCrud({
    request,
    record,
    runId,
    facilityTypeId,
    categoryId,
}) {
    check(
        typeof runId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
                runId,
            ),
    );
    for (const id of [facilityTypeId, categoryId]) check(integer(id));
    const marker = `IM101-DISPOSABLE-${runId}`;
    const owned = [];
    async function call(method, path, body, status = 200) {
        let result;
        try {
            result = await request(method, path, body);
        } catch {
            throw new CrudVerificationError("HTTP_RESPONSE_UNCERTAIN");
        }
        check(result?.status === status, "RESPONSE_STATUS");
        const key = responseKeys[path.split("/")[2]];
        const clean = exactFields(
            result.body,
            status === 404 ? ["success", "message"] : ["success", key],
        );
        check(clean.success === (status !== 404), "RESPONSE_ENVELOPE");
        if (status === 404)
            check(
                clean.message ===
                    `${key[0].toUpperCase()}${key.slice(1)} not found.`,
                "RESPONSE_ENVELOPE",
            );
        return clean;
    }
    async function create(collection, key, idField, data, patch) {
        // Record intent before a POST: a lost response must never be retried blindly.
        writeReceipt(record, { action: "intent", collection, data });
        const body = await call("POST", `/api/${collection}`, data, 201);
        const row = validatedSnapshot(collection, body[key], data);
        const item = {
            collection,
            key,
            idField,
            row,
            patch,
        };
        // No caller-supplied IDs or recovery-by-name path is accepted.
        writeReceipt(record, { action: "created", collection, row: item.row });
        owned.push(item);
        return row[idField];
    }
    async function current(item) {
        const path = `/api/${item.collection}/${item.row[item.idField]}`;
        const body = await call("GET", path);
        validatedSnapshot(item.collection, body[item.key], item.row);
        return path;
    }
    const buildingId = await create(
        "buildings",
        "building",
        "buildingId",
        {
            buildingName: `${marker}-B`,
            floorCount: 2,
            locationNote: marker,
        },
        { locationNote: `${marker}-UPDATED` },
    );
    const facilityId = await create(
        "facilities",
        "facility",
        "facilityId",
        {
            buildingId,
            facilityTypeId,
            facilityName: `${marker}-F`,
            floorNumber: 1,
            capacity: 1,
            status: "Available",
        },
        { capacity: 2 },
    );
    await create(
        "equipment",
        "equipment",
        "equipmentId",
        {
            categoryId,
            homeFacilityId: facilityId,
            equipmentName: `${marker}-E`,
            serialNumber: marker,
            totalQuantity: 1,
            availableQuantity: 1,
            conditionStatus: "Good",
        },
        { conditionStatus: "Fair" },
    );
    for (const item of owned) {
        const path = await current(item);
        writeReceipt(record, {
            action: "update-intent",
            collection: item.collection,
            id: item.row[item.idField],
        });
        const body = await call("PUT", path, item.patch);
        const expected = { ...item.row, ...item.patch };
        item.row = validatedSnapshot(item.collection, body[item.key], expected);
        writeReceipt(record, {
            action: "updated",
            collection: item.collection,
            row: item.row,
        });
        await current(item);
    }
    // Normal, approved DELETE verification only. Never cleanup from a catch/finally.
    for (const item of owned.slice().reverse()) {
        const path = await current(item);
        writeReceipt(record, {
            action: "delete-intent",
            collection: item.collection,
            id: item.row[item.idField],
        });
        const body = await call("DELETE", path);
        validatedSnapshot(item.collection, body[item.key], item.row);
        writeReceipt(record, {
            action: "deleted",
            collection: item.collection,
            id: item.row[item.idField],
        });
        await call("GET", path, undefined, 404);
    }
}

async function runLiveCrud({
    input,
    env = process.env,
    readCa,
    start,
    openReceipt,
}) {
    let session, receipt;
    let stage = "approval and configuration";
    let result;
    try {
        check(
            typeof input.projectRef === "string" &&
                /^[a-z0-9]{20}$/.test(input.projectRef),
        );
        check(
            input.approval ===
                `CREATE UPDATE DELETE DISPOSABLE RECORDS IN ${input.projectRef}`,
        );
        check(typeof input.email === "string" && input.email.trim());
        check(typeof input.password === "string" && input.password);
        const config = connectionConfig(env, input.projectRef, readCa);
        stage = "local server startup";
        session = await start({
            ...config,
            application_name: "im101-live-crud",
        });
        stage = "existing administrator authentication";
        const login = await session.request("POST", "/api/auth/login", {
            email: input.email,
            password: input.password,
        });
        input.password = undefined;
        check(login.status === 200 && login.body.success === true);
        check(login.body.user.role.roleName === "System Administrator");
        check(login.body.user.email === input.email.trim());
        check(typeof login.body.token === "string" && login.body.token);
        session.setToken(login.body.token);
        const profile = await session.request("GET", "/api/auth/me");
        check(profile.status === 200 && profile.body.success === true);
        check(isDeepStrictEqual(profile.body.user, login.body.user));
        stage = "approved lookup selection";
        const { facilityTypeId, categoryId } = await session.lookups();
        check(integer(facilityTypeId) && integer(categoryId));
        // Never spread a returned lookup object into a receipt.
        const lookup = { facilityTypeId, categoryId };
        const runId = randomUUID();
        stage = "private receipt creation";
        receipt = openReceipt(runId);
        writeReceipt(receipt.record, {
            action: "start",
            runId,
            projectRef: input.projectRef,
            ...lookup,
        });
        stage = "CRUD verification (inspect receipt before any retry)";
        await verifyCrud({
            request: session.request,
            record: receipt.record,
            runId,
            ...lookup,
        });
        writeReceipt(receipt.record, { action: "complete" });
        result = {
            success: true,
            message:
                "PASS: all three APIs returned create 201, read/update/delete 200 and post-delete 404. Disposable records removed; retain the private receipt.",
        };
    } catch (error) {
        const code =
            error instanceof CrudVerificationError
                ? error.code
                : "VERIFICATION_FAILED";
        result = {
            success: false,
            code,
            message: `FAIL [${code}]: ${stage}. Stop; no automatic retry or failure cleanup. Records may remain. Review private receipt and state; details withheld.`,
        };
    } finally {
        if (input) input.password = undefined;
        for (const close of [() => receipt?.close(), () => session?.close()]) {
            try {
                await close();
            } catch {
                if (result.success)
                    result = {
                        success: false,
                        code: "RESOURCE_CLEANUP_FAILED",
                        message:
                            "FAIL [RESOURCE_CLEANUP_FAILED]: records may remain; inspect private receipt before retrying. Details withheld.",
                    };
                else if (!result.cleanupCode) {
                    result.cleanupCode = "RESOURCE_CLEANUP_FAILED";
                    result.message +=
                        " Resource cleanup also failed [RESOURCE_CLEANUP_FAILED].";
                }
            }
        }
    }
    return result;
}

async function startLocal(config) {
    const { PrismaClient } = require("@prisma/client");
    const { PrismaPg } = require("@prisma/adapter-pg");
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ ...config, max: 2 }),
        log: [],
    });
    const app = require("../src/app").createApp({
        getPrisma: () => prisma,
        jwtSecret: randomBytes(48).toString("hex"),
    });
    const server = app.listen(0, "127.0.0.1");
    try {
        await new Promise((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
    } catch (error) {
        await prisma.$disconnect();
        throw error;
    }
    let token;
    return {
        setToken: (value) => {
            token = value;
        },
        request: async (method, path, body) => {
            const response = await fetch(
                `http://127.0.0.1:${server.address().port}${path}`,
                {
                    method,
                    redirect: "error",
                    signal: AbortSignal.timeout(30000),
                    headers: {
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                },
            );
            return { status: response.status, body: await response.json() };
        },
        lookups: async () => {
            const type = await prisma.facilityType.findUnique({
                where: { typeName: "Classroom" },
                select: { facilityTypeId: true },
            });
            const category = await prisma.equipmentCategory.findUnique({
                where: { categoryName: "Computer Equipment" },
                select: { categoryId: true },
            });
            return {
                facilityTypeId: type?.facilityTypeId,
                categoryId: category?.categoryId,
            };
        },
        close: async () => {
            token = undefined;
            try {
                await new Promise((resolve, reject) =>
                    server.close((error) =>
                        error ? reject(error) : resolve(),
                    ),
                );
            } finally {
                await prisma.$disconnect();
            }
        },
    };
}

function openPrivateReceipt(runId) {
    const fs = require("node:fs");
    const path = require("node:path");
    const directory = path.join(__dirname, "../tmp/live-crud");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${runId}.jsonl`);
    const fd = fs.openSync(file, "wx", 0o600);
    console.log(`Private test receipt: tmp/live-crud/${runId}.jsonl`);
    return {
        record: (entry) => {
            fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
            fs.fsyncSync(fd);
        },
        close: () => fs.closeSync(fd),
    };
}

async function main() {
    if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
    require("dotenv").config({ quiet: true });
    let text = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
        text += chunk;
        if (Buffer.byteLength(text) > 8192) throw new Error();
    }
    const input = JSON.parse(text.replace(/^\uFEFF/, ""));
    const result = await runLiveCrud({
        input,
        start: startLocal,
        openReceipt: openPrivateReceipt,
    });
    console.log(result.message);
    process.exitCode = result.success ? 0 : 1;
}
if (require.main === module)
    main().catch(() => {
        console.log(
            "FAIL: private launcher input or startup; details withheld.",
        );
        process.exitCode = 1;
    });
module.exports = { verifyCrud, runLiveCrud };
