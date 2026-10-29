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
import { roles } from "./session";
import { navigation, AppShell, DataTable, Profile } from "./ui";
import { Editor } from "./components";
import { formErrors } from "./form-validation";
import { dashboardHistory } from "./Dashboard";
import Calendar from "./ReservationCalendar";

test.each([
    [
        roles[0],
        [
            "Overview",
            "Reservations",
            "Calendar",
            "Buildings",
            "Facilities",
            "Equipment",
            "Equipment Loans",
            "Maintenance",
            "Staff Assignments",
            "Account Management",
            "Profile",
        ],
    ],
    [
        roles[1],
        [
            "Overview",
            "Facilities",
            "Equipment",
            "My Reservations",
            "Calendar",
            "Equipment Loans",
            "Maintenance Tasks",
            "My Assignments",
            "Profile",
        ],
    ],
    [
        roles[2],
        [
            "Overview",
            "Browse Facilities",
            "Browse Equipment",
            "My Reservations",
            "Calendar",
            "My Equipment Loans",
            "Report Maintenance",
            "Profile",
        ],
    ],
])(
    "navigation for %s contains only the specified workspaces",
    (role, expected) => {
        expect(navigation(role).map(([, label]) => label)).toEqual(expected);
    },
);
const user = {
    userId: 301,
    fname: "Fixture",
    lname: "Representative",
    email: "fixture@example.test",
    role: { roleName: roles[2] },
};
test("mobile navigation traps focus, closes on Escape and returns focus to its toggle", () => {
    render(
        <AppShell user={user} route="overview" logout={() => {}}>
            <h1>Test workspace</h1>
        </AppShell>,
    );
    const toggle = screen.getByRole("button", { name: "Toggle navigation" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("main").parentElement.hasAttribute("inert")).toBe(
        true,
    );
    const close = screen.getByRole("button", { name: "Close navigation" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement.getAttribute("href")).toBe("#/overview");
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole("main").parentElement.hasAttribute("inert")).toBe(
        false,
    );
});
test("collapsed desktop navigation retains accessible link names and profile is read only", () => {
    render(
        <AppShell user={user} route="profile" logout={() => {}}>
            <Profile user={user} logout={() => {}} />
        </AppShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("link", { name: "My Reservations" })).toBeTruthy();
    const main = screen.getByRole("main");
    expect(within(main).getByText("fixture@example.test")).toBeTruthy();
    expect(within(main).queryByRole("textbox")).toBeNull();
    expect(within(main).getByText(/15 minutes/)).toBeTruthy();
});
test("searchable choices filter visible names while submitting only the selected numeric ID", async () => {
    const submit = vi.fn(async () => {});
    render(
        <Editor
            title="Choose a space"
            fields={[["facilityId", "Facility", "number", "facilities"]]}
            catalogs={{
                facilities: [
                    { facilityId: 30, facilityName: "Science Hall" },
                    { facilityId: 31, facilityName: "West Studio" },
                ],
            }}
            onSubmit={submit}
            onClose={() => {}}
        />,
    );
    fireEvent.change(
        screen.getByRole("searchbox", { name: "Search facilities" }),
        { target: { value: "studio" } },
    );
    expect(screen.queryByRole("option", { name: "Science Hall" })).toBeNull();
    const option = screen.getByRole("option", { name: "West Studio" });
    expect(option.value).toBe("31");
    fireEvent.change(screen.getByRole("combobox", { name: "Facility" }), {
        target: { value: "31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
        expect(submit).toHaveBeenCalledWith({ facilityId: 31 }),
    );
});
test("reversed reservation times produce inline linked errors and never submit", async () => {
    const submit = vi.fn(),
        pad = (n) => String(n).padStart(2, "0"),
        day = new Date(Date.now() + 86400000),
        date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    render(
        <Editor
            title="Request dates"
            fields={[
                ["startDatetime", "Start date & time", "datetime"],
                ["endDatetime", "End date & time", "datetime"],
            ]}
            initial={{
                startDatetime: date + "T12:00",
                endDatetime: date + "T11:00",
            }}
            onSubmit={submit}
            onClose={() => {}}
        />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const end = screen.getByLabelText(/^End date & time/);
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(
        document.getElementById(end.getAttribute("aria-describedby"))
            .textContent,
    ).toBe("End time must be after start time.");
    expect(submit).not.toHaveBeenCalled();
});
test("form feedback covers required, Unicode, inventory and duplicate equipment boundaries", () => {
    const now = new Date(2027, 0, 1).getTime();
    expect(
        formErrors(
            [["purpose", "Purpose", "textarea", 255]],
            { purpose: "😀".repeat(256) },
            undefined,
            now,
        ).purpose,
    ).toMatch(/255/);
    expect(
        formErrors(
            [["facilityId", "Facility", "number", "facilities"]],
            {},
            undefined,
            now,
        ).facilityId,
    ).toMatch(/required/);
    expect(
        formErrors(
            [],
            { totalQuantity: 2, availableQuantity: 3 },
            undefined,
            now,
        ).availableQuantity,
    ).toMatch(/cannot exceed/);
    expect(
        formErrors(
            [],
            {},
            [
                { equipmentId: 1, quantity: 1 },
                { equipmentId: 1, quantity: 2 },
            ],
            now,
        ).items,
    ).toMatch(/once/);
    expect(
        formErrors(
            [["dueDate", "Due date", "datetime"]],
            { dueDate: "2026-12-31T10:00" },
            undefined,
            now,
        ).dueDate,
    ).toMatch(/future/);
});
test("dashboard history stays bounded and marks incomplete activity counts explicitly", async () => {
    const api = {
        request: vi.fn(async () => ({
            loans: [{ loanId: 1 }],
            pagination: { hasMore: true },
        })),
    };
    const result = await dashboardHistory(
        api,
        "/loans",
        "loans",
        new AbortController().signal,
    );
    expect(result.partial).toBe(true);
    expect(api.request).toHaveBeenCalledTimes(10);
    expect(
        api.request.mock.calls.every(([path]) =>
            /^\/loans\?page=\d+&limit=100$/.test(path),
        ),
    ).toBe(true);
});
test("responsive tables keep semantic headers and mobile data labels", () => {
    render(
        <DataTable
            rows={[{ id: 1, name: "Science Hall" }]}
            columns={[{ key: "name", label: "Facility" }]}
            rowKey="id"
            renderCell={(row, key) => row[key]}
            renderActions={() => <button>View Details</button>}
        />,
    );
    expect(
        screen
            .getByRole("columnheader", { name: "Facility" })
            .getAttribute("scope"),
    ).toBe("col");
    expect(
        screen
            .getByRole("cell", { name: "Science Hall" })
            .getAttribute("data-label"),
    ).toBe("Facility");
});
test("phone calendar uses an agenda with approved events and readable full times", async () => {
    const previous = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
        value: 390,
        writable: true,
        configurable: true,
    });
    const today = new Date(),
        start = new Date(
            today.getFullYear(),
            today.getMonth(),
            15,
            9,
        ).toISOString(),
        end = new Date(
            today.getFullYear(),
            today.getMonth(),
            15,
            10,
        ).toISOString();
    const api = {
        request: vi.fn(async () => ({
            availability: [
                {
                    facilityId: 30,
                    facilityName: "Science Hall",
                    status: "Approved",
                    startDatetime: start,
                    endDatetime: end,
                },
                {
                    facilityId: 30,
                    facilityName: "Science Hall",
                    status: "Pending",
                    startDatetime: start,
                    endDatetime: end,
                },
            ],
            pagination: { hasMore: false },
        })),
    };
    try {
        render(
            <Calendar
                api={api}
                catalogs={{
                    statuses: [{ statusId: 29, statusName: "Approved" }],
                    facilities: [
                        { facilityId: 30, facilityName: "Science Hall" },
                    ],
                }}
                onSelect={() => {}}
            />,
        );
        await screen.findByRole("button", {
            name: /Confirmed booking.*Science Hall/,
        });
        expect(document.querySelector(".agenda-list")).not.toBeNull();
        expect(document.querySelector(".calendar-grid")).toBeNull();
        expect(screen.queryByText("Pending forum")).toBeNull();
    } finally {
        window.innerWidth = previous;
        await act(async () => window.dispatchEvent(new Event("resize")));
    }
});
