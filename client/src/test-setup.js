import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
afterEach(() => {
    cleanup();
    window.location.hash = "";
    if (typeof document !== "undefined" && document.cookie) {
        for (const cookie of document.cookie.split(";")) {
            const eq = cookie.indexOf("=");
            const name = eq > -1 ? cookie.slice(0, eq).trim() : cookie.trim();
            if (name) document.cookie = `${name}=; path=/; max-age=0`;
        }
    }
});
