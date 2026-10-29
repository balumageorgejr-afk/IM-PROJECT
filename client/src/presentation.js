const dateFields = new Set([
    "startDatetime",
    "endDatetime",
    "dueDate",
    "returnDate",
    "createdAt",
    "requestedAt",
    "reportedAt",
    "resolvedAt",
    "loggedAt",
]);
export function formatDate(value, dateOnly = false) {
    if (value === null || value === undefined || value === "") return "—";
    if (dateOnly) {
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(String(value));
        if (!match) return "Unavailable";
        const [, year, month, day] = match;
        const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
        if (
            !Number.isFinite(date.getTime()) ||
            date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
        )
            return "Unavailable";
        return `${month}/${day}/${year}`;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Unavailable";
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
        })
            .formatToParts(date)
            .map(({ type, value }) => [type, value]),
    );
    return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}
export function formatValue(value, key) {
    if (value === null || value === undefined || value === "") return "—";
    if (["assignedDate", "unassignedDate"].includes(key))
        return formatDate(value, true);
    return dateFields.has(key) ? formatDate(value) : String(value);
}
export function purposePreview(value, limit = 64) {
    const line = String(value || "")
        .split(/\r?\n/)
        .map((part) => part.trim())
        .find(Boolean);
    if (!line) return "Untitled reservation";
    const segment = line.split(/(?<=[.!?])\s+|;\s+/)[0];
    if ([...segment].length <= limit) return segment;
    const cut = [...segment].slice(0, limit).join("");
    const wholeWords = cut.replace(/\s+\S*$/, "");
    return (
        ([...wholeWords].length >= limit / 2 ? wholeWords : cut).trimEnd() + "…"
    );
}
export function recordName(id, kind, catalogs = {}) {
    if (id === null || id === undefined || id === "") return "—";
    const facility = kind === "facility";
    const row = (catalogs[facility ? "facilities" : "equipment"] || []).find(
        (item) => item[facility ? "facilityId" : "equipmentId"] === Number(id),
    );
    return (
        row?.[facility ? "facilityName" : "equipmentName"] ||
        (facility ? "Facility unavailable" : "Equipment unavailable")
    );
}
export function displayValue(row, key, catalogs, fullPurpose = false) {
    const lookups = {
        buildingId: [
            "buildings",
            "buildingId",
            "buildingName",
            "Building unavailable",
        ],
        categoryId: [
            "categories",
            "categoryId",
            "categoryName",
            "Category unavailable",
        ],
        facilityTypeId: [
            "types",
            "facilityTypeId",
            "typeName",
            "Type unavailable",
        ],
    };
    if (Object.hasOwn(lookups, key)) {
        if (row[key] === null || row[key] === undefined) return "—";
        const [collection, id, name, fallback] = lookups[key];
        return (
            catalogs?.[collection]?.find((item) => item[id] === row[key])?.[
                name
            ] || fallback
        );
    }
    if (
        [
            "userId",
            "requestedBy",
            "reportedBy",
            "staffId",
            "assignedStaffId",
            "approvedBy",
        ].includes(key)
    ) {
        if (row[key] === null || row[key] === undefined) return "Unassigned";
        if (row[key] === catalogs?.viewer?.userId) return "You";
        const person = catalogs?.staff?.find(
            (item) => item.userId === row[key],
        );
        return person
            ? `${person.fname} ${person.lname}`
            : key === "assignedStaffId" || key === "staffId"
              ? "Campus staff member"
              : "Another campus account";
    }
    if (["reservationId", "loanId", "requestId", "assignmentId"].includes(key))
        return recordReference(row);
    if (["facilityId", "homeFacilityId"].includes(key))
        return recordName(row[key], "facility", catalogs);
    if (key === "equipmentId")
        return recordName(row[key], "equipment", catalogs);
    if (key === "purpose" && !fullPurpose) return purposePreview(row[key]);
    return formatValue(row[key], key);
}
export function recordReference(row) {
    const key = ["reservationId", "loanId", "requestId", "assignmentId"].find(
        (key) => row[key] !== null && row[key] !== undefined,
    );
    return key
        ? `${{ reservationId: "RES", loanId: "LOAN", requestId: "MNT", assignmentId: "ASG" }[key]}-${String(row[key]).padStart(6, "0")}`
        : "Campus record";
}
