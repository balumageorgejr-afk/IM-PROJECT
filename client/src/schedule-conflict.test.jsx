import React from "react";
import { test, expect, vi } from "vitest";
import {
    render,
    screen,
    fireEvent,
    waitFor,
    within,
} from "@testing-library/react";
import { Editor } from "./components";
import { ApiError, createApi } from "./api";
import Calendar, { calendarRange } from "./ReservationCalendar";
import { spawnSync } from "node:child_process";
import { execPath, env } from "node:process";

function editor(onSubmit) {
    const start = new Date(Date.now() + 2 * 86400000),
        end = new Date(start.getTime() + 3600000);
    const local = (date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    render(
        <Editor
            title="Request a facility"
            formKind="reservations"
            fields={[
                ["facilityId", "Facility", "number", "facilities"],
                ["purpose", "Purpose", "text", 255],
                ["startDatetime", "Start time", "datetime"],
                ["endDatetime", "End time", "datetime"],
            ]}
            initial={{
                facilityId: 30,
                purpose: "Private draft purpose",
                startDatetime: local(start),
                endDatetime: local(end),
            }}
            catalogs={{
                facilities: [{ facilityId: 30, facilityName: "Science Hall" }],
            }}
            onSubmit={onSubmit}
            onClose={() => {}}
        />,
    );
}
test("only confirmed schedule collisions open accessible modal; returning preserves fields and focus", async () => {
    const submit = vi.fn(async () => {
        throw new ApiError(
            409,
            "Conflict",
            false,
            "RESERVATION_SCHEDULE_CONFLICT",
        );
    });
    editor(submit);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("dialog", {
        name: "Schedule Conflict",
    });
    expect(within(dialog).getByText("Science Hall")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Private draft purpose");
    fireEvent.click(
        within(dialog).getByRole("button", { name: "Choose Another Schedule" }),
    );
    expect(screen.getByLabelText(/^Purpose/).value).toBe(
        "Private draft purpose",
    );
    await waitFor(() =>
        expect(document.activeElement).toBe(
            screen.getByLabelText(/^Start time/),
        ),
    );
    expect(submit).toHaveBeenCalledTimes(1);
});
test("serialization and ambiguous outcomes do not open collision dialogs or retry writes", async () => {
    const submit = vi.fn(async () => {
        throw new ApiError(
            409,
            "Refresh and verify request history before resubmitting.",
            true,
            "RESERVATION_CONFLICT",
        );
    });
    editor(submit);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    expect(
        screen.queryByRole("dialog", { name: "Schedule Conflict" }),
    ).toBeNull();
    fireEvent.submit(screen.getByRole("form", { name: "Request a facility" }));
    expect(submit).toHaveBeenCalledTimes(1);
});
test("API client accepts only a matching reservation endpoint/status/code combination", async () => {
    for (const [path, status, code, expected] of [
        [
            "/reservations",
            409,
            "RESERVATION_SCHEDULE_CONFLICT",
            "RESERVATION_SCHEDULE_CONFLICT",
        ],
        ["/reservations", 409, "RESERVATION_CONFLICT", "RESERVATION_CONFLICT"],
        ["/reservations", 500, "RESERVATION_SCHEDULE_CONFLICT", null],
        ["/loans", 409, "RESERVATION_SCHEDULE_CONFLICT", null],
        ["/reservations", 409, "PRIVATE_INVALID_CODE", null],
    ]) {
        const api = createApi({
            fetchImpl: async () => ({
                ok: false,
                status,
                json: async () => ({ success: false, code }),
            }),
        });
        try {
            await api.request(path, { method: "POST", body: {} });
            throw Error("Expected refusal");
        } catch (error) {
            expect(error.code).toBe(expected);
            expect(error.requiresRefresh).toBe(
                expected !== "RESERVATION_SCHEDULE_CONFLICT",
            );
        }
    }
});
test("calendar local-day ranges include timezone boundaries and refresh after mutation revisions", async () => {
    const range = calendarRange(new Date(2027, 0, 1));
    const first = new Date(range.from);
    expect(first.getHours()).toBe(0);
    expect(first.getDay()).toBe(0);
    expect(Date.parse(range.to) - Date.parse(range.from)).toBeLessThanOrEqual(
        43 * 86400000,
    );
    const api = {
        request: vi.fn(async () => ({
            availability: [],
            pagination: { hasMore: false },
        })),
    };
    const { rerender } = render(
        <Calendar api={api} catalogs={{ facilities: [] }} refreshKey={0} />,
    );
    await screen.findByText(/No Pending or Approved slots/);
    rerender(
        <Calendar api={api} catalogs={{ facilities: [] }} refreshKey={1} />,
    );
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
});

test("shared timestamp formatting renders UTC instants correctly in Asia/Manila", () => {
    const result = spawnSync(
        execPath,
        [
            "--input-type=module",
            "-e",
            "import { formatDate } from './src/presentation.js'; console.log(formatDate('2027-01-02T01:00:00Z'));",
        ],
        { env: { ...env, TZ: "Asia/Manila" }, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("01/02/2027 09:00 AM");
});

test("stale availability responses cannot replace a newer facility filter", async () => {
    let firstResolve;
    const api = {
        request: vi.fn((path) =>
            path.includes("facilityId=30")
                ? Promise.resolve({
                      availability: [],
                      pagination: { hasMore: false },
                  })
                : new Promise((resolve) => {
                      firstResolve = resolve;
                  }),
        ),
    };
    render(
        <Calendar
            api={api}
            catalogs={{
                facilities: [{ facilityId: 30, facilityName: "Science Hall" }],
            }}
        />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Facility" }), {
        target: { value: "30" },
    });
    await screen.findByText(/No Pending or Approved slots/);
    firstResolve({
        availability: [
            {
                facilityId: 99,
                facilityName: "Stale Hall",
                status: "Approved",
                startDatetime: new Date().toISOString(),
                endDatetime: new Date(Date.now() + 3600000).toISOString(),
            },
        ],
        pagination: { hasMore: true },
    });
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Stale Hall")).toBeNull();
});
