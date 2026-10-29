import React, { useState, useRef, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { toInstant } from "./api";
import { format, labels } from "./resources";
import {
    displayValue,
    recordName,
    recordReference,
    purposePreview,
    formatDate,
} from "./presentation";
import { useRecordNames } from "./names";
import { useSession } from "./session";
import { formErrors, fieldHints } from "./form-validation";
export function Icon({ name = "overview" }) {
    const paths = {
        overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
        buildings: "M4 21V3h12v18 M16 9h4v12 M8 7h4 M8 11h4 M8 15h4 M9 21v-3",
        facilities: "M4 21V3h16v18 M8 21V7h8v14 M13 14h1",
        equipment: "M3 7l9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10",
        reservations: "M4 5h16v16H4z M8 2v6 M16 2v6 M4 11h16 M8 15h2 M14 15h2",
        loans: "M4 8h13 M13 4l4 4-4 4 M20 16H7 M11 12l-4 4 4 4",
        maintenance: "M14 5a5 5 0 0 0-6 6L2 17l5 5 6-6a5 5 0 0 0 6-6l-4 3-4-4z",
        assignments:
            "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 22v-4a7 7 0 0 1 14 0v4 M18 4a4 4 0 0 1 0 8 M19 15a5 5 0 0 1 3 5",
        calendar: "M4 5h16v16H4z M8 2v6 M16 2v6 M4 11h16 M8 15h2 M14 15h2",
        profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 22v-3a8 8 0 0 1 16 0v3",
        search: "M21 21l-6-6 M17 10a7 7 0 1 0-14 0 7 7 0 0 0 14 0",
    };
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={paths[name] || paths.overview} />
        </svg>
    );
}
export function Alert({ children }) {
    return children ? (
        <div className="alert" role="alert">
            {children}
        </div>
    ) : null;
}
export function Badge({ value }) {
    const tone = [
        "Approved",
        "Returned",
        "Resolved",
        "Available",
        "Good",
    ].includes(value)
        ? "green"
        : ["Rejected", "Damaged", "Closed", "High"].includes(value)
          ? "red"
          : ["Pending", "Open", "Normal"].includes(value)
            ? "gold"
            : ["In Progress"].includes(value)
              ? "blue"
              : "gray";
    return <span className={`badge ${tone}`}>{value || "—"}</span>;
}
export function Modal({ title, children, onClose, busy = false }) {
    const ref = useRef(null),
        titleId = useId();
    useEffect(() => {
        const previous = document.activeElement,
            workspace = document.getElementById("workspace");
        workspace?.setAttribute("inert", "");
        ref.current?.querySelector("input,select,textarea,button")?.focus();
        return () => {
            workspace?.removeAttribute("inert");
            previous?.focus();
        };
    }, []);
    useEffect(() => {
        const dialog = ref.current,
            active = document.activeElement;
        if (
            dialog &&
            (active === dialog ||
                !dialog.contains(active) ||
                active?.matches(":disabled"))
        ) {
            const enabled = dialog.querySelector(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
            );
            (enabled || dialog).focus();
        }
    });
    function keys(event) {
        if (event.key === "Escape" && !busy) onClose();
        if (event.key === "Tab") {
            const controls = [
                ...ref.current.querySelectorAll(
                    "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
                ),
            ];
            if (!controls.length) {
                event.preventDefault();
                return;
            }
            const first = controls[0],
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
    return createPortal(
        <div className="modal-backdrop">
            <section
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                ref={ref}
                tabIndex={-1}
                onKeyDown={keys}
            >
                <div className="modal-heading">
                    <h2 id={titleId}>{title}</h2>
                    <button
                        className="icon-button"
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        aria-label="Close dialog"
                    >
                        ×
                    </button>
                </div>
                {children}
            </section>
        </div>,
        document.body,
    );
}
function optionData(list, key) {
    const ids = {
        buildings: "buildingId",
        facilities: "facilityId",
        equipment: "equipmentId",
        types: "facilityTypeId",
        categories: "categoryId",
        staff: "userId",
    };
    if (!Object.hasOwn(ids, key)) return [];
    return (Array.isArray(list) ? list : []).map((row) => ({
        id: row[ids[key]],
        label:
            row.buildingName ??
            row.facilityName ??
            row.equipmentName ??
            row.typeName ??
            row.categoryName ??
            `${row.fname} ${row.lname}`,
    }));
}
function NamedSelect({
    id,
    value,
    onChange,
    kind,
    catalogs,
    required = true,
    invalid = false,
    describedBy,
}) {
    const options = optionData(catalogs[kind], kind),
        [query, setQuery] = useState("");
    const heading =
        {
            facilities: "facilities",
            equipment: "equipment",
            buildings: "buildings",
            types: "facility types",
            categories: "categories",
            staff: "staff members",
        }[kind] || "choices";
    const matching = options.filter(
        (option) =>
            option.id === Number(value) ||
            option.label.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const selected = catalogs[kind]?.find(
        (row) =>
            row[
                {
                    facilities: "facilityId",
                    equipment: "equipmentId",
                    buildings: "buildingId",
                    types: "facilityTypeId",
                    categories: "categoryId",
                    staff: "userId",
                }[kind]
            ] === Number(value),
    );
    return (
        <div className="resource-picker">
            <label className="sr-only" htmlFor={id + "-search"}>
                Search {heading}
            </label>
            <div className="picker-search">
                <Icon name="search" />
                <input
                    id={id + "-search"}
                    type="search"
                    placeholder={"Search " + heading + "…"}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") event.preventDefault();
                    }}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
            </div>
            <select
                id={id}
                value={value ?? ""}
                onChange={onChange}
                required={required}
                aria-invalid={invalid || undefined}
                aria-describedby={describedBy}
            >
                <option value="">
                    {required
                        ? "Choose " +
                          (kind === "facilities"
                              ? "a facility"
                              : kind === "equipment"
                                ? "equipment"
                                : kind === "staff"
                                  ? "a staff member"
                                  : "an option")
                        : "Unassigned"}
                </option>
                {value &&
                    !options.some((option) => option.id === Number(value)) && (
                        <option value={value} disabled>
                            Selected record unavailable
                        </option>
                    )}
                {matching.map((option) => (
                    <option key={option.id} value={option.id}>
                        {option.label}
                    </option>
                ))}
            </select>
            {query && !matching.length && (
                <small className="picker-help">
                    No matches in the loaded choices. Try another search or load
                    more.
                </small>
            )}
            {selected && kind === "facilities" && (
                <small className="picker-help">
                    {displayValue(selected, "buildingId", catalogs)}
                    {selected.capacity
                        ? " ? Capacity " + selected.capacity
                        : ""}
                </small>
            )}
            {selected &&
                kind === "equipment" &&
                selected.availableQuantity !== undefined && (
                    <small className="picker-help">
                        {selected.availableQuantity} available of{" "}
                        {selected.totalQuantity} ?{" "}
                        {selected.conditionStatus || "Condition unavailable"}
                    </small>
                )}
            {catalogs.hasMore?.[kind] && (
                <button
                    type="button"
                    className="button subtle small"
                    disabled={catalogs.loadingMore?.[kind]}
                    onClick={() => catalogs.loadMore(kind)}
                >
                    Load more {heading}
                </button>
            )}
        </div>
    );
}
export function Editor({
    title,
    fields = [],
    initial = {},
    catalogs = {},
    loanItems = false,
    returnItems = null,
    notice,
    confirmLabel = "Save changes",
    onSubmit,
    onClose,
    formKind,
}) {
    const uid = useId();
    const api = useSession()?.api;
    const namedCatalogs = useRecordNames(
        [{ ...initial, items: returnItems || initial.items }],
        catalogs,
        api,
    );
    const [values, setValues] = useState(() =>
            Object.fromEntries(
                fields.map(([name, , type, extra]) => [
                    name,
                    initial[name] ??
                        (type === "select"
                            ? extra[0]
                            : type === "default"
                              ? extra
                              : type === "date"
                                ? new Date().toISOString().slice(0, 10)
                                : ""),
                ]),
            ),
        ),
        [entries, setEntries] = useState(
            initial.items?.map((item) => ({
                equipmentId: String(item.equipmentId),
                quantity: String(item.quantity || 1),
            })) || [{ equipmentId: "", quantity: "1" }],
        ),
        [conditions, setConditions] = useState(() =>
            Object.fromEntries(
                (returnItems || []).map((item) => [item.equipmentId, "Good"]),
            ),
        ),
        [busy, setBusy] = useState(false),
        [error, setError] = useState(""),
        [blocked, setBlocked] = useState(false),
        [conflict, setConflict] = useState(false);
    const restoreScheduleFocus = useRef(false);
    const pending = useRef(false);
    const [invalid, setInvalid] = useState({});
    const formRef = useRef(null);
    useEffect(() => {
        if (!conflict && restoreScheduleFocus.current) {
            formRef.current
                ?.querySelector('input[type="datetime-local"]')
                ?.focus();
            restoreScheduleFocus.current = false;
        }
    }, [conflict]);
    useEffect(() => {
        if (Object.keys(invalid).length)
            formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
    }, [invalid]);
    async function submit(event) {
        event.preventDefault();
        if (pending.current || blocked) return;
        const problems = formErrors(
            fields,
            values,
            loanItems ? entries : undefined,
            Date.now(),
        );
        setInvalid(problems);
        if (Object.keys(problems).length) {
            setError("Please review the highlighted fields.");
            return;
        }
        pending.current = true;
        setBusy(true);
        setError("");
        try {
            const data = {};
            for (const [name, label, type, extra] of fields) {
                const value = String(values[name] ?? "");
                if (
                    !value.trim() &&
                    !["optional", "nullableNumber"].includes(type) &&
                    !(type === "select" && extra.includes(""))
                )
                    throw Error(`${label} is required.`);
                if (type === "datetime") data[name] = toInstant(value);
                else if (
                    ["number", "quantity", "nullableNumber"].includes(type)
                ) {
                    if (type === "nullableNumber" && !value) {
                        data[name] = null;
                        continue;
                    }
                    const number = Number(value);
                    if (
                        !Number.isInteger(number) ||
                        number < (type === "quantity" ? 0 : 1) ||
                        number >
                            (typeof extra === "number" ? extra : 2147483647)
                    )
                        throw Error(`${label} must be a valid integer.`);
                    data[name] = number;
                } else if (type === "optional")
                    data[name] = value.trim() || null;
                else {
                    if (
                        typeof extra === "number" &&
                        [...value.trim()].length > extra
                    )
                        throw Error(
                            `${label} must be at most ${extra} characters.`,
                        );
                    data[name] =
                        type === "select" && !value ? null : value.trim();
                }
            }
            if (loanItems) {
                const seen = new Set();
                data.items = entries.map((item) => {
                    const equipmentId = Number(item.equipmentId),
                        quantity = Number(item.quantity);
                    if (
                        !Number.isInteger(equipmentId) ||
                        equipmentId < 1 ||
                        !Number.isInteger(quantity) ||
                        quantity < 1 ||
                        seen.has(equipmentId)
                    )
                        throw Error(
                            "Choose unique equipment IDs and positive quantities.",
                        );
                    seen.add(equipmentId);
                    return { equipmentId, quantity };
                });
            }
            if (returnItems)
                data.items = returnItems.map((item) => ({
                    equipmentId: item.equipmentId,
                    conditionIn: conditions[item.equipmentId],
                }));
            await onSubmit(data);
            onClose();
        } catch (error) {
            if (
                formKind === "reservations" &&
                error.code === "RESERVATION_SCHEDULE_CONFLICT"
            ) {
                setConflict(true);
                setBlocked(false);
                return;
            }
            setError(error.message || "Unable to complete the operation.");
            setBlocked(Boolean(error.requiresRefresh));
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }
    const chooseSchedule = () => {
        restoreScheduleFocus.current = true;
        setConflict(false);
    };
    if (conflict)
        return (
            <Modal
                key="conflict"
                title="Schedule Conflict"
                onClose={chooseSchedule}
            >
                <div className="modal-body">
                    <p>
                        The selected facility is already reserved during the
                        requested time. Choose another schedule.
                    </p>
                    <h3>
                        {recordName(
                            Number(values.facilityId),
                            "facility",
                            namedCatalogs,
                        )}
                    </h3>
                    <p>
                        {formatDate(toInstant(values.startDatetime))} to{" "}
                        {formatDate(toInstant(values.endDatetime))}
                    </p>
                    <p>
                        Your request was not created. No automatic retry was
                        made.
                    </p>
                </div>
                <div className="modal-footer">
                    <button
                        type="button"
                        className="button primary"
                        onClick={chooseSchedule}
                    >
                        Choose Another Schedule
                    </button>
                </div>
            </Modal>
        );
    return (
        <Modal key="editor" title={title} onClose={onClose} busy={busy}>
            <form ref={formRef} noValidate onSubmit={submit} aria-label={title}>
                <div className="modal-body">
                    {formKind && (
                        <div className="form-intro">
                            <span className="form-intro-icon">
                                <Icon name={formKind} />
                            </span>
                            <div>
                                <h3>
                                    {formKind === "reservations"
                                        ? "A space for your next idea"
                                        : formKind === "loans"
                                          ? "Equipment for your activity"
                                          : formKind === "maintenance"
                                            ? "Tell us what needs attention"
                                            : "Keep campus information current"}
                                </h3>
                                <p>
                                    {formKind === "reservations" ||
                                    formKind === "loans"
                                        ? "Your request will be Pending until an authorized reviewer approves it."
                                        : "Complete the details below. Required fields are marked *."}
                                </p>
                            </div>
                        </div>
                    )}
                    {notice && <p className="form-note">{notice}</p>}
                    <Alert>{error}</Alert>
                    {blocked && (
                        <p>
                            Close this dialog and refresh history before taking
                            another action.
                        </p>
                    )}
                    <fieldset
                        className="form-fields"
                        disabled={busy || blocked}
                    >
                        <legend className="sr-only">{title} fields</legend>
                        <div className="form-grid">
                            {fields.map(([name, label, type, extra]) => (
                                <div
                                    className={
                                        type === "textarea"
                                            ? "field full"
                                            : "field"
                                    }
                                    key={name}
                                >
                                    <label htmlFor={uid + name}>
                                        {name === "targetId"
                                            ? values.targetKind ===
                                              "equipmentId"
                                                ? "Equipment"
                                                : "Facility"
                                            : label}
                                        {![
                                            "optional",
                                            "nullableNumber",
                                        ].includes(type) &&
                                            !(
                                                type === "select" &&
                                                extra.includes("")
                                            ) && (
                                                <span
                                                    className="required-mark"
                                                    aria-hidden="true"
                                                >
                                                    {" "}
                                                    *
                                                </span>
                                            )}
                                    </label>
                                    {[
                                        "facilityId",
                                        "homeFacilityId",
                                        "equipmentId",
                                        "targetId",
                                    ].includes(name) ||
                                    (typeof extra === "string" &&
                                        type !== "default" &&
                                        ["number", "nullableNumber"].includes(
                                            type,
                                        )) ? (
                                        <NamedSelect
                                            id={uid + name}
                                            value={values[name]}
                                            catalogs={namedCatalogs}
                                            kind={
                                                typeof extra === "string" &&
                                                name !== "targetId"
                                                    ? extra
                                                    : name === "equipmentId" ||
                                                        (name === "targetId" &&
                                                            values.targetKind ===
                                                                "equipmentId")
                                                      ? "equipment"
                                                      : "facilities"
                                            }
                                            required={type !== "nullableNumber"}
                                            invalid={Boolean(invalid[name])}
                                            describedBy={uid + name + "-help"}
                                            onChange={(event) =>
                                                setValues({
                                                    ...values,
                                                    [name]: event.target.value,
                                                })
                                            }
                                        />
                                    ) : type === "textarea" ? (
                                        <textarea
                                            id={uid + name}
                                            rows="4"
                                            value={values[name]}
                                            onChange={(event) =>
                                                setValues({
                                                    ...values,
                                                    [name]: event.target.value,
                                                })
                                            }
                                            required
                                            aria-invalid={
                                                Boolean(invalid[name]) ||
                                                undefined
                                            }
                                            aria-describedby={
                                                uid + name + "-help"
                                            }
                                        />
                                    ) : type === "select" ? (
                                        <select
                                            id={uid + name}
                                            value={values[name] ?? ""}
                                            aria-invalid={
                                                Boolean(invalid[name]) ||
                                                undefined
                                            }
                                            aria-describedby={
                                                uid + name + "-help"
                                            }
                                            onChange={(event) =>
                                                setValues({
                                                    ...values,
                                                    [name]: event.target.value,
                                                    ...(name === "targetKind"
                                                        ? { targetId: "" }
                                                        : {}),
                                                })
                                            }
                                        >
                                            {extra.map((option) => (
                                                <option
                                                    key={option}
                                                    value={option}
                                                >
                                                    {option === "facilityId"
                                                        ? "Facility"
                                                        : option ===
                                                            "equipmentId"
                                                          ? "Equipment"
                                                          : option ||
                                                            "Unspecified"}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            id={uid + name}
                                            type={
                                                type === "datetime"
                                                    ? "datetime-local"
                                                    : type === "date"
                                                      ? "date"
                                                      : [
                                                              "number",
                                                              "quantity",
                                                              "nullableNumber",
                                                          ].includes(type)
                                                        ? "number"
                                                        : "text"
                                            }
                                            min={type === "quantity" ? 0 : 1}
                                            step={type === "datetime" ? 60 : 1}
                                            list={
                                                typeof extra === "string" &&
                                                type !== "default"
                                                    ? uid + extra
                                                    : undefined
                                            }
                                            value={values[name]}
                                            aria-invalid={
                                                Boolean(invalid[name]) ||
                                                undefined
                                            }
                                            aria-describedby={
                                                uid + name + "-help"
                                            }
                                            onChange={(event) =>
                                                setValues({
                                                    ...values,
                                                    [name]: event.target.value,
                                                })
                                            }
                                            required={
                                                ![
                                                    "optional",
                                                    "nullableNumber",
                                                ].includes(type)
                                            }
                                        />
                                    )}
                                    <div
                                        id={uid + name + "-help"}
                                        className={
                                            invalid[name]
                                                ? "field-error"
                                                : "field-hint"
                                        }
                                    >
                                        {invalid[name] ||
                                            fieldHints[name] ||
                                            ([
                                                "optional",
                                                "nullableNumber",
                                            ].includes(type)
                                                ? "Optional"
                                                : "")}
                                    </div>
                                </div>
                            ))}
                        </div>
                        {loanItems && (
                            <fieldset className="loan-items">
                                <legend>Equipment items</legend>
                                <p className="field-hint">
                                    Choose each equipment type once and set the
                                    number of units you need.
                                </p>
                                {invalid.items && (
                                    <p className="field-error" role="alert">
                                        {invalid.items}
                                    </p>
                                )}
                                {entries.map((item, index) => (
                                    <div className="item-row" key={index}>
                                        <div className="loan-equipment-choice">
                                            <label
                                                htmlFor={
                                                    uid + "equipment-" + index
                                                }
                                            >
                                                Equipment
                                            </label>
                                            <NamedSelect
                                                id={uid + "equipment-" + index}
                                                kind="equipment"
                                                catalogs={namedCatalogs}
                                                value={item.equipmentId}
                                                onChange={(event) =>
                                                    setEntries(
                                                        entries.map(
                                                            (entry, i) =>
                                                                i === index
                                                                    ? {
                                                                          ...entry,
                                                                          equipmentId:
                                                                              event
                                                                                  .target
                                                                                  .value,
                                                                      }
                                                                    : entry,
                                                        ),
                                                    )
                                                }
                                                required
                                            />
                                        </div>
                                        <label>
                                            Quantity
                                            <input
                                                type="number"
                                                min="1"
                                                value={item.quantity}
                                                onChange={(event) =>
                                                    setEntries(
                                                        entries.map(
                                                            (entry, i) =>
                                                                i === index
                                                                    ? {
                                                                          ...entry,
                                                                          quantity:
                                                                              event
                                                                                  .target
                                                                                  .value,
                                                                      }
                                                                    : entry,
                                                        ),
                                                    )
                                                }
                                                required
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            className="button subtle"
                                            disabled={entries.length === 1}
                                            onClick={() =>
                                                setEntries(
                                                    entries.filter(
                                                        (_, i) => i !== index,
                                                    ),
                                                )
                                            }
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    className="button secondary"
                                    disabled={entries.length >= 50}
                                    onClick={() =>
                                        setEntries([
                                            ...entries,
                                            { equipmentId: "", quantity: "1" },
                                        ])
                                    }
                                >
                                    + Add equipment
                                </button>
                            </fieldset>
                        )}
                        {returnItems && (
                            <div className="return-list">
                                {returnItems.map((item) => (
                                    <label key={item.equipmentId}>
                                        {recordName(
                                            item.equipmentId,
                                            "equipment",
                                            namedCatalogs,
                                        )}{" "}
                                        · quantity {item.quantity}
                                        <select
                                            value={conditions[item.equipmentId]}
                                            onChange={(event) =>
                                                setConditions({
                                                    ...conditions,
                                                    [item.equipmentId]:
                                                        event.target.value,
                                                })
                                            }
                                        >
                                            <option>Good</option>
                                            <option>Damaged</option>
                                        </select>
                                    </label>
                                ))}
                            </div>
                        )}
                    </fieldset>
                </div>
                <div className="modal-footer">
                    <button
                        type="button"
                        className="button secondary"
                        onClick={onClose}
                        disabled={busy}
                    >
                        Cancel
                    </button>
                    <button
                        className="button primary"
                        disabled={busy || blocked}
                    >
                        {busy ? "Submitting…" : confirmLabel}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
export function RecordDetails({ row, onClose, catalogs }) {
    const namedCatalogs = useRecordNames([row], catalogs, useSession()?.api);
    return (
        <Modal
            title={
                row.reservationId
                    ? "Reservation details"
                    : row.loanId
                      ? "Equipment loan details"
                      : row.requestId
                        ? "Maintenance details"
                        : row.assignmentId
                          ? "Assignment details"
                          : "Record details"
            }
            onClose={onClose}
        >
            <div className="modal-body">
                <div className="detail-intro">
                    <p className="eyebrow">{recordReference(row)}</p>
                    <h3>
                        {row.facilityName ||
                            row.equipmentName ||
                            row.buildingName ||
                            purposePreview(row.purpose || row.description)}
                    </h3>
                    <p className="reference-note">
                        Keep this reference if you need help with this record.
                    </p>
                </div>
                <dl className="detail-grid">
                    {Object.keys(labels)
                        .filter(
                            (key) =>
                                Object.hasOwn(row, key) &&
                                ![
                                    "reservationId",
                                    "loanId",
                                    "requestId",
                                    "assignmentId",
                                ].includes(key) &&
                                !(
                                    key === "facilityId" &&
                                    Object.hasOwn(row, "facilityName")
                                ) &&
                                !(
                                    key === "equipmentId" &&
                                    Object.hasOwn(row, "equipmentName")
                                ),
                        )
                        .map((key) => (
                            <div key={key}>
                                <dt>
                                    {key === "purpose"
                                        ? "Full purpose"
                                        : labels[key]}
                                </dt>
                                <dd
                                    className={
                                        key === "purpose"
                                            ? "full-purpose"
                                            : undefined
                                    }
                                >
                                    {key === "statusName"
                                        ? row[key]
                                        : displayValue(
                                              row,
                                              key,
                                              namedCatalogs,
                                              true,
                                          )}
                                </dd>
                            </div>
                        ))}
                </dl>
                {row.items && (
                    <>
                        <h3>Loan items</h3>
                        {row.items.map((item) => (
                            <p key={item.equipmentId}>
                                {recordName(
                                    item.equipmentId,
                                    "equipment",
                                    namedCatalogs,
                                )}{" "}
                                · quantity {item.quantity} · out:{" "}
                                {item.conditionOut || "—"} · in:{" "}
                                {item.conditionIn || "—"}
                            </p>
                        ))}
                    </>
                )}
                {row.logs && (
                    <>
                        <h3>Maintenance history</h3>
                        <ol className="timeline">
                            {row.logs.map((log) => (
                                <li key={log.logId}>
                                    <div>{log.actionTaken}</div>
                                    <small>
                                        Actor #{log.staffId ?? "—"} ·{" "}
                                        {format(log.loggedAt, "loggedAt")}
                                    </small>
                                </li>
                            ))}
                        </ol>
                    </>
                )}
            </div>
        </Modal>
    );
}
