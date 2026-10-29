import React, { useEffect, useRef, useState } from "react";
import { Alert, Badge, Modal } from "./components";
import { formatDate } from "./presentation";

// Existing ownership-scoped dashboard history helper is unchanged.
export async function reservationBatch(api, signal, page = 1) {
    const rows = [];
    for (let count = 0; count < 10; count++, page++) {
        const data = await api.request(`/reservations?page=${page}&limit=100`, {
            signal,
        });
        rows.push(...data.reservations);
        if (!data.pagination.hasMore) return { rows, next: null };
    }
    return { rows, next: page };
}
export function monthDays(month) {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    start.setDate(start.getDate() - start.getDay());
    return Array.from(
        { length: 42 },
        (_, index) =>
            new Date(
                start.getFullYear(),
                start.getMonth(),
                start.getDate() + index,
            ),
    );
}
export function calendarRange(month) {
    const days = monthDays(month),
        last = days.at(-1);
    return {
        from: days[0].toISOString(),
        to: new Date(
            last.getFullYear(),
            last.getMonth(),
            last.getDate() + 1,
        ).toISOString(),
    };
}
function safeSlots(data) {
    if (
        !Array.isArray(data.availability) ||
        typeof data.pagination?.hasMore !== "boolean"
    )
        throw Error(
            "Availability could not be verified. Refresh the calendar.",
        );
    return data.availability.map((row) => {
        if (
            !Number.isInteger(row.facilityId) ||
            typeof row.facilityName !== "string" ||
            !["Pending", "Approved"].includes(row.status) ||
            !Number.isFinite(Date.parse(row.startDatetime)) ||
            !Number.isFinite(Date.parse(row.endDatetime)) ||
            Date.parse(row.startDatetime) >= Date.parse(row.endDatetime)
        )
            throw Error(
                "Availability could not be verified. Refresh the calendar.",
            );
        return {
            facilityId: row.facilityId,
            facilityName: row.facilityName,
            status: row.status,
            startDatetime: row.startDatetime,
            endDatetime: row.endDatetime,
        };
    });
}
export default function ReservationCalendar({
    api,
    catalogs,
    onRefreshCatalogs,
    refreshKey = 0,
}) {
    const [compact, setCompact] = useState(() => window.innerWidth <= 700);
    const [month, setMonth] = useState(
        () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    );
    const [facility, setFacility] = useState(""),
        [rows, setRows] = useState([]),
        [next, setNext] = useState(null),
        [loading, setLoading] = useState(true),
        [error, setError] = useState(""),
        [revision, setRevision] = useState(0),
        [details, setDetails] = useState(null);
    const pending = useRef(false),
        current = useRef(null);
    const { from, to } = calendarRange(month);
    useEffect(() => {
        const resize = () => setCompact(window.innerWidth <= 700);
        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, []);
    async function load(page, controller, append = false) {
        pending.current = true;
        setLoading(true);
        setError("");
        try {
            const query = new URLSearchParams({
                from,
                to,
                page: String(page),
                limit: "100",
                ...(facility ? { facilityId: facility } : {}),
            });
            const data = await api.request(
                `/reservation-availability?${query}`,
                { signal: controller.signal },
            );
            const slots = safeSlots(data);
            if (!controller.signal.aborted) {
                setRows((previous) =>
                    append ? [...previous, ...slots] : slots,
                );
                setNext(data.pagination.hasMore ? page + 1 : null);
            }
        } catch (failure) {
            if (!controller.signal.aborted) {
                setError(failure.message);
                setNext(null);
            }
        } finally {
            if (!controller.signal.aborted) {
                pending.current = false;
                setLoading(false);
            }
        }
    }
    useEffect(() => {
        const controller = new AbortController();
        current.current = controller;
        setRows([]);
        setNext(null);
        setDetails(null);
        load(1, controller);
        return () => controller.abort();
    }, [api, from, to, facility, revision, refreshKey]);
    const refresh = () => {
        setRevision((value) => value + 1);
        onRefreshCatalogs?.();
    };
    const dateLabel = (day) =>
        formatDate(
            `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
            true,
        );
    function events(day) {
        const end = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate() + 1,
        );
        return rows
            .filter(
                (row) =>
                    Date.parse(row.startDatetime) < end &&
                    Date.parse(row.endDatetime) > day,
            )
            .sort(
                (a, b) =>
                    Date.parse(a.startDatetime) - Date.parse(b.startDatetime),
            );
    }
    function event(row, index) {
        return (
            <button
                type="button"
                className={`calendar-event ${row.status === "Pending" ? "tentative" : "confirmed"}`}
                key={index}
                onClick={() => setDetails(row)}
            >
                <strong>
                    {row.status === "Approved"
                        ? "Confirmed booking"
                        : "Tentative request"}
                </strong>
                <span>{row.facilityName}</span>
                <span>
                    {formatDate(row.startDatetime)} to{" "}
                    {formatDate(row.endDatetime)}
                </span>
                <Badge value={row.status} />
            </button>
        );
    }
    return (
        <section
            className="panel reservation-calendar"
            aria-label="Campus availability calendar"
        >
            <div className="calendar-toolbar">
                <div>
                    <h2>
                        {month.toLocaleDateString("en-US", {
                            month: "long",
                            year: "numeric",
                        })}
                    </h2>
                    <p className="muted">
                        Campus-wide schedule. Approved bookings occupy the slot;
                        Pending requests are tentative and may overlap. Times
                        use your device's local timezone.
                    </p>
                </div>
                <div className="toolbar-actions">
                    <button
                        className="button secondary small"
                        onClick={() =>
                            setMonth(
                                new Date(
                                    month.getFullYear(),
                                    month.getMonth() - 1,
                                    1,
                                ),
                            )
                        }
                    >
                        Previous month
                    </button>
                    <button
                        className="button secondary small"
                        onClick={() =>
                            setMonth(
                                new Date(
                                    new Date().getFullYear(),
                                    new Date().getMonth(),
                                    1,
                                ),
                            )
                        }
                    >
                        Today
                    </button>
                    <button
                        className="button secondary small"
                        onClick={() =>
                            setMonth(
                                new Date(
                                    month.getFullYear(),
                                    month.getMonth() + 1,
                                    1,
                                ),
                            )
                        }
                    >
                        Next month
                    </button>
                    <button
                        className="button secondary small"
                        disabled={loading}
                        onClick={refresh}
                    >
                        Refresh calendar
                    </button>
                </div>
                <label className="filter-label">
                    Facility
                    <select
                        value={facility}
                        onChange={(e) => setFacility(e.target.value)}
                    >
                        <option value="">All facilities</option>
                        {(catalogs.facilities || []).map((row) => (
                            <option key={row.facilityId} value={row.facilityId}>
                                {row.facilityName}
                            </option>
                        ))}
                    </select>
                </label>
                {catalogs.hasMore?.facilities && (
                    <button
                        className="button secondary small"
                        disabled={catalogs.loadingMore?.facilities}
                        onClick={() => catalogs.loadMore?.("facilities")}
                    >
                        Load more facility choices
                    </button>
                )}
            </div>
            <Alert>{error}</Alert>
            {loading && (
                <p role="status">
                    Loading availability. Empty spaces are not confirmed
                    available.
                </p>
            )}
            {next && (
                <p className="form-note" role="status">
                    Partial schedule: more slots remain. Empty spaces are not
                    confirmed available.{" "}
                    {next <= 100 ? (
                        <button
                            className="button secondary small"
                            disabled={loading}
                            onClick={() => {
                                if (!pending.current)
                                    load(next, current.current, true);
                            }}
                        >
                            Load more slots
                        </button>
                    ) : (
                        "Narrow the facility filter to see more."
                    )}
                </p>
            )}
            {error && (
                <p className="form-note">
                    Schedule unavailable or incomplete. Refresh before choosing
                    a time.
                </p>
            )}
            {!loading && !error && !next && !rows.length && (
                <p className="calendar-empty">
                    No Pending or Approved slots were found in this range. This
                    does not guarantee availability; the server rechecks every
                    request.
                </p>
            )}
            <div
                className={compact ? "agenda-list" : "calendar-scroll"}
                aria-busy={loading}
            >
                <div className={compact ? undefined : "calendar-grid"}>
                    {!compact &&
                        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                            (day) => (
                                <div className="calendar-weekday" key={day}>
                                    {day}
                                </div>
                            ),
                        )}
                    {monthDays(month)
                        .filter(
                            (day) =>
                                !compact || day.getMonth() === month.getMonth(),
                        )
                        .map((day) => {
                            const entries = events(day);
                            return compact && !entries.length ? null : (
                                <section
                                    className={
                                        compact
                                            ? "agenda-day"
                                            : `calendar-day ${day.getMonth() === month.getMonth() ? "" : "outside-month"}`
                                    }
                                    key={day.toISOString()}
                                    aria-label={dateLabel(day)}
                                >
                                    {compact ? (
                                        <h3>{dateLabel(day)}</h3>
                                    ) : (
                                        <span className="calendar-day-number">
                                            {day.getDate()}
                                        </span>
                                    )}
                                    {entries.map(event)}
                                </section>
                            );
                        })}
                </div>
            </div>
            <p className="scope-note">
                A live snapshot, not a guarantee of availability. Other requests
                can change while you view it.
            </p>
            {details && (
                <Modal
                    title="Booking time slot"
                    onClose={() => setDetails(null)}
                >
                    <div className="modal-body">
                        <h3>{details.facilityName}</h3>
                        <Badge value={details.status} />
                        <p>
                            {details.status === "Pending"
                                ? "Tentative request; does not block booking."
                                : "Confirmed booking; blocks overlapping requests."}
                        </p>
                        <p>
                            {formatDate(details.startDatetime)} to{" "}
                            {formatDate(details.endDatetime)}
                        </p>
                        <p>
                            Requester identities and private purposes are not
                            shared in this calendar.
                        </p>
                    </div>
                </Modal>
            )}
        </section>
    );
}
