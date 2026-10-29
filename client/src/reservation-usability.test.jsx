import React from "react";
import { test, expect, vi } from "vitest";
import {
    render,
    screen,
    fireEvent,
    waitFor,
    within,
} from "@testing-library/react";
import {
    formatDate,
    formatValue,
    purposePreview,
    displayValue,
    recordName,
} from "./presentation";
import { useRecordNames } from "./names";
import { Editor, RecordDetails } from "./components";
import Calendar, { reservationBatch, monthDays } from "./ReservationCalendar";

const catalogs = {
    facilities: [{ facilityId: 98765, facilityName: "Science Seminar Hall" }],
    equipment: [{ equipmentId: 87654, equipmentName: "Portable Projector" }],
    statuses: [
        { statusId: 918, statusName: "Approved" },
        { statusId: 217, statusName: "Pending" },
        { statusId: 741, statusName: "Rejected" },
        { statusId: 853, statusName: "Cancelled" },
    ],
};
function row(
    id,
    statusId = 918,
    purpose = "Research symposium\nFull agenda and accessibility arrangements.",
) {
    const now = new Date();
    return {
        reservationId: id,
        facilityId: 98765,
        requestedBy: 301,
        approvedBy: 101,
        statusId,
        purpose,
        startDatetime: new Date(
            now.getFullYear(),
            now.getMonth(),
            10,
            9,
        ).toISOString(),
        endDatetime: new Date(
            now.getFullYear(),
            now.getMonth(),
            10,
            10,
        ).toISOString(),
        createdAt: new Date().toISOString(),
    };
}
test("shared dates use numeric month/day/year, zero-padded time and explicit AM/PM", () => {
    expect(formatDate(new Date(2027, 0, 2, 9, 5).toISOString())).toBe(
        "01/02/2027 09:05 AM",
    );
    expect(formatDate(new Date(2027, 0, 2, 15, 7).toISOString())).toBe(
        "01/02/2027 03:07 PM",
    );
    expect(formatDate(new Date(2027, 0, 2, 0, 0).toISOString())).toBe(
        "01/02/2027 12:00 AM",
    );
    expect(formatValue("2027-01-02T00:00:00.000Z", "assignedDate")).toBe(
        "01/02/2027",
    );
    expect(formatValue("2027-02-30", "assignedDate")).toBe("Unavailable");
    expect(formatDate("not-a-date")).toBe("Unavailable");
    expect(formatDate("2027-01-02T09:00:00+08:00")).toBe(
        formatDate("2027-01-02T01:00:00Z"),
    );
});
test("purpose previews use the first meaningful line or sentence and truncate Unicode safely", () => {
    expect(
        purposePreview(
            "\n Planning meeting\nConfidential synthetic second line",
        ),
    ).toBe("Planning meeting");
    expect(purposePreview("Faculty forum. Detailed preparation follows.")).toBe(
        "Faculty forum.",
    );
    expect(purposePreview("Campus meeting; please reserve seating")).toBe(
        "Campus meeting",
    );
    expect(purposePreview("😀".repeat(100))).toBe("😀".repeat(64) + "…");
    expect(purposePreview("   ")).toBe("Untitled reservation");
});
test("table display helpers replace facility and equipment IDs with public names", () => {
    expect(displayValue({ facilityId: 98765 }, "facilityId", catalogs)).toBe(
        "Science Seminar Hall",
    );
    expect(
        displayValue({ homeFacilityId: 98765 }, "homeFacilityId", catalogs),
    ).toBe("Science Seminar Hall");
    expect(displayValue({ equipmentId: 87654 }, "equipmentId", catalogs)).toBe(
        "Portable Projector",
    );
    expect(recordName(999999, "equipment", catalogs)).toBe(
        "Equipment unavailable",
    );
    expect(recordName(null, "facility", catalogs)).toBe("—");
});
test("details retain the complete multiline purpose and show names for targets and loan items", async () => {
    const full =
        "Research symposium\nFull agenda with <script>plain text</script> and accessibility arrangements.";
    render(
        <RecordDetails
            row={{
                ...row(1, 918, full),
                equipmentId: 87654,
                items: [
                    {
                        equipmentId: 87654,
                        quantity: 2,
                        conditionOut: "Good",
                        conditionIn: null,
                    },
                ],
            }}
            catalogs={catalogs}
            onClose={() => {}}
        />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Full purpose")).toBeTruthy();
    expect(dialog.querySelector(".full-purpose").textContent).toBe(full);
    expect(within(dialog).getByText("Science Seminar Hall")).toBeTruthy();
    expect(dialog.textContent).toContain("Portable Projector");
    expect(dialog.textContent).not.toContain("98765");
    expect(dialog.textContent).not.toContain("87654");
    expect(dialog.querySelector("script")).toBeNull();
});
test("name selectors submit internal IDs without exposing numeric option labels", async () => {
    const submit = vi.fn(async () => {});
    render(
        <Editor
            title="Reservation choice"
            fields={[["facilityId", "Facility", "number", "facilities"]]}
            catalogs={catalogs}
            onSubmit={submit}
            onClose={() => {}}
        />,
    );
    const select = screen.getByRole("combobox", { name: "Facility" });
    expect(
        within(select).getByRole("option", { name: "Science Seminar Hall" })
            .value,
    ).toBe("98765");
    expect(select.textContent).not.toContain("98765");
    fireEvent.change(select, { target: { value: "98765" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
        expect(submit).toHaveBeenCalledWith({ facilityId: 98765 }),
    );
});
test("loan return selectors identify equipment by name", () => {
    render(
        <Editor
            title="Return equipment"
            fields={[]}
            catalogs={catalogs}
            returnItems={[{ equipmentId: 87654, quantity: 2 }]}
            onSubmit={async () => {}}
            onClose={() => {}}
        />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Portable Projector");
    expect(dialog.textContent).not.toContain("87654");
});

test("name selectors offer an explicit way to fetch additional choices", async () => {
    const more = vi.fn();
    const props = {
        title: "More facilities",
        fields: [["facilityId", "Facility", "number", "facilities"]],
        onSubmit: async () => {},
        onClose: () => {},
    };
    const { rerender } = render(
        <Editor
            {...props}
            catalogs={{
                ...catalogs,
                hasMore: { facilities: true },
                loadMore: more,
            }}
        />,
    );
    fireEvent.click(
        screen.getByRole("button", { name: "Load more facilities" }),
    );
    expect(more).toHaveBeenCalledWith("facilities");
    rerender(
        <Editor
            {...props}
            catalogs={{
                ...catalogs,
                facilities: [
                    ...catalogs.facilities,
                    { facilityId: 43210, facilityName: "West Campus Hall" },
                ],
            }}
        />,
    );
    expect(screen.getByRole("option", { name: "West Campus Hall" }).value).toBe(
        "43210",
    );
});
test("names beyond the first catalog page resolve through fixed authenticated GET endpoints", async () => {
    const api = {
        request: vi.fn(async (path) =>
            path === "/facilities/22222"
                ? {
                      facility: {
                          facilityId: 22222,
                          facilityName: "Additional Hall",
                      },
                  }
                : {
                      equipment: {
                          equipmentId: 33333,
                          equipmentName: "Additional Camera",
                      },
                  },
        ),
    };
    function Names() {
        const resolved = useRecordNames(
            [
                {
                    facilityId: 22222,
                    items: [{ equipmentId: 33333 }, { equipmentId: 33333 }],
                },
            ],
            catalogs,
            api,
        );
        return (
            <p>
                {recordName(22222, "facility", resolved)} /{" "}
                {recordName(33333, "equipment", resolved)}
            </p>
        );
    }
    render(<Names />);
    await screen.findByText("Additional Hall / Additional Camera");
    expect(api.request).toHaveBeenCalledTimes(2);
    expect(api.request.mock.calls.map((call) => call[0]).sort()).toEqual([
        "/equipment/33333",
        "/facilities/22222",
    ]);
});
test("failed catalog resolution displays neutral text without IDs or private diagnostics", async () => {
    const api = {
        request: vi.fn(async () => {
            throw Error("PRIVATE-fixture-diagnostic");
        }),
    };
    function Missing() {
        const resolved = useRecordNames([{ facilityId: 55555 }], catalogs, api);
        return <p>{recordName(55555, "facility", resolved)}</p>;
    }
    render(<Missing />);
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Facility unavailable")).toBeTruthy();
    expect(document.body.textContent).not.toContain("55555");
    expect(document.body.textContent).not.toContain("PRIVATE");
});

function safeSlot(status = "Approved") {
    return { ...row(1), facilityName: "Science Seminar Hall", status };
}
test("campus calendar shows confirmed and tentative slots without private purposes or details", async () => {
    const api = {
        request: vi.fn(async () => ({
            availability: [safeSlot(), safeSlot("Pending")],
            pagination: { hasMore: false },
        })),
    };
    render(<Calendar api={api} catalogs={catalogs} />);
    const confirmed = await screen.findByRole("button", {
        name: /Confirmed booking.*Science Seminar Hall/,
    });
    expect(
        screen.getByRole("button", {
            name: /Tentative request.*Science Seminar Hall/,
        }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("Research symposium");
    fireEvent.click(confirmed);
    const dialog = screen.getByRole("dialog", { name: "Booking time slot" });
    expect(dialog.textContent).not.toContain("Full agenda");
    expect(dialog.textContent).not.toContain("301");
    expect(api.request.mock.calls[0][0]).toMatch(
        /^\/reservation-availability\?from=/,
    );
});
test("calendar paginates explicitly and refetches its bounded date range on month changes", async () => {
    const api = {
        request: vi.fn(async (path) => ({
            availability: [
                safeSlot(path.includes("page=2") ? "Pending" : "Approved"),
            ],
            pagination: { hasMore: !path.includes("page=2") },
        })),
    };
    render(<Calendar api={api} catalogs={catalogs} />);
    fireEvent.click(
        await screen.findByRole("button", { name: "Load more slots" }),
    );
    await screen.findByRole("button", { name: /Tentative request/ });
    expect(api.request).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(3));
    expect(
        new URL(
            api.request.mock.calls[0][0],
            "http://fixture.test",
        ).searchParams.get("from"),
    ).not.toBe(
        new URL(
            api.request.mock.calls[2][0],
            "http://fixture.test",
        ).searchParams.get("from"),
    );
});
test("ownership-scoped dashboard batches remain bounded at ten pages", async () => {
    const api = {
        request: vi.fn(async () => ({
            reservations: [],
            pagination: { hasMore: true },
        })),
    };
    expect(
        (await reservationBatch(api, new AbortController().signal)).next,
    ).toBe(11);
    expect(api.request).toHaveBeenCalledTimes(10);
    expect(
        api.request.mock.calls.every((call) =>
            /^\/reservations\?page=\d+&limit=100$/.test(call[0]),
        ),
    ).toBe(true);
});
test("calendar fails closed for malformed or unavailable availability and leap months use local boundaries", async () => {
    const api = {
        request: vi.fn(async () => ({
            availability: [safeSlot("Rejected")],
            pagination: { hasMore: false },
        })),
    };
    render(<Calendar api={api} catalogs={catalogs} />);
    await screen.findByRole("alert");
    expect(
        screen.queryByRole("button", { name: /Confirmed booking/ }),
    ).toBeNull();
    expect(screen.getByText(/Schedule unavailable or incomplete/)).toBeTruthy();
    const days = monthDays(new Date(2028, 1, 1));
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0);
    expect(days.filter((day) => day.getMonth() === 1)).toHaveLength(29);
});
test("calendar refresh and facility filtering query the availability API without relying on private status catalogs", async () => {
    const api = {
            request: vi.fn(async () => ({
                availability: [],
                pagination: { hasMore: false },
            })),
        },
        retry = vi.fn();
    render(
        <Calendar api={api} catalogs={catalogs} onRefreshCatalogs={retry} />,
    );
    await screen.findByText(/No Pending or Approved slots/);
    fireEvent.change(screen.getByRole("combobox", { name: "Facility" }), {
        target: { value: "98765" },
    });
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(2));
    expect(api.request.mock.calls[1][0]).toContain("facilityId=98765");
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Refresh calendar" }).disabled,
        ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
    await waitFor(() => expect(api.request).toHaveBeenCalledTimes(3));
    expect(retry).toHaveBeenCalledOnce();
});
