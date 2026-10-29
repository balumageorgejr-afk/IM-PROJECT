const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
    validateReservationCreation,
} = require("../src/reservation-validation");

const fields = ["facilityId", "purpose", "startDatetime", "endDatetime"];
const original = {
    facilityId: 71,
    purpose: "  Fixture planning meeting  ",
    startDatetime: "2027-01-15T09:00:00+08:00",
    endDatetime: "2027-01-15T10:00:00+08:00",
};
const payload = (patch = {}) => ({ ...original, ...patch });
const secret = "PRIVATE-REQUEST-SENTINEL";
function valid(input, expected = {}) {
    const result = validateReservationCreation(input);
    assert.equal(result.success, true);
    assert.deepEqual(Object.keys(result).sort(), ["data", "success"]);
    assert.deepEqual(Object.keys(result.data).sort(), fields.slice().sort());
    for (const [key, value] of Object.entries(expected))
        assert.equal(result.data[key], value);
    return result.data;
}
function invalid(input, field, code) {
    const result = validateReservationCreation(input);
    assert.equal(result.success, false);
    assert.deepEqual(Object.keys(result).sort(), ["errors", "success"]);
    assert.ok(
        result.errors.some(
            (error) => error.field === field && error.code === code,
        ),
    );
    for (const error of result.errors) {
        assert.deepEqual(Object.keys(error).sort(), ["code", "field"]);
        assert.ok(["body", ...fields].includes(error.field));
    }
    assert.ok(!JSON.stringify(result).includes(secret));
    return result;
}

test("valid creation input returns only normalized fields in a fresh object", () => {
    assert.deepEqual(valid(payload()), {
        facilityId: 71,
        purpose: "Fixture planning meeting",
        startDatetime: "2027-01-15T01:00:00.000Z",
        endDatetime: "2027-01-15T02:00:00.000Z",
    });
});

test("each required field is mandatory; missing and undefined fields return fixed errors", () => {
    for (const field of fields) {
        const input = payload();
        delete input[field];
        invalid(input, field, "REQUIRED");
        invalid(payload({ [field]: undefined }), field, "REQUIRED");
    }
    assert.deepEqual(validateReservationCreation({}), {
        success: false,
        errors: fields.map((field) => ({ field, code: "REQUIRED" })),
    });
});

test("forbidden IDs, client actors, statuses, nested equipment and arbitrary keys are never echoed or accepted", () => {
    for (const key of [
        "reservationId",
        "requestedBy",
        "approvedBy",
        "statusId",
        "createdAt",
        "equipmentItems",
        "equipment",
        "include",
        secret,
        "__proto__",
        "constructor",
        "toJSON",
    ]) {
        const input = payload();
        Object.defineProperty(input, key, {
            value: { password: secret },
            enumerable: true,
        });
        assert.deepEqual(invalid(input, "body", "UNEXPECTED_FIELDS"), {
            success: false,
            errors: [{ field: "body", code: "UNEXPECTED_FIELDS" }],
        });
    }
});

test("null, arrays, primitives, Date values and custom prototypes are not JSON-style payloads", () => {
    for (const input of [
        null,
        undefined,
        [],
        [payload()],
        true,
        false,
        0,
        1,
        "",
        secret,
        () => {},
        1n,
        new Date(),
        new String(secret),
        Object.create(payload()),
        Object.assign(Object.create({ requestedBy: 88 }), payload()),
    ]) {
        invalid(input, "body", "INVALID_PAYLOAD");
    }
    const input = Object.assign(Object.create(null), payload());
    valid(input);
});

test("accessors, hidden fields, symbols and hostile proxies fail safely without invoking getters or serialization", () => {
    let invoked = 0;
    const input = payload();
    Object.defineProperty(input, "purpose", {
        get() {
            invoked++;
            throw new Error(secret);
        },
        enumerable: true,
    });
    invalid(input, "body", "INVALID_PAYLOAD");
    const hidden = payload();
    Object.defineProperty(hidden, "purpose", {
        value: secret,
        enumerable: false,
    });
    invalid(hidden, "body", "INVALID_PAYLOAD");
    const symbol = payload();
    symbol[Symbol(secret)] = secret;
    invalid(symbol, "body", "UNEXPECTED_FIELDS");
    const serialized = payload({
        toJSON: () => {
            invoked++;
            return { password: secret };
        },
    });
    invalid(serialized, "body", "UNEXPECTED_FIELDS");
    for (const trap of [
        "getPrototypeOf",
        "ownKeys",
        "getOwnPropertyDescriptor",
    ]) {
        const proxy = new Proxy(payload(), {
            [trap]: () => {
                throw new Error(secret);
            },
        });
        assert.doesNotThrow(() => invalid(proxy, "body", "INVALID_PAYLOAD"));
    }
    assert.equal(invoked, 0);
});

