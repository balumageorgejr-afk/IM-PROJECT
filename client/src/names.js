import { useEffect, useMemo, useState } from "react";
const empty = [];
// Resolve only missing public catalog names through existing authenticated reads.
// These requests never broaden reservation/loan ownership or fetch related users.
export function useRecordNames(rows, catalogs = {}, api) {
    const facilities = catalogs.facilities || empty,
        equipment = catalogs.equipment || empty;
    const ids = { facilities: new Set(), equipment: new Set() };
    for (const row of rows) {
        for (const key of ["facilityId", "homeFacilityId"])
            if (row[key]) ids.facilities.add(row[key]);
        if (row.equipmentId) ids.equipment.add(row.equipmentId);
        for (const item of row.items || []) ids.equipment.add(item.equipmentId);
    }
    const key = JSON.stringify(
        Object.fromEntries(
            Object.entries(ids).map(([kind, set]) => [
                kind,
                [...set].sort((a, b) => a - b),
            ]),
        ),
    );
    const [extra, setExtra] = useState({ facilities: [], equipment: [] });
    useEffect(() => {
        const controller = new AbortController();
        const missing = Object.entries(JSON.parse(key)).flatMap(
            ([kind, values]) => {
                const field =
                    kind === "facilities" ? "facilityId" : "equipmentId";
                const known = kind === "facilities" ? facilities : equipment;
                return values
                    .filter(
                        (id) =>
                            Number.isInteger(id) &&
                            id > 0 &&
                            id <= 2147483647 &&
                            !known.some((row) => row[field] === id),
                    )
                    .map((id) => ({ kind, id, field }));
            },
        );
        const resolved = { facilities: [], equipment: [] };
        let cursor = 0;
        async function worker() {
            while (
                api &&
                cursor < missing.length &&
                !controller.signal.aborted
            ) {
                const { kind, id, field } = missing[cursor++];
                try {
                    const data = await api.request(`/${kind}/${id}`, {
                        signal: controller.signal,
                    });
                    const row =
                        data[kind === "facilities" ? "facility" : "equipment"];
                    const name =
                        kind === "facilities"
                            ? "facilityName"
                            : "equipmentName";
                    if (row?.[field] === id && typeof row[name] === "string")
                        resolved[kind].push({ [field]: id, [name]: row[name] });
                } catch {
                    /* Missing/inaccessible names use a neutral label, never a raw ID. */
                }
            }
        }
        Promise.all(
            Array.from({ length: Math.min(4, missing.length) }, worker),
        ).then(() => {
            if (!controller.signal.aborted) setExtra(resolved);
        });
        return () => controller.abort();
    }, [key, facilities, equipment, api]);
    return useMemo(
        () => ({
            ...catalogs,
            facilities: [...facilities, ...extra.facilities],
            equipment: [...equipment, ...extra.equipment],
        }),
        [catalogs, facilities, equipment, extra],
    );
}
