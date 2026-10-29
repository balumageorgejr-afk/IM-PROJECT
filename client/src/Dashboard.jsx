import React, { useEffect, useState } from "react";
import { useSession, roles } from "./session";
import { Alert, Badge, Icon, RecordDetails } from "./components";
import { PageHeader, StatCard, Skeleton, EmptyState } from "./ui";
import { formatDate, purposePreview, recordName } from "./presentation";
import { useRecordNames } from "./names";

export async function dashboardHistory(api, path, key, signal) {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
        const data = await api.request(
            `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=100`,
            { signal },
        );
        rows.push(...data[key]);
        if (!data.pagination.hasMore) return { rows, partial: false };
    }
    return { rows, partial: true };
}
export default function Dashboard({ catalogs }) {
    const { api, user } = useSession(),
        admin = user.role.roleName === roles[0],
        staff = user.role.roleName === roles[1];
    const [data, setData] = useState(null),
        [error, setError] = useState(""),
        [revision, setRevision] = useState(0),
        [details, setDetails] = useState(null);
    useEffect(() => {
        const controller = new AbortController();
        setError("");
        setData(null);
        Promise.all([
            api.request("/overview", { signal: controller.signal }),
            dashboardHistory(
                api,
                "/reservations",
                "reservations",
                controller.signal,
            ),
            dashboardHistory(api, "/loans", "loans", controller.signal),
            dashboardHistory(
                api,
                "/maintenance",
                "maintenanceRequests",
                controller.signal,
            ),
        ])
            .then(([overview, reservations, loans, maintenance]) => {
                if (!controller.signal.aborted)
                    setData({
                        overview: overview.overview,
                        reservations,
                        loans,
                        maintenance,
                    });
            })
            .catch((err) => {
                if (!controller.signal.aborted) setError(err.message);
            });
        return () => controller.abort();
    }, [api, revision]);
    const names = useRecordNames(
        data
            ? [
                  ...data.reservations.rows,
                  ...data.loans.rows,
                  ...data.maintenance.rows,
              ]
            : [],
        catalogs,
        api,
    );
    const statusName = (row) =>
        catalogs.statuses?.find((s) => s.statusId === row.statusId)
            ?.statusName || "Status unavailable";
    const own = (row) => row.requestedBy === user.userId;
    const reservations = data?.reservations.rows || [],
        loans = data?.loans.rows || [],
        maintenance = data?.maintenance.rows || [];
    const pending = reservations.filter((row) => statusName(row) === "Pending"),
        loanReview = loans.filter(
            (row) => row.loanStatus === "Pending" && row.userId !== user.userId,
        ),
        assigned = maintenance.filter(
            (row) => row.assignedStaffId === user.userId,
        ),
        upcoming = reservations.filter(
            (row) =>
                own(row) &&
                new Date(row.startDatetime) > new Date() &&
                ["Pending", "Approved"].includes(statusName(row)),
        );
    const partial =
        data &&
        (data.reservations.partial ||
            data.loans.partial ||
            data.maintenance.partial);
    const count = (value, kind) =>
        data?.[kind]?.partial ? `${value}+` : value;
    const stats = admin
        ? [
              [
                  "Buildings",
                  data?.overview.buildings,
                  "buildings",
                  "#/buildings",
              ],
              [
                  "Facilities",
                  data?.overview.facilities,
                  "facilities",
                  "#/facilities",
              ],
              [
                  "Equipment records",
                  data?.overview.equipment,
                  "equipment",
                  "#/equipment",
              ],
              [
                  "Pending reservations",
                  catalogs.statuses
                      ? count(pending.length, "reservations")
                      : "—",
                  "reservations",
                  "#/reservations",
              ],
              [
                  "Pending equipment loans",
                  count(
                      loans.filter((row) => row.loanStatus === "Pending")
                          .length,
                      "loans",
                  ),
                  "loans",
                  "#/loans",
              ],
              [
                  "Open maintenance reports",
                  count(
                      maintenance.filter((row) => row.status === "Open").length,
                      "maintenance",
                  ),
                  "maintenance",
                  "#/maintenance",
              ],
          ]
        : staff
          ? [
                [
                    "Assigned tasks",
                    count(
                        assigned.filter((row) => row.status !== "Resolved")
                            .length,
                        "maintenance",
                    ),
                    "maintenance",
                    "#/maintenance",
                ],
                [
                    "Work in progress",
                    count(
                        assigned.filter((row) => row.status === "In Progress")
                            .length,
                        "maintenance",
                    ),
                    "maintenance",
                    "#/maintenance",
                ],
                [
                    "Loans awaiting review",
                    count(loanReview.length, "loans"),
                    "loans",
                    "#/loans",
                ],
                [
                    "My reservations",
                    data?.overview.reservations,
                    "reservations",
                    "#/reservations",
                ],
            ]
          : [
                [
                    "Upcoming reservations",
                    catalogs.statuses
                        ? count(upcoming.length, "reservations")
                        : "—",
                    "reservations",
                    "#/reservations",
                ],
                [
                    "My active loans",
                    count(
                        loans.filter(
                            (row) =>
                                row.userId === user.userId &&
                                ["Pending", "Approved"].includes(
                                    row.loanStatus,
                                ),
                        ).length,
                        "loans",
                    ),
                    "loans",
                    "#/loans",
                ],
                [
                    "My open reports",
                    count(
                        maintenance.filter((row) => row.status !== "Resolved")
                            .length,
                        "maintenance",
                    ),
                    "maintenance",
                    "#/maintenance",
                ],
            ];
    const actions = admin
        ? [
              [
                  "reservations",
                  "Review reservations",
                  "See requests waiting for your decision.",
                  "#/reservations",
              ],
              [
                  "loans",
                  "Review equipment loans",
                  "Keep borrowing requests moving.",
                  "#/loans",
              ],
              [
                  "assignments",
                  "Coordinate staff",
                  "Manage facility coverage.",
                  "#/assignments",
              ],
          ]
        : staff
          ? [
                [
                    "maintenance",
                    "Find my tasks",
                    "Start, log and complete assigned work.",
                    "#/maintenance",
                ],
                [
                    "loans",
                    "Review borrowing",
                    "Approve requests and record returns.",
                    "#/loans",
                ],
                [
                    "assignments",
                    "View my assignments",
                    "Check your facility coverage.",
                    "#/assignments",
                ],
            ]
          : [
                [
                    "facilities",
                    "Find a space",
                    "Explore rooms for your next activity.",
                    "#/facilities",
                ],
                [
                    "equipment",
                    "Borrow equipment",
                    "See what is available on campus.",
                    "#/equipment",
                ],
                [
                    "maintenance",
                    "Report an issue",
                    "Help keep campus in good shape.",
                    "#/maintenance?create=1",
                ],
            ];
    const recent = admin
        ? pending
        : staff
          ? assigned.filter((row) => row.status !== "Resolved")
          : upcoming;
    return (
        <>
            <PageHeader
                className="dashboard-welcome"
                eyebrow={
                    admin
                        ? "ADMINISTRATION"
                        : staff
                          ? "CAMPUS OPERATIONS"
                          : "YOUR CAMPUS, CONNECTED"
                }
                title={`Welcome back, ${user.fname}.`}
                description={
                    admin
                        ? "A clear view of your campus and the requests that need your attention."
                        : staff
                          ? "Your assigned work, borrowing reviews and campus schedule."
                          : "Find a space, borrow what you need and keep your plans moving."
                }
            >
                <a
                    className="button primary"
                    href={
                        admin
                            ? "#/reservations"
                            : staff
                              ? "#/maintenance"
                              : "#/reservations?create=1"
                    }
                >
                    {admin
                        ? "Review requests"
                        : staff
                          ? "View my tasks"
                          : "Request a facility"}
                    <span aria-hidden="true">↗</span>
                </a>
                <button
                    className="button secondary"
                    onClick={() => setRevision((value) => value + 1)}
                >
                    Refresh
                </button>
            </PageHeader>
            <Alert>{error}</Alert>
            {error && (
                <EmptyState
                    title="We couldn't load your dashboard"
                    text="Check your connection, then use Refresh to try again."
                />
            )}
            {!data && !error && <Skeleton cards />}
            {data && (
                <>
                    {partial && (
                        <p className="notice">
                            Activity summaries include the first 1,000 visible
                            records per module. A + indicates a lower bound, not
                            a complete total.
                        </p>
                    )}
                    {!catalogs.statuses && (
                        <p className="notice">
                            Reservation status summaries will appear when the
                            status catalog is available.
                        </p>
                    )}
                    <div className={`stat-grid ${admin ? "six-stats" : ""}`}>
                        {stats.map(([label, value, icon, href]) => (
                            <StatCard
                                key={label}
                                label={label}
                                value={value ?? "—"}
                                icon={icon}
                                href={href}
                            />
                        ))}
                    </div>
                    <div className="quick-action-grid">
                        {actions.map(([icon, title, text, href]) => (
                            <a className="quick-action" key={title} href={href}>
                                <span className="quick-icon">
                                    <Icon name={icon} />
                                </span>
                                <div>
                                    <h2>{title}</h2>
                                    <p>{text}</p>
                                </div>
                                <span aria-hidden="true">→</span>
                            </a>
                        ))}
                    </div>
                    <div className="dashboard-grid">
                        <section className="panel">
                            <div className="panel-title">
                                <div>
                                    <p className="eyebrow">
                                        {admin
                                            ? "WAITING FOR REVIEW"
                                            : staff
                                              ? "YOUR WORK QUEUE"
                                              : "YOUR SCHEDULE"}
                                    </p>
                                    <h2>
                                        {admin
                                            ? "Pending reservations"
                                            : staff
                                              ? "Assigned maintenance"
                                              : "Upcoming reservations"}
                                    </h2>
                                </div>
                                <a
                                    href={
                                        staff
                                            ? "#/maintenance"
                                            : "#/reservations"
                                    }
                                >
                                    View all →
                                </a>
                            </div>
                            {!recent.length ? (
                                <EmptyState
                                    icon={
                                        staff ? "maintenance" : "reservations"
                                    }
                                    title={
                                        admin
                                            ? "You're all caught up"
                                            : staff
                                              ? "No outstanding assigned work"
                                              : "No upcoming reservations"
                                    }
                                    text={
                                        admin
                                            ? "New pending requests will appear here."
                                            : staff
                                              ? "Work assigned to you will appear in this queue."
                                              : "Browse facilities and request a space for your next activity."
                                    }
                                />
                            ) : (
                                <div className="activity-list">
                                    {recent
                                        .slice()
                                        .sort(
                                            (a, b) =>
                                                new Date(
                                                    a.startDatetime ||
                                                        a.reportedAt,
                                                ) -
                                                new Date(
                                                    b.startDatetime ||
                                                        b.reportedAt,
                                                ),
                                        )
                                        .slice(0, 5)
                                        .map((row) => (
                                            <article
                                                className="activity"
                                                key={
                                                    row.reservationId ||
                                                    row.requestId
                                                }
                                            >
                                                <span className="activity-icon">
                                                    <Icon
                                                        name={
                                                            staff
                                                                ? "maintenance"
                                                                : "reservations"
                                                        }
                                                    />
                                                </span>
                                                <div className="activity-copy">
                                                    <h3>
                                                        {purposePreview(
                                                            row.purpose ||
                                                                row.description,
                                                        )}
                                                    </h3>
                                                    <p>
                                                        {row.facilityId
                                                            ? recordName(
                                                                  row.facilityId,
                                                                  "facility",
                                                                  names,
                                                              )
                                                            : row.equipmentId
                                                              ? recordName(
                                                                    row.equipmentId,
                                                                    "equipment",
                                                                    names,
                                                                )
                                                              : "Campus request"}{" "}
                                                        ·{" "}
                                                        {formatDate(
                                                            row.startDatetime ||
                                                                row.reportedAt,
                                                        )}
                                                    </p>
                                                    <button
                                                        className="text-button"
                                                        onClick={() =>
                                                            setDetails({
                                                                ...row,
                                                                ...(row.reservationId
                                                                    ? {
                                                                          statusName:
                                                                              statusName(
                                                                                  row,
                                                                              ),
                                                                      }
                                                                    : {}),
                                                            })
                                                        }
                                                    >
                                                        View Details
                                                    </button>
                                                </div>
                                                <Badge
                                                    value={
                                                        row.status ||
                                                        statusName(row)
                                                    }
                                                />
                                            </article>
                                        ))}
                                </div>
                            )}
                        </section>
                        <section className="panel">
                            <div className="panel-title">
                                <div>
                                    <p className="eyebrow">
                                        {admin || staff
                                            ? "BORROWING WORKSPACE"
                                            : "WHAT HAPPENS NEXT"}
                                    </p>
                                    <h2>
                                        {admin || staff
                                            ? "Equipment loans"
                                            : "Request with confidence"}
                                    </h2>
                                </div>
                                {(admin || staff) && (
                                    <a href="#/loans">View all →</a>
                                )}
                            </div>
                            {admin || staff ? (
                                !loanReview.length ? (
                                    <EmptyState
                                        icon="loans"
                                        title="No loans awaiting your review"
                                        text="You cannot review your own borrowing request."
                                    />
                                ) : (
                                    <div className="activity-list">
                                        {loanReview.slice(0, 5).map((row) => (
                                            <article
                                                className="activity"
                                                key={row.loanId}
                                            >
                                                <span className="activity-icon">
                                                    <Icon name="equipment" />
                                                </span>
                                                <div className="activity-copy">
                                                    <h3>
                                                        {row.items?.length
                                                            ? recordName(
                                                                  row.items[0]
                                                                      .equipmentId,
                                                                  "equipment",
                                                                  names,
                                                              )
                                                            : "Equipment request"}
                                                        {row.items?.length > 1
                                                            ? ` + ${row.items.length - 1} more`
                                                            : ""}
                                                    </h3>
                                                    <p>
                                                        Due{" "}
                                                        {formatDate(
                                                            row.dueDate,
                                                        )}
                                                    </p>
                                                    <a
                                                        className="text-button"
                                                        href="#/loans"
                                                    >
                                                        Review borrowing request
                                                    </a>
                                                </div>
                                                <Badge value={row.loanStatus} />
                                            </article>
                                        ))}
                                    </div>
                                )
                            ) : (
                                <ol className="next-steps">
                                    <li>
                                        <span>1</span>
                                        <div>
                                            <h3>Find the right space</h3>
                                            <p>
                                                Compare facility capacity and
                                                available equipment.
                                            </p>
                                        </div>
                                    </li>
                                    <li>
                                        <span>2</span>
                                        <div>
                                            <h3>Send your request</h3>
                                            <p>
                                                Tell us your purpose and choose
                                                your local date and time.
                                            </p>
                                        </div>
                                    </li>
                                    <li>
                                        <span>3</span>
                                        <div>
                                            <h3>Wait for approval</h3>
                                            <p>
                                                Track the decision in My
                                                Reservations. Pending is not a
                                                confirmed booking.
                                            </p>
                                        </div>
                                    </li>
                                </ol>
                            )}
                        </section>
                    </div>
                </>
            )}
            {details && (
                <RecordDetails
                    row={details}
                    catalogs={names}
                    onClose={() => setDetails(null)}
                />
            )}
        </>
    );
}
