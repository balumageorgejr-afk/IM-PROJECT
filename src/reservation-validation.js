const fields = ["facilityId", "purpose", "startDatetime", "endDatetime"];
const timestampPattern =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function failure(field, code) {
    return { success: false, errors: [{ field, code }] };
}

function parseTimestamp(value) {
    if (typeof value !== "string") return { code: "INVALID_TIMESTAMP" };
    const match = timestampPattern.exec(value);
    // JavaScript's $ can match before a final newline. Require the whole value.
    if (!match || match[0] !== value) return { code: "INVALID_TIMESTAMP" };
    const [
        ,
        yearText,
        monthText,
        dayText,
        hourText,
        minuteText,
        secondText,
        fraction = "",
        zone,
        sign,
        offsetHourText = "0",
        offsetMinuteText = "0",
    ] = match;
    if (fraction.length > 3) return { code: "TIMESTAMP_PRECISION" };
    const year = Number(yearText),
        month = Number(monthText),
        day = Number(dayText);
    const hour = Number(hourText),
        minute = Number(minuteText),
        second = Number(secondText);
    const offsetHour = Number(offsetHourText),
        offsetMinute = Number(offsetMinuteText);
    if (year === 0) return { code: "TIMESTAMP_RANGE" };
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > days[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59 ||
        zone === "-00:00"
    )
        return { code: "INVALID_TIMESTAMP" };

    // Calendar checks precede Date construction: never let Date silently repair
    // February 30 or 24:00. setUTCFullYear also avoids Date.UTC's 0-99 year remap.
    const wallTime = new Date(0);
    wallTime.setUTCFullYear(year, month - 1, day);
    wallTime.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, "0")));
    const offset = (offsetHour * 60 + offsetMinute) * (sign === "-" ? -1 : 1);
    const epoch = wallTime.getTime() - offset * 60000;
    const instant = new Date(epoch);
    if (instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999)
        return { code: "TIMESTAMP_RANGE" };
    return { value: instant.toISOString(), epoch };
}

function validatePayload(payload) {
    if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(payload))
    )
        return failure("body", "INVALID_PAYLOAD");
    if (Reflect.ownKeys(payload).some((field) => !fields.includes(field)))
        return failure("body", "UNEXPECTED_FIELDS");

    const input = {},
        errors = [];
    for (const field of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(payload, field);
        if (
            !descriptor ||
            (Object.hasOwn(descriptor, "value") &&
                descriptor.value === undefined)
        ) {
            errors.push({ field, code: "REQUIRED" });
            continue;
        }
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
            return failure("body", "INVALID_PAYLOAD");
        input[field] = descriptor.value;
    }
    const data = {};
    if (Object.hasOwn(input, "facilityId")) {
        if (
            !Number.isInteger(input.facilityId) ||
            input.facilityId <= 0 ||
            input.facilityId > 2147483647
        )
            errors.push({ field: "facilityId", code: "INVALID_FACILITY_ID" });
        else data.facilityId = input.facilityId;
    }
    if (Object.hasOwn(input, "purpose")) {
        if (typeof input.purpose !== "string" || !input.purpose.isWellFormed())
            errors.push({ field: "purpose", code: "INVALID_PURPOSE" });
        else {
            const purpose = input.purpose.trim();
            if (
                !purpose ||
                [...purpose].some((character) => {
                    const code = character.codePointAt(0);
                    return code < 32 || (code >= 127 && code <= 159);
                })
            )
                errors.push({ field: "purpose", code: "INVALID_PURPOSE" });
            else if ([...purpose].length > 255)
                errors.push({ field: "purpose", code: "PURPOSE_TOO_LONG" });
            else data.purpose = purpose;
        }
    }
    const timestamps = {};
    for (const field of ["startDatetime", "endDatetime"]) {
        if (!Object.hasOwn(input, field)) continue;
        const parsed = parseTimestamp(input[field]);
        if (parsed.code) errors.push({ field, code: parsed.code });
        else {
            data[field] = parsed.value;
            timestamps[field] = parsed.epoch;
        }
    }
    if (
        Object.hasOwn(timestamps, "startDatetime") &&
        Object.hasOwn(timestamps, "endDatetime") &&
        timestamps.startDatetime >= timestamps.endDatetime
    )
        errors.push({ field: "endDatetime", code: "INVALID_TIME_ORDER" });
    return errors.length ? { success: false, errors } : { success: true, data };
}

function validateReservationCreation(payload) {
    try {
        return validatePayload(payload);
    } catch {
        // Hostile proxies/reflection traps must not expose their thrown values.
        return failure("body", "INVALID_PAYLOAD");
    }
}

module.exports = { validateReservationCreation };
