const sqlCodes = {
    C4001: "CORE_INPUT",
    C4011: "CORE_AUTHENTICATION",
    C4031: "CORE_ACCESS",
    C4041: "CORE_NOT_FOUND",
    C4091: "CORE_CONFLICT",
    23505: "CORE_CONFLICT",
    23503: "CORE_CONFLICT",
    R4001: "RESERVATION_INPUT",
    R4011: "RESERVATION_AUTHENTICATION",
    R4031: "RESERVATION_ACCESS",
    R4041: "RESERVATION_NOT_FOUND",
    R4091: "RESERVATION_CONFLICT",
    R5031: "RESERVATION_CONFIGURATION",
    40001: "RESERVATION_CONFLICT",
    "40P01": "RESERVATION_CONFLICT",
};

// Only fixed SQLSTATE codes escape; never retain the driver error or its metadata.
function reservationErrorCode(error) {
    try {
        // Match only the fixed message paired with its SQLSTATE, never arbitrary
        // driver text or a generic R4091/serialization error. No message is echoed.
        const cause = error?.meta?.driverAdapterError?.cause;
        for (const [code, message] of [
            [error?.code, error?.message],
            [error?.meta?.code, error?.meta?.message],
            [cause?.originalCode, cause?.originalMessage],
        ]) {
            if (
                code === "R4091" &&
                message === "Reservation schedule conflict."
            )
                return "RESERVATION_SCHEDULE_CONFLICT";
        }
        if (error?.code === "P2034") return "RESERVATION_CONFLICT";
        if (["P2002", "P2003"].includes(error?.code)) return "CORE_CONFLICT";
        for (const code of [
            error?.code,
            error?.meta?.code,
            error?.meta?.driverAdapterError?.cause?.originalCode,
        ]) {
            if (typeof code === "string" && Object.hasOwn(sqlCodes, code))
                return sqlCodes[code];
        }
    } catch {
        /* Hostile error objects have no trusted diagnostic. */
    }
    return null;
}

const publicErrors = {
    RESERVATION_SCHEDULE_CONFLICT: [
        409,
        "The selected facility is already reserved during the requested time.",
    ],
    RESERVATION_INPUT: [400, "Invalid reservation input or time interval."],
    RESERVATION_AUTHENTICATION: [401, "Authentication required."],
    RESERVATION_ACCESS: [403, "Access denied."],
    RESERVATION_NOT_FOUND: [404, "Reservation resource not found."],
    RESERVATION_CONFLICT: [
        409,
        "Reservation conflict. Reload before considering another attempt.",
    ],
    RESERVATION_CONFIGURATION: [503, "Reservation configuration unavailable."],
};
module.exports = { reservationErrorCode, publicErrors };
