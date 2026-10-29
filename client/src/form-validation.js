import { toInstant } from "./api";
// Feedback only; backend validation and approved transaction rules remain authoritative.
export function formErrors(fields, values, items, now) {
    const errors = {},
        times = {};
    for (const [key, label, type, extra] of fields) {
        const value = String(values[key] ?? "").trim();
        const optional =
            ["optional", "nullableNumber"].includes(type) ||
            (type === "select" && extra.includes(""));
        if (!value) {
            if (!optional) errors[key] = `${label} is required.`;
            continue;
        }
        if (["number", "quantity", "nullableNumber"].includes(type)) {
            const n = Number(value);
            if (
                !Number.isInteger(n) ||
                n < (type === "quantity" ? 0 : 1) ||
                n > (typeof extra === "number" ? extra : 2147483647)
            )
                errors[key] = `Choose a valid ${label.toLowerCase()}.`;
        } else if (type === "datetime") {
            try {
                times[key] = Date.parse(toInstant(value));
            } catch {
                errors[key] = "Choose a valid local date and time.";
            }
        } else if (typeof extra === "number" && [...value].length > extra)
            errors[key] = `Use ${extra} characters or fewer.`;
    }
    if (times.startDatetime !== undefined && times.startDatetime <= now)
        errors.startDatetime = "Choose a start time in the future.";
    if (times.startDatetime !== undefined && times.endDatetime !== undefined) {
        if (times.endDatetime <= times.startDatetime)
            errors.endDatetime = "End time must be after start time.";
        else if (times.endDatetime - times.startDatetime > 8 * 3600000)
            errors.endDatetime = "A reservation can be up to 8 hours long.";
        else if (
            times.startDatetime > now + 90 * 86400000 ||
            times.endDatetime > now + 90 * 86400000
        )
            errors.endDatetime = "Choose both times within the next 90 days.";
    }
    if (
        times.dueDate !== undefined &&
        (times.dueDate <= now || times.dueDate > now + 90 * 86400000)
    )
        errors.dueDate = "Choose a future due date within 90 days.";
    if (
        values.totalQuantity !== undefined &&
        values.availableQuantity !== undefined &&
        Number(values.availableQuantity) > Number(values.totalQuantity)
    )
        errors.availableQuantity =
            "Available quantity cannot exceed total quantity.";
    if (items) {
        const seen = new Set();
        if (!items.length) errors.items = "Add at least one equipment item.";
        for (const item of items) {
            const id = Number(item.equipmentId),
                quantity = Number(item.quantity);
            if (
                !Number.isInteger(id) ||
                id < 1 ||
                id > 2147483647 ||
                !Number.isInteger(quantity) ||
                quantity < 1 ||
                quantity > 2147483647
            )
                errors.items =
                    "Choose equipment and a positive whole quantity for each item.";
            else if (seen.has(id))
                errors.items =
                    "Each equipment type can be added once. Adjust its quantity instead.";
            seen.add(id);
        }
    }
    return errors;
}
export const fieldHints = {
    facilityId:
        "Choose a space by name. Search the loaded choices to narrow your options.",
    purpose:
        "What are you planning? A short first line makes your request easy to recognize.",
    startDatetime:
        "Choose your local date and time. Maximum booking duration is 8 hours.",
    endDatetime:
        "Must be after the start, with both times within the next 90 days.",
    dueDate: "When will you return every item? Choose a date within 90 days.",
    description: "Tell maintenance what happened and where to find the issue.",
    actionTaken:
        "Describe the work completed and anything the next person should know.",
    totalQuantity: "Total units in this equipment pool.",
    availableQuantity:
        "Units currently available. Check active loans before adjusting stock.",
    assignedDate: "Assignments use calendar dates in UTC.",
    unassignedDate: "Ending an assignment preserves its history.",
    staffId: "Only active maintenance staff can be assigned.",
    locationNote: "Optional directions that help people find the building.",
    priority: "Use High for urgent work; Normal for routine requests.",
};
