import React from "react";
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Login } from "./App";
import { SessionProvider, roles } from "./session";
import { Badge } from "./components";
import { AppShell } from "./ui";
import { readFileSync } from "node:fs";

// The client test script runs from client/, without Vite's CSS stubbing.
const styles = readFileSync("src/styles.css", "utf8");

test("password visibility is accessible, reversible and does not submit or alter credentials", async () => {
    const request = vi.fn().mockResolvedValue({
        token: "synthetic-test-token",
        expiresIn: 900,
        user: { fname: "Fixture", role: { roleName: roles[2] } },
    });
    const apiFactory = () => ({ request, setToken: vi.fn() });
    render(
        <SessionProvider apiFactory={apiFactory}>
            <Login />
        </SessionProvider>,
    );
    const password = screen.getByLabelText("Password");
    const layout = document.querySelector(".login-layout");
    expect(layout.firstElementChild.className).toBe("login-main");
    expect(layout.lastElementChild.className).toBe("login-story");
    expect(
        document
            .querySelector(".campus-illustration")
            .getAttribute("aria-hidden"),
    ).toBe("true");
    fireEvent.change(screen.getByLabelText("Campus email"), {
        target: { value: "fixture@example.test" },
    });
    fireEvent.change(password, {
        target: { value: "synthetic-fixture-password" },
    });
    expect(password.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    expect(
        screen
            .getByRole("button", { name: "Hide password" })
            .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
    expect(password.value).toBe("synthetic-fixture-password");
    fireEvent.click(
        screen.getByRole("button", { name: /Sign in to workspace/ }),
    );
    await waitFor(() =>
        expect(request).toHaveBeenCalledWith("/auth/login", {
            method: "POST",
            publicRequest: true,
            body: {
                email: "fixture@example.test",
                password: "synthetic-fixture-password",
            },
        }),
    );
});

test("every CSS color is grayscale and no gradients are introduced", () => {
    const colors = styles.match(/#[\da-f]{3,8}\b/gi);
    expect(colors.length).toBeGreaterThan(20);
    for (const color of colors) {
        const raw = color.slice(1);
        const expanded =
            raw.length <= 4 ? [...raw].map((c) => c + c).join("") : raw;
        expect(expanded.slice(0, 2)).toBe(expanded.slice(2, 4));
        expect(expanded.slice(2, 4)).toBe(expanded.slice(4, 6));
    }
    expect(styles).not.toMatch(
        /(?:linear|radial|conic)-gradient|(?:rgb|hsl)a?\(/i,
    );
});

test.each([
    "Pending",
    "Approved",
    "Rejected",
    "Cancelled",
    "Open",
    "In Progress",
    "Resolved",
    "Returned",
])("status %s remains readable without color", (status) => {
    render(<Badge value={status} />);
    expect(screen.getByText(status).textContent).toBe(status);
});

test.each(roles)(
    "monochrome shell preserves navigation and logout for %s",
    (roleName) => {
        const logout = vi.fn();
        render(
            <AppShell
                user={{
                    fname: "Fixture",
                    lname: "User",
                    email: "fixture@example.test",
                    role: { roleName },
                }}
                route="overview"
                logout={logout}
            >
                <h1>Workspace</h1>
            </AppShell>,
        );
        expect(
            screen.getByRole("navigation", { name: "Main navigation" }),
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Calendar" })).toBeTruthy();
        fireEvent.click(screen.getByText("Sign out"));
        expect(logout).toHaveBeenCalledOnce();
    },
);
