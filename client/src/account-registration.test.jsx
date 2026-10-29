import React from "react";
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionProvider, roles } from "./session";
import { Login } from "./App";
import { AccountManagement } from "./AccountForm";
import { navigation } from "./ui";

function mount(staff = false, response) {
    const request = vi.fn().mockImplementation(
        response ||
            (async () => ({
                success: true,
                user: {
                    fname: "Test",
                    lname: "Person",
                    email: "test@example.test",
                },
            })),
    );
    const apiFactory = () => ({ request, setToken: vi.fn() });
    render(
        <SessionProvider apiFactory={apiFactory}>
            {staff ? <AccountManagement /> : <Login signup />}
        </SessionProvider>,
    );
    return request;
}
function fill(password = "Synthetic passphrase 827!", confirmation = password) {
    for (const [label, value] of [
        ["First name", "Test"],
        ["Last name", "Person"],
        ["Email", "test@example.test"],
        [/^(Initial password|Password)$/, password],
        ["Confirm password", confirmation],
    ])
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

test("signup retains left form/right panel, login navigation and fixed Representative registration", async () => {
    const request = mount();
    expect(
        document.querySelector(".login-layout").firstElementChild.className,
    ).toBe("login-main");
    expect(
        screen.getByRole("link", { name: "Log In" }).getAttribute("href"),
    ).toBe("#/login");
    fill();
    fireEvent.click(
        screen.getByRole("button", { name: "Create Representative account" }),
    );
    await waitFor(() =>
        expect(screen.getByText("You're ready to sign in")).toBeTruthy(),
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("/auth/register", {
        method: "POST",
        publicRequest: true,
        body: {
            fname: "Test",
            lname: "Person",
            email: "test@example.test",
            password: "Synthetic passphrase 827!",
            passwordConfirmation: "Synthetic passphrase 827!",
        },
    });
    expect(screen.getByText(/has not been verified/)).toBeTruthy();
    expect(screen.queryByText("Synthetic passphrase 827!")).toBeNull();
});

test("invalid or mismatched passwords prevent submission with helpful errors", () => {
    const request = mount();
    fill("short");
    fireEvent.click(
        screen.getByRole("button", { name: "Create Representative account" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(/15 characters/);
    fill("Synthetic passphrase 827!", "Different passphrase");
    fireEvent.click(
        screen.getByRole("button", { name: "Create Representative account" }),
    );
    expect(screen.getByRole("alert").textContent).toMatch(
        /confirmation must match/,
    );
    expect(request).not.toHaveBeenCalled();
});

test("staff form uses protected route, never sends role or activity flags, clears credentials on success", async () => {
    const request = mount(true);
    fill();
    fireEvent.click(
        screen.getByRole("button", { name: "Create staff account" }),
    );
    await waitFor(() =>
        expect(screen.getByText("Staff account created")).toBeTruthy(),
    );
    expect(request.mock.calls[0][0]).toBe("/accounts/staff");
    expect(request.mock.calls[0][1].publicRequest).toBe(false);
    expect(Object.keys(request.mock.calls[0][1].body).sort()).toEqual([
        "email",
        "fname",
        "lname",
        "password",
        "passwordConfirmation",
    ]);
    fireEvent.click(
        screen.getByRole("button", { name: "Create another staff account" }),
    );
    expect(screen.getByLabelText("Initial password").value).toBe("");
});

test("password visibility does not submit, and pending submissions cannot duplicate requests", async () => {
    let resolve;
    const request = mount(
        false,
        () =>
            new Promise((done) => {
                resolve = done;
            }),
    );
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Show new password" }));
    expect(screen.getByLabelText("Password").type).toBe("text");
    expect(request).not.toHaveBeenCalled();
    const form = screen.getByLabelText("Password").closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(request).toHaveBeenCalledTimes(1);
    expect(
        screen
            .getByRole("button", { name: "Creating account…" })
            .matches(":disabled"),
    ).toBe(true);
    resolve({
        success: true,
        user: { fname: "Test", lname: "Person", email: "test@example.test" },
    });
    await waitFor(() =>
        expect(screen.getByText("You're ready to sign in")).toBeTruthy(),
    );
});

test("failed registration clears passwords, displays safe errors and never automatically retries", async () => {
    const request = mount(false, async () => {
        throw Object.assign(new Error("Synthetic duplicate failure"), {
            status: 409,
        });
    });
    fill();
    fireEvent.click(
        screen.getByRole("button", { name: "Create Representative account" }),
    );
    await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toMatch(/Try signing in/),
    );
    expect(screen.getByLabelText("Password").value).toBe("");
    expect(screen.getByLabelText("Confirm password").value).toBe("");
    expect(request).toHaveBeenCalledTimes(1);
});

test.each(roles)(
    "account management navigation is administrator-only for %s",
    (role) => {
        expect(navigation(role).some(([key]) => key === "accounts")).toBe(
            role === roles[0],
        );
    },
);
