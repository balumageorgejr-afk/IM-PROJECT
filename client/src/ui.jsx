import React, { useEffect, useRef, useState } from "react";
import { Icon, Badge } from "./components";
import { roles } from "./session";
import { displayValue, purposePreview, recordName } from "./presentation";

export function navigation(role) {
    const admin = role === roles[0],
        staff = role === roles[1];
    return [
        ["overview", "Overview"],
        ...(admin
            ? [
                  ["reservations", "Reservations"],
                  ["calendar", "Calendar"],
                  ["buildings", "Buildings"],
              ]
            : []),
        ["facilities", admin || staff ? "Facilities" : "Browse Facilities"],
        ["equipment", admin || staff ? "Equipment" : "Browse Equipment"],
        ...(!admin
            ? [
                  ["reservations", "My Reservations"],
                  ["calendar", "Calendar"],
              ]
            : []),
        ["loans", admin || staff ? "Equipment Loans" : "My Equipment Loans"],
        [
            "maintenance",
            admin
                ? "Maintenance"
                : staff
                  ? "Maintenance Tasks"
                  : "Report Maintenance",
        ],
        ...(admin || staff
            ? [["assignments", admin ? "Staff Assignments" : "My Assignments"]]
            : []),
        ...(admin ? [["accounts", "Account Management"]] : []),
        ["profile", "Profile"],
    ];
}
export function PageHeader({
    className = "",
    eyebrow = "CAMPUS SERVICES",
    title,
    description,
    children,
}) {
    return (
        <div className={`page-heading ${className}`}>
            <div>
                <p className="eyebrow">{eyebrow}</p>
                <h1>{title}</h1>
                <p className="muted page-description">{description}</p>
            </div>
            <div className="page-actions">{children}</div>
        </div>
    );
}
export function Skeleton({ label = "Loading your workspace…", cards = false }) {
    return (
        <div
            role="status"
            className={cards ? "skeleton-grid" : "skeleton-list"}
        >
            <span className="sr-only">{label}</span>
            {[1, 2, 3].map((key) => (
                <div className="skeleton" key={key}>
                    <span />
                    <span />
                    <span />
                </div>
            ))}
        </div>
    );
}
export function EmptyState({
    title = "Nothing here yet",
    text = "Your records will appear here.",
    icon = "overview",
    children,
}) {
    return (
        <div className="empty-state">
            <span className="empty-icon">
                <Icon name={icon} />
            </span>
            <h3>{title}</h3>
            <p>{text}</p>
            {children}
        </div>
    );
}
export function Toast({ children, onClose }) {
    useEffect(() => {
        if (!children) return;
        const timer = setTimeout(onClose, 6000);
        return () => clearTimeout(timer);
    }, [children, onClose]);
    return children ? (
        <div className="toast" role="status">
            <span className="toast-check" aria-hidden="true">
                ✓
            </span>
            <div>
                <strong>All set</strong>
                <p>{children}</p>
            </div>
            <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={onClose}
            >
                ×
            </button>
        </div>
    ) : null;
}
export function StatCard({ label, value, caption, icon, href }) {
    return (
        <a className="stat-card" href={href}>
            <div className="stat-top">
                <span className="stat-icon">
                    <Icon name={icon} />
                </span>
                <span aria-hidden="true">↗</span>
            </div>
            <strong>{value}</strong>
            <p>{label}</p>
            {caption && <small>{caption}</small>}
        </a>
    );
}
export function DataTable({
    rows,
    columns,
    rowKey,
    renderCell,
    renderActions,
}) {
    return (
        <div className="table-scroll">
            <table>
                <thead>
                    <tr>
                        {columns.map((column) => (
                            <th key={column.key} scope="col">
                                {column.label}
                            </th>
                        ))}
                        <th scope="col">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row[rowKey]}>
                            {columns.map((column) => (
                                <td key={column.key} data-label={column.label}>
                                    {renderCell(row, column.key)}
                                </td>
                            ))}
                            <td data-label="Actions">
                                <div className="row-actions">
                                    {renderActions(row)}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
export function ResourceCard({
    row,
    kind,
    catalogs,
    onDetails,
    onRequest,
    manage,
}) {
    const facility = kind === "facilities",
        name = facility ? row.facilityName : row.equipmentName;
    const status = facility ? row.status : row.conditionStatus;
    return (
        <article className="resource-card">
            <div
                className={`resource-art ${facility ? "space-art" : "equipment-art"}`}
            >
                <Icon name={kind} />
                <Badge value={status} />
            </div>
            <div className="resource-card-body">
                <p className="eyebrow">
                    {facility
                        ? displayValue(row, "facilityTypeId", catalogs)
                        : displayValue(row, "categoryId", catalogs)}
                </p>
                <h2>{name}</h2>
                <p className="muted">
                    {facility
                        ? `${displayValue(row, "buildingId", catalogs)} · Floor ${row.floorNumber}`
                        : recordName(row.homeFacilityId, "facility", catalogs)}
                </p>
                <div className="resource-facts">
                    {facility ? (
                        <span>
                            <strong>{row.capacity}</strong> people
                        </span>
                    ) : (
                        <>
                            <span>
                                <strong>{row.availableQuantity}</strong>{" "}
                                available
                            </span>
                            <span>{row.totalQuantity} total</span>
                        </>
                    )}
                </div>
                <div className="card-actions">
                    <button className="button secondary" onClick={onDetails}>
                        View Details
                    </button>
                    {onRequest && (
                        <button className="button primary" onClick={onRequest}>
                            {facility ? "Reserve space" : "Borrow equipment"}
                        </button>
                    )}
                    {manage}
                </div>
            </div>
        </article>
    );
}
export function AppShell({ user, route, logout, children }) {
    const [mobile, setMobile] = useState(false),
        [collapsed, setCollapsed] = useState(false);
    const toggle = useRef(null),
        nav = useRef(null),
        content = useRef(null);
    const links = navigation(user.role.roleName),
        title = links.find(([key]) => key === route)?.[1] || "Campus workspace";
    const shortRole =
        user.role.roleName === roles[0]
            ? "Administrator"
            : user.role.roleName === roles[1]
              ? "Maintenance staff"
              : "Campus representative";
    useEffect(() => {
        setMobile(false);
        document.getElementById("main-content")?.focus();
    }, [route]);
    useEffect(() => {
        const resize = () => {
            if (window.innerWidth > 900) setMobile(false);
        };
        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, []);
    useEffect(() => {
        if (mobile) {
            content.current?.setAttribute("inert", "");
            nav.current?.querySelector("a")?.focus();
        } else content.current?.removeAttribute("inert");
        return () => content.current?.removeAttribute("inert");
    }, [mobile]);
    function close() {
        setMobile(false);
        toggle.current?.focus();
    }
    function navKeys(event) {
        if (!mobile) return;
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        }
        if (event.key === "Tab") {
            const controls = [...nav.current.querySelectorAll("a,button")],
                first = controls[0],
                last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }
    return (
        <div
            id="workspace"
            className={`workspace ${collapsed ? "is-collapsed" : ""}`}
        >
            <a
                className="skip-link"
                href="#main-content"
                onClick={(event) => {
                    event.preventDefault();
                    document.getElementById("main-content")?.focus();
                }}
            >
                Skip to content
            </a>
            {mobile && (
                <button
                    className="sidebar-backdrop"
                    aria-label="Close navigation overlay"
                    tabIndex={-1}
                    onClick={close}
                />
            )}
            <aside
                className={`sidebar ${mobile ? "open" : ""}`}
                ref={nav}
                onKeyDown={navKeys}
            >
                <a href="#/overview" className="brand">
                    <span className="brand-mark">
                        <Icon name="facilities" />
                    </span>
                    <span className="brand-copy">
                        Campus<span>FACILITIES & SERVICES</span>
                    </span>
                </a>
                <div className="sidebar-context">
                    <span className="access-dot" />
                    <span>{shortRole} workspace</span>
                </div>
                <p className="nav-label">YOUR WORKSPACE</p>
                <nav aria-label="Main navigation">
                    {links.map(([key, label]) => (
                        <a
                            key={key}
                            href={"#/" + key}
                            className={route === key ? "active" : ""}
                            aria-current={route === key ? "page" : undefined}
                            title={collapsed ? label : undefined}
                            aria-label={label}
                            onClick={() => setMobile(false)}
                        >
                            <Icon name={key} />
                            <span className="nav-text">{label}</span>
                        </a>
                    ))}
                </nav>
                <div className="sidebar-foot">
                    <strong>Need a hand?</strong>
                    <p>
                        Contact your campus administrator for account or request
                        assistance.
                    </p>
                </div>
                <button
                    className="collapse-sidebar"
                    onClick={() => setCollapsed(!collapsed)}
                    aria-label={
                        collapsed ? "Expand sidebar" : "Collapse sidebar"
                    }
                >
                    <span aria-hidden="true">{collapsed ? "→" : "←"}</span>
                    <span className="nav-text">Collapse sidebar</span>
                </button>
                {mobile && (
                    <button
                        className="button secondary mobile-nav-close"
                        onClick={close}
                    >
                        Close navigation
                    </button>
                )}
            </aside>
            <div className="workspace-content" ref={content}>
                <header className="topbar">
                    <div className="topbar-left">
                        <button
                            ref={toggle}
                            className="icon-button mobile-menu"
                            aria-label="Toggle navigation"
                            aria-expanded={mobile}
                            onClick={() => setMobile(!mobile)}
                        >
                            ☰
                        </button>
                        <div className="breadcrumb">
                            Campus workspace <span>/</span>
                            <strong>{title}</strong>
                        </div>
                    </div>
                    <details className="account">
                        <summary aria-label="Account menu">
                            <span className="avatar">
                                {user.fname?.slice(0, 1)}
                                {user.lname?.slice(0, 1)}
                            </span>
                            <span className="account-copy">
                                <strong>
                                    {user.fname} {user.lname}
                                </strong>
                                <small>{shortRole}</small>
                            </span>
                            <span aria-hidden="true">⌄</span>
                        </summary>
                        <div className="account-menu">
                            <p className="muted">Signed in as</p>
                            <strong>{user.email}</strong>
                            <a href="#/profile">View profile</a>
                            <button
                                className="button secondary"
                                onClick={logout}
                            >
                                Sign out
                            </button>
                        </div>
                    </details>
                </header>
                <main className="main-content" id="main-content" tabIndex={-1}>
                    {children}
                </main>
                <footer className="page-footer">
                    Campus Facility Management System
                    <span>IM101 · Your campus, connected.</span>
                </footer>
            </div>
        </div>
    );
}
export function Profile({ user, logout }) {
    return (
        <>
            <PageHeader
                title="Your profile"
                description="Your campus identity and access, all in one place."
            />
            <section className="panel profile-panel">
                <div className="profile-identity">
                    <span className="avatar large">
                        {user.fname?.slice(0, 1)}
                        {user.lname?.slice(0, 1)}
                    </span>
                    <h2>
                        {user.fname} {user.lname}
                    </h2>
                    <p>{user.email}</p>
                    <span className="role-pill">{user.role.roleName}</span>
                </div>
                <div className="profile-details">
                    <h2>Account & access</h2>
                    <p>
                        Your permissions are managed by your campus
                        administrator. Contact them to update your account or
                        reset your password.
                    </p>
                    <h3>Private by design</h3>
                    <p>
                        Your session stays in memory and lasts up to 15 minutes.
                        Refreshing the page signs you out. Sign out when using a
                        shared computer.
                    </p>
                    <button className="button secondary" onClick={logout}>
                        Sign out of this device
                    </button>
                </div>
            </section>
        </>
    );
}
export const requestLink = (kind, id) =>
    `#/${kind === "facilities" ? "reservations" : "loans"}?create=1&${kind === "facilities" ? "facility" : "equipment"}=${id}`;
export const rowTitle = (row) =>
    row.facilityName ||
    row.equipmentName ||
    row.buildingName ||
    (row.purpose
        ? purposePreview(row.purpose)
        : row.description
          ? purposePreview(row.description)
          : "Campus request");
