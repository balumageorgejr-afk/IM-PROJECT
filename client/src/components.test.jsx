import React from "react";
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Editor } from "./components";

test("blocked mutations retain keyboard focus when the submit control is disabled", async () => {
    let rejectWrite;
    const onClose = vi.fn();
    render(
        <Editor
            title="Approve fixture"
            fields={[]}
            onSubmit={() =>
                new Promise((_, reject) => {
                    rejectWrite = reject;
                })
            }
            onClose={onClose}
        />,
    );
    const submit = screen.getByRole("button", { name: "Save changes" });
    submit.focus();
    fireEvent.click(submit);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
    });
    dialog.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    await act(async () => {
        rejectWrite(
            Object.assign(Error("Refresh history before retrying."), {
                requiresRefresh: true,
            }),
        );
    });
    const close = screen.getByRole("button", { name: "Close dialog" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(submit.disabled).toBe(true);
    expect(document.activeElement).toBe(close);
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
});
