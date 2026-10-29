import React, { useRef, useState } from "react";
import { useSession } from "./session";
import { Alert } from "./components";
import { PageHeader } from "./ui";

export function AccountForm({ staff = false }) {
    const { api } = useSession();
    const [error, setError] = useState(""),
        [created, setCreated] = useState(null),
        [busy, setBusy] = useState(false),
        [visible, setVisible] = useState(false);
    const pending = useRef(false);
    async function submit(event) {
        event.preventDefault();
        if (pending.current) return;
        const form = event.currentTarget;
        const data = Object.fromEntries(new FormData(form));
        setError("");
        if (
            [...data.password].length < 15 ||
            new TextEncoder().encode(data.password).length > 72
        ) {
            setError(
                "Use a password of at least 15 characters and at most 72 UTF-8 bytes. A long, unique passphrase works well.",
            );
            return;
        }
        if (data.password !== data.passwordConfirmation) {
            setError("The password confirmation must match your password.");
            return;
        }
        pending.current = true;
        setBusy(true);
        try {
            const result = await api.request(
                staff ? "/accounts/staff" : "/auth/register",
                {
                    method: "POST",
                    body: data,
                    publicRequest: !staff,
                },
            );
            form.reset();
            setVisible(false);
            setCreated(result.user);
        } catch (failure) {
            // Clear passwords even when the outcome is uncertain; never retry automatically.
            form.elements.namedItem("password").value = "";
            form.elements.namedItem("passwordConfirmation").value = "";
            setVisible(false);
            setError(
                failure.status === 409
                    ? "Account could not be created. Try signing in or contact your administrator."
                    : failure.message,
            );
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }
    if (created)
        return (
            <section className="account-success" role="status">
                <h2>
                    {staff
                        ? "Staff account created"
                        : "You're ready to sign in"}
                </h2>
                <p>
                    {created.fname} {created.lname} can sign in using{" "}
                    <strong>{created.email}</strong>.
                </p>
                <p>
                    {staff
                        ? "Share the initial credentials directly with the staff member through an approved private channel. Passwords are never included in this response."
                        : "Your account is a Faculty / Student Organization Representative account. Your email address has not been verified."}
                </p>
                {staff ? (
                    <button
                        className="button secondary"
                        onClick={() => setCreated(null)}
                    >
                        Create another staff account
                    </button>
                ) : (
                    <a className="button primary" href="#/login">
                        Log in
                    </a>
                )}
            </section>
        );
    return (
        <>
            <Alert>{error}</Alert>
            <form onSubmit={submit} className="account-form">
                <fieldset disabled={busy}>
                    <legend className="sr-only">
                        {staff
                            ? "New staff account"
                            : "New Representative account"}
                    </legend>
                    <div className="account-name-fields">
                        <div>
                            <label htmlFor="account-fname">First name</label>
                            <input
                                id="account-fname"
                                name="fname"
                                autoComplete="given-name"
                                required
                                maxLength={120}
                            />
                        </div>
                        <div>
                            <label htmlFor="account-lname">Last name</label>
                            <input
                                id="account-lname"
                                name="lname"
                                autoComplete="family-name"
                                required
                                maxLength={120}
                            />
                        </div>
                    </div>
                    <label htmlFor="account-email">Email</label>
                    <input
                        id="account-email"
                        name="email"
                        type="email"
                        autoComplete="username"
                        required
                        maxLength={150}
                        aria-describedby="account-email-hint"
                    />
                    <p className="field-hint" id="account-email-hint">
                        New account email addresses are saved in lowercase. Use
                        that address when signing in.
                    </p>
                    <label htmlFor="account-password">
                        {staff ? "Initial password" : "Password"}
                    </label>
                    <input
                        id="account-password"
                        name="password"
                        type={visible ? "text" : "password"}
                        autoComplete="new-password"
                        required
                        aria-describedby="account-password-hint"
                    />
                    <p className="field-hint" id="account-password-hint">
                        At least 15 characters, at most 72 UTF-8 bytes. Use a
                        unique passphrase; spaces are preserved.
                    </p>
                    <button
                        type="button"
                        className="text-button"
                        aria-pressed={visible}
                        aria-controls="account-password account-confirmation"
                        onClick={() => setVisible((value) => !value)}
                    >
                        {visible ? "Hide new password" : "Show new password"}
                    </button>
                    <label htmlFor="account-confirmation">
                        Confirm password
                    </label>
                    <input
                        id="account-confirmation"
                        name="passwordConfirmation"
                        type={visible ? "text" : "password"}
                        autoComplete="new-password"
                        required
                    />
                    <button
                        className="button primary login-submit"
                        type="submit"
                    >
                        {busy
                            ? "Creating account…"
                            : staff
                              ? "Create staff account"
                              : "Create Representative account"}
                    </button>
                </fieldset>
            </form>
        </>
    );
}

export function AccountManagement() {
    return (
        <>
            <PageHeader
                title="Account Management"
                eyebrow="ADMINISTRATION"
                description="Create active Facility/Maintenance Staff accounts. Public signup creates Representative accounts only."
            />
            <section className="panel account-management">
                <h2>Create a staff account</h2>
                <p className="muted">
                    Choose a unique initial password and share it privately with
                    the intended staff member. This page cannot create
                    administrators or change existing accounts.
                </p>
                <AccountForm staff />
            </section>
        </>
    );
}