test("facilityId accepts only positive numeric integers within PostgreSQL int range", () => {
    for (const facilityId of [1, 71, 2147483647])
        valid(payload({ facilityId }), { facilityId });
    for (const facilityId of [
        0,
        -0,
        -1,
        1.5,
        1 + Number.EPSILON,
        2147483648,
        Number.MAX_SAFE_INTEGER,
        NaN,
        Infinity,
        -Infinity,
        "1",
        "71",
        null,
        true,
        false,
        [],
        {},
        new Number(1),
        1n,
    ]) {
        invalid(payload({ facilityId }), "facilityId", "INVALID_FACILITY_ID");
    }
});

test("purpose is trimmed but never coerced or silently truncated", () => {
    for (const purpose of ["", " ", "\t\n\r", "\u00a0\u2003", "\ufeff"])
        invalid(payload({ purpose }), "purpose", "INVALID_PURPOSE");
    for (const purpose of [null, [], {}, 1, 0, true, false, new String(secret)])
        invalid(payload({ purpose }), "purpose", "INVALID_PURPOSE");
    valid(payload({ purpose: "\t \n Fixture meeting \r\n" }), {
        purpose: "Fixture meeting",
    });
    for (const count of [254, 255])
        valid(
            payload({ purpose: " a".slice(0, 1) + "x".repeat(count) + "  " }),
            { purpose: "x".repeat(count) },
        );
    invalid(
        payload({ purpose: "x".repeat(256) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
    invalid(
        payload({ purpose: secret.repeat(20) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
});

test("Unicode limits count code points, including combining sequences and ZWJ components", () => {
    const emoji = String.fromCodePoint(0x1f600);
    for (const count of [254, 255])
        valid(payload({ purpose: emoji.repeat(count) }), {
            purpose: emoji.repeat(count),
        });
    invalid(
        payload({ purpose: emoji.repeat(256) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
    valid(payload({ purpose: "漢".repeat(255) }));
    invalid(
        payload({ purpose: "漢".repeat(256) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
    const combining = "e\u0301";
    valid(payload({ purpose: combining.repeat(127) + "x" }), {
        purpose: combining.repeat(127) + "x",
    });
    invalid(
        payload({ purpose: combining.repeat(128) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
    const family =
        String.fromCodePoint(0x1f468) +
        "\u200d" +
        String.fromCodePoint(0x1f469) +
        "\u200d" +
        String.fromCodePoint(0x1f467) +
        "\u200d" +
        String.fromCodePoint(0x1f466);
    assert.equal([...family].length, 7);
    valid(payload({ purpose: family.repeat(36) + "abc" }));
    invalid(
        payload({ purpose: family.repeat(37) }),
        "purpose",
        "PURPOSE_TOO_LONG",
    );
    valid(payload({ purpose: "é" }), { purpose: "é" });
    valid(payload({ purpose: combining }), { purpose: combining });
});

test("unpaired surrogates and remaining control characters are rejected as malformed purpose text", () => {
    for (const purpose of [
        "\ud800",
        "\udc00",
        "a\ud800b",
        "a\u0000b",
        "a\nb",
        "a\tb",
        "a\u007fb",
        "a\u0085b",
        "a\u009fb",
    ])
        invalid(payload({ purpose }), "purpose", "INVALID_PURPOSE");
});

test("UTC timestamps normalize optional fractions exactly to milliseconds", () => {
    for (const [suffix, normalized] of [
        ["Z", ".000Z"],
        [".1Z", ".100Z"],
        [".12Z", ".120Z"],
        [".123Z", ".123Z"],
        [".000Z", ".000Z"],
    ]) {
        valid(payload({ startDatetime: "2027-01-15T01:00:00" + suffix }), {
            startDatetime: "2027-01-15T01:00:00" + normalized,
        });
    }
});

test("valid numeric offsets preserve the instant across day, month, year and fractional-minute boundaries", () => {
    for (const [input, expected] of [
        ["2027-01-15T09:00:00+08:00", "2027-01-15T01:00:00.000Z"],
        ["2027-01-14T20:00:00-05:00", "2027-01-15T01:00:00.000Z"],
        ["2027-01-15T06:30:00+05:30", "2027-01-15T01:00:00.000Z"],
        ["2027-01-15T06:45:00+05:45", "2027-01-15T01:00:00.000Z"],
        ["2027-01-15T10:45:00+09:45", "2027-01-15T01:00:00.000Z"],
        ["2027-01-15T01:00:00+00:00", "2027-01-15T01:00:00.000Z"],
        ["2027-01-01T00:30:00+01:00", "2026-12-31T23:30:00.000Z"],
        ["2026-12-31T23:30:00-01:00", "2027-01-01T00:30:00.000Z"],
        ["2024-03-01T00:00:00+00:01", "2024-02-29T23:59:00.000Z"],
        ["2027-01-15T00:00:00+23:59", "2027-01-14T00:01:00.000Z"],
        ["2027-01-14T00:00:00-23:59", "2027-01-14T23:59:00.000Z"],
        ["2027-01-15T00:00:00.001-00:01", "2027-01-15T00:01:00.001Z"],
    ]) {
        valid(
            payload({
                startDatetime: input,
                endDatetime: "9999-12-31T23:59:59.999Z",
            }),
            { startDatetime: expected },
        );
    }
});

test("equivalent timezone spellings normalize identically and adjacent requests do not acquire buffers", () => {
    const first = valid(payload());
    const equivalent = valid(
        payload({
            startDatetime: "2027-01-14T20:00:00-05:00",
            endDatetime: "2027-01-15T02:00:00Z",
        }),
    );
    assert.deepEqual(first, equivalent);
    const adjacent = valid(
        payload({
            startDatetime: "2027-01-15T10:00:00+08:00",
            endDatetime: "2027-01-15T03:00:00Z",
        }),
    );
    assert.equal(first.endDatetime, adjacent.startDatetime);
});

test("Gregorian calendar validation rejects rollover dates and applies century leap-year rules", () => {
    for (const startDatetime of [
        "2024-02-29T00:00:00Z",
        "2000-02-29T00:00:00Z",
        "2400-02-29T00:00:00Z",
    ])
        valid(payload({ startDatetime, endDatetime: "2500-01-01T00:00:00Z" }));
    for (const date of [
        "2023-02-29",
        "1900-02-29",
        "2100-02-29",
        "2024-02-30",
        "2027-04-31",
        "2027-06-31",
        "2027-11-31",
        "2027-00-01",
        "2027-13-01",
        "2027-01-00",
        "2027-01-32",
    ]) {
        for (const field of ["startDatetime", "endDatetime"])
            invalid(
                payload({ [field]: date + "T00:00:00Z" }),
                field,
                "INVALID_TIMESTAMP",
            );
    }
});

test("impossible times and invalid numeric offsets never roll over into valid instants", () => {
    for (const time of [
        "24:00:00Z",
        "25:00:00Z",
        "23:60:00Z",
        "23:59:60Z",
        "00:00:99Z",
        "00:00:00+24:00",
        "00:00:00-24:00",
        "00:00:00+99:00",
        "00:00:00+08:60",
        "00:00:00-08:60",
        "00:00:00-00:00",
    ]) {
        for (const field of ["startDatetime", "endDatetime"])
            invalid(
                payload({ [field]: "2027-01-15T" + time }),
                field,
                "INVALID_TIMESTAMP",
            );
    }
});

test("timezone-free, malformed and nonstring timestamps are rejected without coercion", () => {
    for (const value of [
        null,
        false,
        true,
        0,
        [],
        {},
        new Date(),
        new String(secret),
        secret,
        "2027-01-15",
        "2027-01-15T01:00:00",
        "2027-01-15T01:00",
        "2027-01-15T01:00Z",
        "2027-01-15 01:00:00Z",
        "2027-1-15T01:00:00Z",
        "2027-01-5T01:00:00Z",
        "2027-01-15T1:00:00Z",
        "2027-01-15T01:0:00Z",
        "2027-01-15t01:00:00Z",
        "2027-01-15T01:00:00z",
        "2027-01-15T01:00:00+0800",
        "2027-01-15T01:00:00+08",
        "2027-01-15T01:00:00UTC",
        "2027-01-15T01:00:00+08:00[Asia/Manila]",
        "2027-01-15T01:00:00+8:00",
        "2027-01-15T01:00:00.Z",
        "2027-01-15T01:00:00,123Z",
        "20270115T010000Z",
        "2027-W03-5T01:00:00Z",
        " 2027-01-15T01:00:00Z",
        "2027-01-15T01:00:00Z ",
        "2027-01-15T01:00:00Z\n",
        "2027-01-15T01:00:00Z\r\n",
        "2027-01-15T01:00:00Z" + secret,
    ]) {
        for (const field of ["startDatetime", "endDatetime"])
            invalid(payload({ [field]: value }), field, "INVALID_TIMESTAMP");
    }
});

test("excess precision including all-zero excess digits is rejected without truncation", () => {
    for (const suffix of [
        ".1234Z",
        ".123456Z",
        ".0000Z",
        ".123456789Z",
        ".123456+08:00",
        ".999999-05:00",
        "." + "0".repeat(1000) + "Z",
    ]) {
        for (const field of ["startDatetime", "endDatetime"])
            invalid(
                payload({ [field]: "2027-01-15T01:00:00" + suffix }),
                field,
                "TIMESTAMP_PRECISION",
            );
    }
});

test("UTC year range is explicit and years 0001-0099 are never remapped to the twentieth century", () => {
    valid(
        payload({
            startDatetime: "0001-01-01T00:00:00Z",
            endDatetime: "0099-12-31T23:59:59.999Z",
        }),
        {
            startDatetime: "0001-01-01T00:00:00.000Z",
            endDatetime: "0099-12-31T23:59:59.999Z",
        },
    );
    valid(
        payload({
            startDatetime: "9999-12-31T23:59:59.998Z",
            endDatetime: "9999-12-31T23:59:59.999Z",
        }),
    );
    for (const value of [
        "0000-01-01T00:00:00Z",
        "0001-01-01T00:00:00+00:01",
        "9999-12-31T23:59:59.999-00:01",
    ]) {
        for (const field of ["startDatetime", "endDatetime"])
            invalid(payload({ [field]: value }), field, "TIMESTAMP_RANGE");
    }
    invalid(
        payload({ startDatetime: "+010000-01-01T00:00:00Z" }),
        "startDatetime",
        "INVALID_TIMESTAMP",
    );
});

test("ordering uses normalized instants: equal, timezone-equivalent and reversed ranges fail", () => {
    for (const [startDatetime, endDatetime] of [
        ["2027-01-15T01:00:00Z", "2027-01-15T01:00:00Z"],
        ["2027-01-15T09:00:00+08:00", "2027-01-15T01:00:00Z"],
        ["2027-01-15T09:00:00+08:00", "2027-01-15T00:59:59.999Z"],
        ["2027-01-14T23:00:00-05:00", "2027-01-15T10:00:00+08:00"],
    ])
        invalid(
            payload({ startDatetime, endDatetime }),
            "endDatetime",
            "INVALID_TIME_ORDER",
        );
    valid(
        payload({
            startDatetime: "2027-01-15T09:00:00.001+08:00",
            endDatetime: "2027-01-15T01:00:00.002Z",
        }),
    );
});

test("past dates, long durations and distant horizons pass without unapproved policy enforcement", () => {
    valid(
        payload({
            startDatetime: "1900-01-01T00:00:00Z",
            endDatetime: "1900-01-02T00:00:00Z",
        }),
    );
    valid(
        payload({
            startDatetime: "2020-01-01T00:00:00Z",
            endDatetime: "9999-12-31T23:59:59.999Z",
        }),
    );
});

test("frozen payloads are not mutated on success or failure and normalized results share no mutable request data", () => {
    const input = Object.freeze(payload());
    const before = { ...input };
    const data = valid(input);
    assert.deepEqual(input, before);
    assert.notEqual(data, input);
    data.purpose = "Changed result";
    assert.deepEqual(input, before);
    const bad = Object.freeze(
        payload({ facilityId: "71", purpose: "x".repeat(256) }),
    );
    const prior = { ...bad };
    invalid(bad, "facilityId", "INVALID_FACILITY_ID");
    assert.deepEqual(bad, prior);
});

test("errors contain only fixed field/code identifiers with no rejected values or partial data", () => {
    const input = payload({
        facilityId: secret,
        purpose: secret.repeat(20),
        startDatetime: secret,
        endDatetime: secret,
    });
    const result = invalid(input, "facilityId", "INVALID_FACILITY_ID");
    assert.deepEqual(result, {
        success: false,
        errors: [
            { field: "facilityId", code: "INVALID_FACILITY_ID" },
            { field: "purpose", code: "PURPOSE_TOO_LONG" },
            { field: "startDatetime", code: "INVALID_TIMESTAMP" },
            { field: "endDatetime", code: "INVALID_TIMESTAMP" },
        ],
    });
});

test("the validator loads and runs without imports, database/network/filesystem access, environment or wall-clock reads", () => {
    let imports = 0,
        external = 0;
    class PureDate extends Date {
        constructor(...args) {
            assert.ok(args.length > 0);
            super(...args);
        }
        static now() {
            external++;
            throw new Error(secret);
        }
    }
    const context = vm.createContext({
        module: { exports: {} },
        Date: PureDate,
        require: () => {
            imports++;
            throw new Error(secret);
        },
        fetch: () => {
            external++;
            throw new Error(secret);
        },
        console: {
            log: () => {
                external++;
                throw new Error(secret);
            },
            error: () => {
                external++;
                throw new Error(secret);
            },
        },
        fixture: JSON.stringify(original),
    });
    vm.runInContext(
        fs.readFileSync("src/reservation-validation.js", "utf8"),
        context,
    );
    const result = vm.runInContext(
        "module.exports.validateReservationCreation(JSON.parse(fixture))",
        context,
    );
    assert.equal(result.success, true);
    assert.equal(result.data.startDatetime, "2027-01-15T01:00:00.000Z");
    assert.equal(imports, 0);
    assert.equal(external, 0);
});
