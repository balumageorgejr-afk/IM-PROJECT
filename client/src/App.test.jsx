import React from "react";
import { test, expect, vi } from "vitest";
import {
    render,
    screen,
    fireEvent,
    waitFor,
    within,
    act,
} from "@testing-library/react";
import App from "./App";
import { SessionProvider, roles } from "./session";
import { createApi } from "./api";
import { Editor } from "./components";
function setup(role = roles[2], id = 301) {
    const user = {
        userId: id,
        fname: "Fixture",
        lname: "User",
        email: "fixture@example.test",
        role: { roleId: 33, roleName: role },
    };
    const rows = {
        buildings: [],
        facilities: [
            {
                facilityId: 30,
                buildingId: 1,
                facilityName: "Fixture hall",
                capacity: 20,
                status: "Available",
            },
        ],
        equipment: [
            {
                equipmentId: 101,
                equipmentName: "Fixture projector",
                totalQuantity: 5,
                availableQuantity: 5,
            },
        ],
        reservations: [],
        loans: [],
        maintenanceRequests: [],
        assignments: [],
        facilityTypes: [],
        equipmentCategories: [],
        staff: [{ userId: 201, fname: "Fixture", lname: "Staff" }],
    };
    const calls = [];
    let denyFacilities = false,
        deferWrite = null;
    const fetchImpl = vi.fn(async (url, options) => {
        calls.push({ url, options });
        const path = new URL(url, "http://fixture.test").pathname.replace(
            "/api",
            "",
        );
        let result;
        if (path === "/auth/login")
            result = { token: "synthetic-token", expiresIn: 900 };
        else if (path === "/auth/me") result = { user };
        else if (
            options.method === "GET" &&
            /^\/reservations\/\d+$/.test(path)
        ) {
            const reservation = rows.reservations.find(
                (row) => row.reservationId === Number(path.split("/")[2]),
            );
            if (!reservation) throw Error("Unexpected fixture reservation");
            result = { reservation };
        } else if (path === "/overview")
            result = {
                overview: {
                    buildings: rows.buildings.length,
                    facilities: rows.facilities.length,
                    equipment: 0,
                    reservations: rows.reservations.length,
                    loans: 0,
                    maintenance: 0,
                },
            };
        else if (path === "/reservation-statuses")
            result = {
                reservationStatuses: [
                    { statusId: 17, statusName: "Pending" },
                    { statusId: 29, statusName: "Approved" },
                    { statusId: 41, statusName: "Rejected" },
                    { statusId: 53, statusName: "Cancelled" },
                ],
            };
        else if (path === "/facilities" && denyFacilities)
            return {
                ok: false,
                status: 401,
                json: async () => ({ success: false }),
            };
        else if (options.method === "POST" && path === "/reservations") {
            if (deferWrite) await deferWrite;
            const reservation = {
                reservationId: 77,
                requestedBy: id,
                approvedBy: null,
                statusId: 17,
                ...JSON.parse(options.body),
                createdAt: new Date().toISOString(),
            };
            rows.reservations.push(reservation);
            result = { reservation };
        } else if (
            options.method === "POST" &&
            ["/loans", "/maintenance", "/assignments", "/buildings"].includes(
                path,
            )
        ) {
            const input = JSON.parse(options.body);
            const schema = {
                "/loans": ["loans", "loan", "loanId"],
                "/maintenance": [
                    "maintenanceRequests",
                    "maintenanceRequest",
                    "requestId",
                ],
                "/assignments": ["assignments", "assignment", "assignmentId"],
                "/buildings": ["buildings", "building", "buildingId"],
            }[path];
            const record = {
                [schema[2]]: 55,
                ...input,
                ...(path === "/loans"
                    ? { userId: id, loanStatus: "Pending" }
                    : {}),
            };
            rows[schema[0]].push(record);
            result = { [schema[1]]: record };
        } else if (
            /^\/loans\/\d+\/return$/.test(path) &&
            options.method === "POST"
        ) {
            const record = rows.loans.find(
                (row) => row.loanId === Number(path.split("/")[2]),
            );
            record.loanStatus = "Returned";
            result = { loan: record };
        } else if (
            options.method === "POST" &&
            /^\/reservations\/\d+\/(approve|reject|cancel)$/.test(path)
        ) {
            const [, , id, action] = path.split("/");
            const record = rows.reservations.find(
                (row) => row.reservationId === Number(id),
            );
            record.statusId = { approve: 29, reject: 41, cancel: 53 }[action];
            result = { reservation: record };
        } else if (
            options.method === "POST" &&
            /^\/maintenance\/\d+\/(assign|progress)$/.test(path)
        ) {
            const [, , id, action] = path.split("/");
            const record = rows.maintenanceRequests.find(
                (row) => row.requestId === Number(id),
            );
            const input = JSON.parse(options.body);
            if (action === "assign") record.assignedStaffId = input.staffId;
            else record.status = input.status;
            result = { maintenanceRequest: record };
        } else if (path === "/reservation-availability") {
            result = {
                availability: rows.reservations
                    .filter((row) => [17, 29].includes(row.statusId))
                    .map((row) => ({
                        facilityId: row.facilityId,
                        facilityName: rows.facilities.find(
                            (facility) =>
                                facility.facilityId === row.facilityId,
                        )?.facilityName,
                        status: row.statusId === 29 ? "Approved" : "Pending",
                        startDatetime: row.startDatetime,
                        endDatetime: row.endDatetime,
                    })),
                pagination: { hasMore: false },
            };
        } else if (path === "/facility-types")
            result = { facilityTypes: rows.facilityTypes };
        else if (path === "/equipment-categories")
            result = { equipmentCategories: rows.equipmentCategories };
        else if (path === "/staff") result = { staff: rows.staff };
        else {
            const key =
                path === "/maintenance" ? "maintenanceRequests" : path.slice(1);
            if (!Object.hasOwn(rows, key))
                throw Error("Unexpected fixture route");
            result = { [key]: rows[key] };
        }
        return {
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                pagination: { page: 1, limit: 20, hasMore: false },
                ...result,
            }),
        };
    });
    const apiFactory = (options) => createApi({ ...options, fetchImpl });
    render(
        <SessionProvider apiFactory={apiFactory}>
            <App />
        </SessionProvider>,
    );
    return {
        calls,
        rows,
        user,
        setDenyFacilities(value) {
            denyFacilities = value;
        },
        deferWrite(value) {
            deferWrite = value;
        },
    };
}
async function login() {
    fireEvent.change(screen.getByLabelText("Campus email"), {
        target: { value: "fixture@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: "synthetic-password" },
    });
    fireEvent.click(
        screen.getByRole("button", { name: /Sign in to workspace/ }),
    );
    await screen.findByRole("heading", { name: /Welcome back, Fixture/ });
}
async function navigate(name) {
    const names = {
        Reservations: ["Reservations", "My Reservations"],
        "Equipment loans": ["Equipment Loans", "My Equipment Loans"],
        "Staff assignments": ["Staff Assignments", "My Assignments"],
        Facilities: ["Facilities", "Browse Facilities"],
        Equipment: ["Equipment", "Browse Equipment"],
        Maintenance: ["Maintenance", "Maintenance Tasks", "Report Maintenance"],
    }[name] || [name];
    const nav = within(screen.getByRole("navigation"));
    const link = names
        .map((label) => nav.queryByRole("link", { name: label, exact: true }))
        .find(Boolean);
    expect(link).toBeTruthy();
    fireEvent.click(link);
    await act(async () => {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
}
test("real session provider protects shell, exposes role navigation and clears memory on logout", async () => {
    const fixture = setup();
    expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
    ).toBeNull();
    await login();
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(
        screen.queryByRole("link", { name: "Staff Assignments" }),
    ).toBeNull();
    await navigate("Facilities");
    await screen.findByRole("heading", { name: "Browse Facilities" });
    expect(screen.queryByRole("button", { name: /Add building/ })).toBeNull();
    fireEvent.click(screen.getByText("Fixture User"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Welcome back" });
    expect(
        fixture.calls.some(
            (call) =>
                call.options.headers.Authorization === "Bearer synthetic-token",
        ),
    ).toBe(true);
    expect(localStorage.length).toBe(0);
});
test("signup links return to login and successful login opens the dashboard", async () => {
    setup();
    fireEvent.click(screen.getByRole("link", { name: "Sign Up" }));
    await act(async () =>
        window.dispatchEvent(new HashChangeEvent("hashchange")),
    );
    expect(
        await screen.findByRole("heading", { name: "Create an account" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Log In" }));
    await act(async () =>
        window.dispatchEvent(new HashChangeEvent("hashchange")),
    );
    await screen.findByRole("heading", { name: "Welcome back" });
    await login();
    expect(
        screen.queryByRole("heading", { name: "Page not found" }),
    ).toBeNull();
});

test.each([roles[1], roles[2]])(
    "direct account management navigation is restricted for %s",
    async (role) => {
        setup(role);
        await login();
        expect(
            screen.queryByRole("link", { name: "Account Management" }),
        ).toBeNull();
        await act(async () => {
            window.location.hash = "#/accounts";
            window.dispatchEvent(new HashChangeEvent("hashchange"));
        });
        expect(
            screen.getByRole("heading", { name: "Access restricted" }),
        ).toBeTruthy();
        expect(
            screen.queryByRole("button", { name: "Create staff account" }),
        ).toBeNull();
    },
);

test("administrator can open account management without access to existing passwords", async () => {
    setup(roles[0]);
    await login();
    await navigate("Account Management");
    expect(
        await screen.findByRole("heading", { name: "Account Management" }),
    ).toBeTruthy();
    expect(
        screen.getByRole("button", { name: "Create staff account" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Initial password").value).toBe("");
});

test("administrator has management controls and empty states contain no demo records", async () => {
    setup(roles[0], 101);
    await login();
    expect(
        screen.getByRole("link", { name: "Staff Assignments" }),
    ).toBeTruthy();
    await navigate("Buildings");
    await screen.findByRole("heading", { name: "Buildings" });
    await screen.findByText("Nothing here yet");
    expect(screen.getByRole("button", { name: /Add building/ })).toBeTruthy();
});

test("representative card browsing opens a preselected reservation without accepting actor overrides", async () => {
    setup();
    await login();
    await navigate("Facilities");
    const reserve = await screen.findByRole("button", {
        name: "Reserve space",
    });
    fireEvent.click(reserve);
    const dialog = await screen.findByRole("dialog");
    expect(
        within(dialog).getByRole("combobox", { name: "Facility" }).value,
    ).toBe("30");
    expect(
        within(dialog).queryByLabelText(/requester|approver|status/i),
    ).toBeNull();
    expect(within(dialog).getByText(/Pending until/)).toBeTruthy();
});

test("search is explicitly page-local and never sends unsupported API search parameters", async () => {
    const fixture = setup();
    await login();
    await navigate("Facilities");
    await screen.findByRole("button", { name: "Reserve space" });
    fireEvent.change(
        screen.getByRole("searchbox", { name: "Search this page" }),
        { target: { value: "NoSuchSpace" } },
    );
    await screen.findByText("No matches on this page");
    expect(
        fixture.calls
            .filter((call) => call.url.startsWith("/api/facilities?"))
            .every(
                (call) =>
                    !call.url.includes("search=") && !call.url.includes("q="),
            ),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await screen.findByRole("button", { name: "Reserve space" });
});

test("administrator dashboard summarizes actual pending work rather than fabricated statistics", async () => {
    const fixture = setup(roles[0], 101);
    fixture.rows.reservations.push({
        reservationId: 7,
        requestedBy: 301,
        facilityId: 30,
        statusId: 17,
        purpose: "Review fixture",
        startDatetime: new Date(Date.now() + 86400000).toISOString(),
    });
    fixture.rows.loans.push({
        loanId: 9,
        userId: 301,
        loanStatus: "Pending",
        items: [{ equipmentId: 101, quantity: 1 }],
        dueDate: new Date(Date.now() + 86400000).toISOString(),
    });
    await login();
    const pending = await screen.findAllByText("Pending reservations");
    // The heading and metric share a meaningful label; inspect the metric link itself.
    expect(pending).toBeTruthy();
    const metric = screen
        .getAllByText("Pending reservations")
        .find((node) => node.closest("a.stat-card"));
    expect(metric.closest("a").textContent).toContain("1");
    expect(
        screen.getByText("Pending equipment loans").closest("a").textContent,
    ).toContain("1");
});
test("reservation form submits exactly four normalized fields once and re-fetches real data", async () => {
    const fixture = setup();
    await login();
    await navigate("Reservations");
    await screen.findByRole("heading", { name: "My Reservations" });
    fireEvent.click(screen.getByRole("button", { name: /Request a facility/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Facility/), {
        target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Purpose/), {
        target: { value: "Fixture event" },
    });
    const pad = (n) => String(n).padStart(2, "0");
    const local = (date) =>
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const start = local(new Date(Date.now() + 2 * 86400000)),
        end = local(new Date(Date.now() + 2 * 86400000 + 3600000));
    fireEvent.change(within(dialog).getByLabelText(/^Start date & time/), {
        target: { value: start },
    });
    fireEvent.change(within(dialog).getByLabelText(/^End date & time/), {
        target: { value: end },
    });
    let done;
    fixture.deferWrite(
        new Promise((resolve) => {
            done = resolve;
        }),
    );
    const submit = within(dialog).getByRole("button", {
        name: "Submit request",
    });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(submit.disabled).toBe(true));
    expect(
        fixture.calls.filter(
            (call) =>
                call.url === "/api/reservations" &&
                call.options.method === "POST",
        ),
    ).toHaveLength(1);
    await act(async () => done());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("Fixture event");
    const write = fixture.calls.find(
        (call) =>
            call.url === "/api/reservations" && call.options.method === "POST",
    );
    expect(JSON.parse(write.options.body)).toEqual({
        facilityId: 30,
        purpose: "Fixture event",
        startDatetime: new Date(start).toISOString(),
        endDatetime: new Date(end).toISOString(),
    });
    expect(
        fixture.calls.filter((call) =>
            call.url.startsWith("/api/reservations?"),
        ).length,
    ).toBeGreaterThan(1);
});
test("401 during navigation expires the session and hides previous records", async () => {
    const fixture = setup();
    await login();
    fixture.setDenyFacilities(true);
    await navigate("Facilities");
    await screen.findByRole("heading", { name: "Welcome back" });
    expect(screen.getByRole("status").textContent).toMatch(/session expired/i);
    expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
    ).toBeNull();
});
test("facility selector shows names while retaining the facility identity internally", () => {
    render(
        <Editor
            title="Fixture editor"
            fields={[["facilityId", "Facility", "number", "facilities"]]}
            catalogs={{
                facilities: [
                    {
                        facilityId: 30,
                        buildingId: 1,
                        facilityName: "Fixture hall",
                    },
                ],
            }}
            onSubmit={async () => {}}
            onClose={() => {}}
        />,
    );
    const option = screen.getByRole("option", { name: "Fixture hall" });
    expect(option.value).toBe("30");
});
test("uncertain mutations stay blocked and show reconciliation guidance without leaking diagnostics", async () => {
    const submit = vi.fn(async () => {
        throw Object.assign(Error("Refresh history before resubmitting."), {
            requiresRefresh: true,
        });
    });
    render(
        <Editor
            title="Confirm fixture"
            fields={[]}
            onSubmit={submit}
            onClose={() => {}}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Save changes" }).disabled).toBe(
        true,
    );
    expect(submit).toHaveBeenCalledTimes(1);
});

test("loan UI posts item quantities and due date without borrower overrides", async () => {
    const fixture = setup();
    await login();
    await navigate("Equipment loans");
    await screen.findByRole("heading", { name: "My Equipment Loans" });
    fireEvent.click(screen.getByRole("button", { name: /Request equipment/ }));
    const dialog = screen.getByRole("dialog");
    const dueDate = new Date(Date.now() + 5 * 86400000),
        pad = (n) => String(n).padStart(2, "0"),
        dueLocal = `${dueDate.getFullYear()}-${pad(dueDate.getMonth() + 1)}-${pad(dueDate.getDate())}T10:00`;
    fireEvent.change(within(dialog).getByLabelText(/^Due date & time/), {
        target: { value: dueLocal },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Equipment/), {
        target: { value: "101" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Quantity/), {
        target: { value: "2" },
    });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Submit request" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = fixture.calls.find(
        (call) => call.url === "/api/loans" && call.options.method === "POST",
    );
    expect(JSON.parse(call.options.body)).toEqual({
        dueDate: new Date(dueLocal).toISOString(),
        items: [{ equipmentId: 101, quantity: 2 }],
    });
});
test("maintenance UI sends one target and preserves multiline description", async () => {
    const fixture = setup();
    await login();
    await navigate("Maintenance");
    await screen.findByRole("heading", { name: "Report Maintenance" });
    fireEvent.click(screen.getByRole("button", { name: /Report an issue/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Facility/), {
        target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Target/), {
        target: { value: "equipmentId" },
    });
    expect(within(dialog).getByLabelText(/^Equipment/).value).toBe("");
    fireEvent.change(within(dialog).getByLabelText(/^Equipment/), {
        target: { value: "101" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Description/), {
        target: { value: "Fixture issue\nSecond line" },
    });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Submit request" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = fixture.calls.find(
        (call) =>
            call.url === "/api/maintenance" && call.options.method === "POST",
    );
    expect(JSON.parse(call.options.body)).toEqual({
        equipmentId: 101,
        description: "Fixture issue\nSecond line",
        priority: "Normal",
    });
});

test("dashboard and reservation table show named facilities and previews with full purpose in Details", async () => {
    const fixture = setup();
    const purpose =
        "Faculty forum\nDetailed seating and accessibility requirements.";
    fixture.rows.reservations.push({
        reservationId: 98,
        facilityId: 30,
        requestedBy: 301,
        statusId: 17,
        purpose,
        startDatetime: new Date(2027, 0, 2, 9, 5).toISOString(),
        endDatetime: new Date(2027, 0, 2, 10, 5).toISOString(),
    });
    await login();
    await screen.findByText(/Fixture hall · 01\/02\/2027 09:05 AM/);
    expect(screen.queryByText(purpose)).toBeNull();
    expect(document.body.textContent).not.toContain("Facility #30");
    await navigate("Reservations");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Fixture hall")).toBeTruthy();
    expect(within(table).getByText("Faculty forum")).toBeTruthy();
    expect(within(table).queryByText("30")).toBeNull();
    fireEvent.click(
        within(table).getByRole("button", { name: "View Details" }),
    );
    const details = await screen.findByRole("dialog");
    expect(details.querySelector(".full-purpose").textContent).toBe(purpose);
    expect(within(details).getByText("Fixture hall")).toBeTruthy();
    expect(details.textContent).not.toContain("Facility ID");
});

test("reservation section switches to safe campus availability while private details stay in the list", async () => {
    const fixture = setup();
    const now = new Date();
    for (const [id, statusId, purpose] of [
        [96, 29, "Approved workshop\nWorkshop full details"],
        [97, 17, "Pending workshop"],
    ])
        fixture.rows.reservations.push({
            reservationId: id,
            facilityId: 30,
            requestedBy: 301,
            statusId,
            purpose,
            startDatetime: new Date(
                now.getFullYear(),
                now.getMonth(),
                15,
                9,
            ).toISOString(),
            endDatetime: new Date(
                now.getFullYear(),
                now.getMonth(),
                15,
                10,
            ).toISOString(),
        });
    await login();
    await navigate("Reservations");
    fireEvent.click(
        await screen.findByRole("button", { name: "Availability calendar" }),
    );
    const event = await screen.findByRole("button", {
        name: /Confirmed booking.*Fixture hall/,
    });
    expect(
        screen.getByText("Campus-wide time slots; private details are hidden"),
    ).toBeTruthy();
    expect(screen.queryByText("Only your reservations are shown")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("Pending workshop")).toBeNull();
    fireEvent.click(event);
    const details = await screen.findByRole("dialog");
    expect(details.querySelector(".full-purpose")).toBeNull();
    expect(details.textContent).not.toContain("Workshop full details");
    expect(within(details).getByText("Approved")).toBeTruthy();
    fireEvent.click(
        within(details).getByRole("button", { name: "Close dialog" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await screen.findByRole("table");
    expect(
        fixture.calls
            .filter((call) => call.url.startsWith("/api/reservations?"))
            .every((call) => call.options.method === "GET"),
    ).toBe(true);
});
test("administrator assignment form uses eligible staff ID and approved role/shift fields", async () => {
    const fixture = setup(roles[0], 101);
    await login();
    await navigate("Staff assignments");
    await screen.findByRole("heading", { name: "Staff Assignments" });
    fireEvent.click(screen.getByRole("button", { name: /Create assignment/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Facility/), {
        target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Maintenance staff/), {
        target: { value: "201" },
    });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Submit request" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = fixture.calls.find(
        (call) =>
            call.url === "/api/assignments" && call.options.method === "POST",
    );
    expect(JSON.parse(call.options.body)).toEqual({
        facilityId: 30,
        staffId: 201,
        assignedRole: "Custodian",
        shift: null,
        assignedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
});
test("administrator records returns only after explicit dialog confirmation", async () => {
    const fixture = setup(roles[0], 101);
    fixture.rows.loans.push({
        loanId: 13,
        userId: 301,
        loanStatus: "Approved",
        dueDate: new Date().toISOString(),
        items: [{ equipmentId: 101, quantity: 2 }],
    });
    await login();
    await navigate("Equipment loans");
    await screen.findByRole("button", { name: "Return" });
    expect(
        fixture.calls.some(
            (call) =>
                call.options.method === "POST" && call.url.includes("/return"),
        ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Return" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), {
        target: { value: "Damaged" },
    });
    fireEvent.click(
        within(dialog).getByRole("button", { name: /Confirm record return/ }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const call = fixture.calls.find(
        (call) => call.url === "/api/loans/13/return",
    );
    expect(JSON.parse(call.options.body)).toEqual({
        items: [{ equipmentId: 101, conditionIn: "Damaged" }],
    });
});

test.each(["missing-workspace", "__proto__", "constructor"])(
    "unknown route %s is a not-found view rather than an inherited object property",
    async (route) => {
        setup();
        await login();
        window.location.hash = "#/" + route;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        await screen.findByRole("heading", { name: "Page not found" });
        expect(screen.queryByRole("dialog")).toBeNull();
    },
);

test("staff navigation and maintenance claim/progress use fixed endpoints and actor-safe bodies", async () => {
    const fixture = setup(roles[1], 201);
    fixture.rows.maintenanceRequests.push({
        requestId: 65,
        facilityId: 30,
        equipmentId: null,
        reportedBy: 201,
        assignedStaffId: null,
        description: "Synthetic local staff report",
        priority: "Normal",
        status: "Open",
    });
    fixture.rows.assignments.push({
        assignmentId: 9,
        facilityId: 30,
        staffId: 201,
        assignedRole: "Custodian",
        shift: "Day",
        assignedDate: "2026-01-01T00:00:00.000Z",
        unassignedDate: null,
    });
    await login();
    await navigate("Staff assignments");
    await screen.findByText("Custodian");
    expect(
        screen.queryByRole("button", { name: /Create assignment/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "End" })).toBeNull();
    await navigate("Maintenance");
    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull();
    fireEvent.click(
        await screen.findByRole("checkbox", { name: "Assigned to me" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Claim" }));
    fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
            name: "Confirm claim maintenance",
        }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
        JSON.parse(
            fixture.calls.find(
                (call) => call.url === "/api/maintenance/65/assign",
            ).options.body,
        ),
    ).toEqual({ staffId: 201 });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Maintenance action/), {
        target: { value: "Synthetic inspection" },
    });
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Confirm start work" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
        JSON.parse(
            fixture.calls.find(
                (call) => call.url === "/api/maintenance/65/progress",
            ).options.body,
        ),
    ).toEqual({ status: "In Progress", actionTaken: "Synthetic inspection" });
    await screen.findByRole("button", { name: "Resolve" });
});

test.each(["approve", "reject"])(
    "administrator %s requires confirmation and hides self-review",
    async (action) => {
        const fixture = setup(roles[0], 101);
        for (const [id, requestedBy] of [
            [70, 301],
            [71, 101],
        ])
            fixture.rows.reservations.push({
                reservationId: id,
                facilityId: 30,
                requestedBy,
                approvedBy: null,
                statusId: 17,
                purpose: "Synthetic request " + id,
                startDatetime: new Date(Date.now() + 86400000).toISOString(),
                endDatetime: new Date(Date.now() + 90000000).toISOString(),
                createdAt: new Date().toISOString(),
            });
        await login();
        await navigate("Reservations");
        const caption = action === "approve" ? "Approve" : "Reject";
        const button = await screen.findByRole("button", { name: caption });
        expect(screen.getAllByRole("button", { name: caption })).toHaveLength(
            1,
        );
        expect(
            fixture.calls.some((call) => call.url.endsWith("/" + action)),
        ).toBe(false);
        fireEvent.click(button);
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByRole("heading").textContent).toContain(
            "RES-000070",
        );
        fireEvent.click(
            within(dialog).getByRole("button", { name: "Confirm " + action }),
        );
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        const call = fixture.calls.find(
            (call) => call.url === "/api/reservations/70/" + action,
        );
        expect(call.options.method).toBe("POST");
        expect(JSON.parse(call.options.body)).toEqual({});
    },
);

test("representative cancellation preserves actor controls and direct assignment navigation is denied", async () => {
    const fixture = setup();
    fixture.rows.reservations.push({
        reservationId: 80,
        facilityId: 30,
        requestedBy: 301,
        statusId: 17,
        purpose: "Synthetic own request",
        startDatetime: new Date(Date.now() + 86400000).toISOString(),
        endDatetime: new Date(Date.now() + 90000000).toISOString(),
    });
    await login();
    await navigate("Reservations");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
            name: "Confirm cancel reservation",
        }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
        JSON.parse(
            fixture.calls.find(
                (call) => call.url === "/api/reservations/80/cancel",
            ).options.body,
        ),
    ).toEqual({});
    window.location.hash = "#/assignments";
    await act(async () =>
        window.dispatchEvent(new HashChangeEvent("hashchange")),
    );
    await screen.findByRole("heading", { name: "Access restricted" });
    expect(
        fixture.calls.some((call) => call.url.startsWith("/api/assignments")),
    ).toBe(false);
});
