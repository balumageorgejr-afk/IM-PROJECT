const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { randomBytes } = require("node:crypto");
const { createApp } = require("../src/app");
const { reservationErrorCode } = require("../src/reservation-errors");
const roleNames = [
    "System Administrator",
    "Facility/Maintenance Staff",
    "Faculty / Student Organization Representative",
];
const range = "from=2027-01-01T00%3A00%3A00Z&to=2027-02-01T00%3A00%3A00Z";
const slot = {
    facilityId: 30,
    facility: { facilityName: "Shared Hall", privateValue: "SECRET" },
    status: { statusName: "Approved" },
    startDatetime: new Date("2027-01-02T01:00Z"),
    endDatetime: new Date("2027-01-02T02:00Z"),
    purpose: "SECRET",
    requestedBy: 777,
    reservationId: 1,
};
async function setup(t) {
    const secret = randomBytes(48).toString("hex");
    let rows = [slot],
        active = true,
        fail = false;
    const calls = [];
    const app = createApp({
        jwtSecret: secret,
        getPrisma: () => ({
            user: {
                findUnique: async ({ where }) => ({
                    userId: where.userId,
                    isActive: active,
                    role: {
                        roleName: roleNames[where.userId - 1] || "Unsupported",
                    },
                }),
            },
            reservation: {
                findMany: async (query) => {
                    calls.push(query);
                    if (fail) throw Error("SECRET SQL credentials");
                    return rows;
                },
            },
        }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    async function request(query = range, actor = 3) {
        const token = actor
            ? jwt.sign({}, secret, {
                  subject: String(actor),
                  issuer: "im101-api",
                  audience: "im101-client",
                  algorithm: "HS256",
                  expiresIn: 900,
              })
            : null;
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/api/reservation-availability?${query}`,
            { headers: token ? { Authorization: "Bearer " + token } : {} },
        );
        return {
            status: response.status,
            body: await response.json(),
            headers: response.headers,
        };
    }
    return {
        request,
        calls,
        setRows: (value) => {
            rows = value;
        },
        inactive: () => {
            active = false;
        },
        fail: () => {
            fail = true;
        },
    };
}
test("availability admits all three roles, queries campus-wide scope and projects only safe slot fields", async (t) => {
    const s = await setup(t);
    for (const actor of [1, 2, 3]) {
        const r = await s.request(range + "&facilityId=30", actor);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("cache-control"), "no-store");
        assert.deepEqual(r.body.availability, [
            {
                facilityId: 30,
                facilityName: "Shared Hall",
                status: "Approved",
                startDatetime: slot.startDatetime.toISOString(),
                endDatetime: slot.endDatetime.toISOString(),
            },
        ]);
        assert.doesNotMatch(
            JSON.stringify(r.body),
            /SECRET|requestedBy|reservationId|purpose/,
        );
    }
    const query = s.calls[0];
    assert.deepEqual(query.where, {
        facilityId: 30,
        status: { statusName: { in: ["Pending", "Approved"] } },
        startDatetime: { lt: "2027-02-01T00:00:00.000Z" },
        endDatetime: { gt: "2027-01-01T00:00:00.000Z" },
    });
    assert.deepEqual(Object.keys(query.select).sort(), [
        "endDatetime",
        "facility",
        "facilityId",
        "startDatetime",
        "status",
    ]);
    assert.deepEqual(query.orderBy, { reservationId: "asc" });
    assert.equal(query.take, 101);
    assert.equal(query.skip, 0);
});
test("availability requires active authentication and approved RBAC", async (t) => {
    const s = await setup(t);
    assert.equal((await s.request(range, null)).status, 401);
    assert.equal((await s.request(range, 4)).status, 403);
    s.inactive();
    assert.equal((await s.request()).status, 401);
    assert.equal(s.calls.length, 0);
});
test("availability validates bounded range facility and pagination before querying", async (t) => {
    const s = await setup(t);
    for (const query of [
        "",
        range + "&page=0",
        range + "&page=101",
        range + "&limit=101",
        range + "&limit=2.5",
        range + "&facilityId=0",
        range + "&facilityId=2147483648",
        range + "&requestedBy=9",
        range + "&status=Rejected",
        "from=2027-02-30T00:00:00Z&to=2027-03-02T00:00:00Z",
        "from=2027-01-01T00:00:00&to=2027-01-02T00:00:00Z",
        "from=2027-01-01T00:00:00Z&to=2027-03-01T00:00:00Z",
        "from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z",
    ])
        assert.equal((await s.request(query)).status, 400);
    assert.equal(s.calls.length, 0);
});
test("availability handles Pending empty partial pages and errors without writes or details", async (t) => {
    const s = await setup(t);
    s.setRows([]);
    assert.deepEqual((await s.request()).body.availability, []);
    s.setRows(Array(3).fill({ ...slot, status: { statusName: "Pending" } }));
    const r = await s.request(range + "&page=2&limit=2");
    assert.equal(r.body.availability.length, 2);
    assert.equal(r.body.pagination.hasMore, true);
    assert.equal(r.body.availability[0].status, "Pending");
    assert.equal(s.calls.at(-1).skip, 2);
    s.fail();
    const failed = await s.request();
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failed.body), /SECRET|SQL|credentials/);
});
test("only the exact database overlap acknowledgement receives the schedule-specific code", () => {
    for (const error of [
        { code: "R4091", message: "Reservation schedule conflict." },
        {
            code: "P2010",
            meta: {
                driverAdapterError: {
                    cause: {
                        originalCode: "R4091",
                        originalMessage: "Reservation schedule conflict.",
                    },
                },
            },
        },
    ])
        assert.equal(
            reservationErrorCode(error),
            "RESERVATION_SCHEDULE_CONFLICT",
        );
    for (const code of ["R4091", "40001", "40P01", "P2034"])
        assert.equal(
            reservationErrorCode({ code, message: "PRIVATE error" }),
            "RESERVATION_CONFLICT",
        );
    assert.equal(
        reservationErrorCode({
            code: "40001",
            message: "Reservation schedule conflict.",
        }),
        "RESERVATION_CONFLICT",
    );
});
