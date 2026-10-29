const { test } = require("node:test");
const assert = require("node:assert/strict");
const c = require("../src/core-support");
const { items } = require("../src/loans");
test("core structural input rejects identity overrides malformed dates and unbounded queries", () => {
    for (const value of [
        null,
        [],
        { userId: 1 },
        { dueDate: "date", items: [], approvedBy: 1 },
    ])
        assert.throws(() => c.body(value, ["dueDate", "items"]));
    for (const value of ["0", "-1", "01", "1.2", "2147483648", "abc"])
        assert.throws(() => c.id(value));
    for (const value of ["2026-02-30", "2025-02-29", "2026-1-01"])
        assert.throws(() => c.day(value));
    assert.equal(c.day("2028-02-29").toISOString(), "2028-02-29T00:00:00.000Z");
    for (const query of [{ limit: "101" }, { page: "0" }, { userId: "2" }])
        assert.throws(() => c.pagination(query));
    assert.equal(
        c.timestamp("2028-01-01T08:00:00+08:00").toISOString(),
        "2028-01-01T00:00:00.000Z",
    );
});
test("loan junction validation preserves quantities rejects duplicates and client condition overrides", () => {
    assert.deepEqual(
        items([
            { equipmentId: 2, quantity: 1 },
            { equipmentId: 1, quantity: 3 },
        ]),
        [
            { equipmentId: 1, quantity: 3 },
            { equipmentId: 2, quantity: 1 },
        ],
    );
    for (const value of [
        [],
        [{ equipmentId: 1, quantity: 0 }],
        [{ equipmentId: 1, quantity: "1" }],
        [
            { equipmentId: 1, quantity: 1 },
            { equipmentId: 1, quantity: 1 },
        ],
        [{ equipmentId: 1, quantity: 1, conditionOut: "Good" }],
    ])
        assert.throws(() => items(value));
    assert.deepEqual(
        items([{ equipmentId: 1, conditionIn: "Damaged" }], true),
        [{ equipmentId: 1, conditionIn: "Damaged" }],
    );
    assert.throws(() =>
        items([{ equipmentId: 1, conditionIn: "Unknown" }], true),
    );
});

test("maintenance notes allow line breaks but reject unsafe controls and malformed Unicode", () => {
    assert.equal(
        c.text(" First line\nSecond line ", 100, true),
        "First line\nSecond line",
    );
    assert.throws(() => c.text("a\u0000b", 100, true));
    assert.throws(() => c.text("\ud800", 100, true));
    assert.throws(() => c.text("x".repeat(101), 100, true));
});
