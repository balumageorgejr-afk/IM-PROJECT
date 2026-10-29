const { reservationErrorCode } = require("./reservation-errors");

function gatewayError(code) {
    const error = new Error("Reservation transaction could not be completed.");
    error.code = code;
    return error;
}

function actorIdFrom(authenticatedUser) {
    try {
        if (!authenticatedUser || typeof authenticatedUser !== "object")
            return null;
        const descriptor = Object.getOwnPropertyDescriptor(
            authenticatedUser,
            "userId",
        );
        const id = descriptor?.value;
        return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
    } catch {
        return null;
    }
}

function createReservationTransaction({ getPrisma }) {
    if (typeof getPrisma !== "function")
        throw gatewayError("INVALID_TRANSACTION_CONFIGURATION");

    // authenticatedUser must be req.user established by existing auth/RBAC,
    // never a body, query or header object. Shape validation cannot prove origin.
    return async function runReservationTransaction(
        authenticatedUser,
        operation,
    ) {
        const actorId = actorIdFrom(authenticatedUser);
        if (actorId === null) throw gatewayError("INVALID_ACTOR_CONTEXT");
        if (typeof operation !== "function")
            throw gatewayError("INVALID_TRANSACTION_OPERATION");

        let stage = "TRANSACTION_FAILED";
        try {
            return await getPrisma().$transaction(
                async (tx) => {
                    stage = "ACTOR_CONTEXT_FAILED";
                    const actorText = String(actorId);
                    const result = await tx.$queryRaw`
                        SELECT set_config('im101.actor_id', ${actorText}, true) AS "actorId"
                    `;
                    if (
                        !Array.isArray(result) ||
                        result.length !== 1 ||
                        result[0]?.actorId !== actorText
                    )
                        throw gatewayError("ACTOR_CONTEXT_FAILED");

                    stage = "TRANSACTION_CALLBACK_FAILED";
                    const value = await operation(tx);
                    // COMMIT is managed by Prisma after this callback returns.
                    stage = "TRANSACTION_FAILED";
                    return value;
                },
                {
                    isolationLevel: "Serializable",
                    maxWait: 10000,
                    timeout: 15000,
                },
            );
        } catch (error) {
            // Never retain driver/callback messages, metadata or causes. A failure
            // does not prove rollback or rule out an uncertain COMMIT outcome.
            throw gatewayError(reservationErrorCode(error) || stage);
        }
    };
}

module.exports = { createReservationTransaction };
