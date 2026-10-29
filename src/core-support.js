const { createReservationTransaction } = require("./reservation-transaction");
const { validateReservationCreation } = require("./reservation-validation");
const roles = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const admin = (user) => user.role.roleName === roles[0];
const reviewer = (user) => roles.slice(0, 2).includes(user.role.roleName);
function refuse(code = "C4001") {
    throw Object.assign(new Error("Core workflow refused."), { code });
}
function integer(value) {
    return Number.isInteger(value) && value > 0 && value <= 2147483647;
}
function id(value) {
    if (
        typeof value !== "string" ||
        !/^[1-9]\d*$/.test(value) ||
        !integer(Number(value))
    )
        refuse();
    return Number(value);
}
function body(value, required, optional = []) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(
            (key) => ![...required, ...optional].includes(key),
        ) ||
        required.some((key) => !Object.hasOwn(value, key))
    )
        refuse();
    return value;
}
function text(value, max, multiline = false) {
    if (
        typeof value !== "string" ||
        !value.isWellFormed() ||
        !value.trim() ||
        [...value.trim()].length > max ||
        [...value.trim()].some((character) => {
            const code = character.codePointAt(0);
            return (
                (code < 32 && !(multiline && [9, 10, 13].includes(code))) ||
                (code >= 127 && code <= 159)
            );
        })
    )
        refuse();
    return value.trim();
}
function timestamp(value) {
    const result = validateReservationCreation({
        facilityId: 1,
        purpose: "Validation",
        startDatetime: value,
        endDatetime: "9999-12-31T23:59:59.999Z",
    });
    if (!result.success) refuse();
    return new Date(result.data.startDatetime);
}
function day(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        refuse();
    const date = timestamp(value + "T00:00:00Z");
    if (date.toISOString().slice(0, 10) !== value) refuse();
    return date;
}
function pagination(query, extras = []) {
    if (
        Object.keys(query).some(
            (key) => !["page", "limit", ...extras].includes(key),
        )
    )
        refuse();
    const page = query.page === undefined ? 1 : id(query.page),
        limit = query.limit === undefined ? 20 : id(query.limit);
    if (limit > 100 || (page - 1) * limit > 2147483647) refuse();
    return { page, limit, skip: (page - 1) * limit, take: limit + 1 };
}
function list(rows, paging, key) {
    return {
        success: true,
        [key]: rows.slice(0, paging.limit),
        pagination: {
            page: paging.page,
            limit: paging.limit,
            hasMore: rows.length > paging.limit,
        },
    };
}
const errors = {
    C4001: [400, "Invalid workflow input."],
    C4031: [403, "Access denied."],
    C4041: [404, "Record not found."],
    C4091: [
        409,
        "Workflow conflict. Reload before considering another attempt.",
    ],
    CORE_INPUT: [400, "Invalid workflow input."],
    CORE_ACCESS: [403, "Access denied."],
    CORE_NOT_FOUND: [404, "Record not found."],
    CORE_CONFLICT: [
        409,
        "Workflow conflict. Reload before considering another attempt.",
    ],
    RESERVATION_CONFLICT: [
        409,
        "Workflow conflict. Reload before considering another attempt.",
    ],
    CORE_AUTHENTICATION: [401, "Authentication required."],
};
function handle(operation) {
    return async (req, res, next) => {
        try {
            await operation(req, res);
        } catch (error) {
            const mapped =
                typeof error?.code === "string" &&
                Object.hasOwn(errors, error.code)
                    ? errors[error.code]
                    : null;
            if (mapped)
                res.status(mapped[0]).json({
                    success: false,
                    message: mapped[1],
                });
            else next(error);
        }
    };
}
function transaction(getPrisma) {
    const run = createReservationTransaction({ getPrisma });
    return (user, operation) =>
        run(user, async (tx) => {
            const actors =
                await tx.$queryRaw`SELECT actor,role_name FROM im101_private.core_actor()`;
            if (actors.length !== 1 || actors[0].actor !== user.userId)
                refuse("C4011");
            const current = {
                userId: actors[0].actor,
                role: { roleName: actors[0].role_name },
            };
            if (!roles.includes(current.role.roleName)) refuse("C4031");
            return operation(tx, current);
        });
}
async function now(tx) {
    return (await tx.$queryRaw`SELECT clock_timestamp() AS now`)[0].now;
}
function noQuery(req) {
    if (Object.keys(req.query).length) refuse();
    const hasBody =
        (req.get("content-length") !== undefined &&
            req.get("content-length") !== "0") ||
        Boolean(req.get("transfer-encoding"));
    if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
        hasBody &&
        !req.is("application/json")
    )
        refuse();
}
module.exports = {
    roles,
    admin,
    reviewer,
    refuse,
    integer,
    id,
    body,
    text,
    timestamp,
    day,
    pagination,
    list,
    handle,
    transaction,
    now,
    noQuery,
};
