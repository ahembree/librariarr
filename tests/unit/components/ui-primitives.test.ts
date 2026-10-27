// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Save, Trash2, Film } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LoadingButton } from "@/components/loading-button";
import { PageHeader } from "@/components/page-header";
import { InlineError } from "@/components/inline-error";
import { ConnectionTestResult, connectionTestLabel } from "@/components/connection-test-result";
import { UserAvatar } from "@/components/user-avatar";
import { DayOfWeekPicker } from "@/components/day-of-week-picker";

describe("LoadingButton", () => {
  it("shows the icon, then a spinner in its place while loading, disabled", () => {
    const { rerender, container } = render(createElement(LoadingButton, { icon: Save }, "Save"));
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(container.querySelector(".lucide-save")).not.toBeNull();
    rerender(createElement(LoadingButton, { icon: Save, loading: true }, "Save"));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector(".lucide-save")).toBeNull();
  });

  it("stays disabled when the caller disables it, and renders no icon without one", () => {
    const { container } = render(createElement(LoadingButton, { disabled: true }, "Go"));
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  function setup(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
    const onOpenChange = vi.fn();
    const onConfirm = props.onConfirm ?? vi.fn();
    render(
      createElement(
        ConfirmDialog,
        {
          open: true,
          onOpenChange,
          title: "Delete rule set?",
          description: "This cannot be undone.",
          confirmLabel: "Delete",
          destructive: true,
          onConfirm,
          ...props,
        },
        props.children,
      ),
    );
    return { onOpenChange, onConfirm };
  }

  it("asks the question and runs the action, closing at once for a plain callback", () => {
    const { onConfirm, onOpenChange } = setup();
    expect(screen.getByText("Delete rule set?")).toBeTruthy();
    expect(screen.getByText("This cannot be undone.")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm.getAttribute("data-variant")).toBe("destructive");
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open and spinning while an async action runs, then closes", async () => {
    let finish!: (v?: unknown) => void;
    const { onOpenChange } = setup({ onConfirm: () => new Promise((r) => { finish = r; }) });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open when the action answers false or fails", async () => {
    const failing = setup({ onConfirm: () => Promise.resolve(false) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect(failing.onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables both buttons while the caller's own action is pending, and holds the confirm on a requirement", () => {
    setup({ pending: true, children: createElement("p", null, "Extra detail") });
    expect(screen.getByText("Extra detail")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("can hold only the confirm button", () => {
    setup({ confirmDisabled: true, confirmIcon: Trash2, destructive: false });
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Delete" }).getAttribute("data-variant")).toBe("default");
  });
});

describe("PageHeader", () => {
  it("renders the page's h1 in the shared style, with its parts", () => {
    render(
      createElement(PageHeader, {
        title: "Movies",
        icon: Film,
        meta: createElement("span", null, "12 movies"),
        description: "Browse your movie library",
        actions: createElement("button", null, "Sync"),
      }),
    );
    const h1 = screen.getByRole("heading", { level: 1, name: "Movies" });
    expect(h1.className).toContain("text-2xl sm:text-3xl font-bold font-display tracking-tight");
    expect(screen.getByText("12 movies")).toBeTruthy();
    expect(screen.getByText("Browse your movie library")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sync" })).toBeTruthy();
  });

  it("stacks the actions on a phone unless they stay inline", () => {
    const { container, rerender } = render(createElement(PageHeader, { title: "X", actions: "a" }));
    expect((container.firstChild as HTMLElement).className).toContain("flex-col");
    rerender(createElement(PageHeader, { title: "X", actions: "a", actionsInline: true }));
    expect((container.firstChild as HTMLElement).className).not.toContain("flex-col");
  });
});

describe("InlineError and ConnectionTestResult", () => {
  it("shows an error as an alert", () => {
    // The props type requires `children`, which lint wants as the third argument.
    const props = { multiline: true } as Parameters<typeof InlineError>[0];
    render(createElement(InlineError, props, "Something broke"));
    expect(screen.getByRole("alert").textContent).toBe("Something broke");
  });

  it("writes a banner and a badge for each outcome", () => {
    const { rerender } = render(createElement(ConnectionTestResult, { result: { ok: true } }));
    expect(screen.getByRole("status").textContent).toBe("Connection successful");
    rerender(createElement(ConnectionTestResult, { result: { ok: false, error: "timeout" } }));
    expect(screen.getByRole("status").textContent).toBe("Connection failed — timeout");
    rerender(createElement(ConnectionTestResult, { result: { ok: false } }));
    expect(screen.getByRole("status").textContent).toBe("Connection failed");
    rerender(
      createElement(ConnectionTestResult, {
        result: { ok: true, appName: "Radarr", version: "5.2", serverCount: 1 },
        variant: "badge",
      }),
    );
    expect(screen.getByRole("status").textContent).toBe("Connected to Radarr v5.2 · 1 server");
  });

  it("labels badge outcomes", () => {
    expect(connectionTestLabel({ ok: true })).toBe("Connected");
    expect(connectionTestLabel({ ok: true, serverCount: 3 })).toBe("Connected · 3 servers");
    expect(connectionTestLabel({ ok: false, error: "401" })).toBe("Failed: 401");
  });
});

describe("UserAvatar", () => {
  it("shows the initial at the size asked for, hidden from assistive tech", () => {
    const { container } = render(createElement(UserAvatar, { name: "alice", size: "lg" }));
    const span = container.firstChild as HTMLElement;
    expect(span.textContent).toBe("A");
    expect(span.className).toContain("h-9 w-9");
    expect(span.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DayOfWeekPicker", () => {
  it("toggles a day without submitting the form around it", () => {
    const onToggle = vi.fn();
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const form = document.createElement("form");
    form.addEventListener("submit", onSubmit);
    document.body.appendChild(form);
    render(createElement(DayOfWeekPicker, { value: [1, 3], onToggle }), { container: form });
    const mon = screen.getByRole("button", { name: "Mon" });
    expect(mon.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Tue" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Sun" }));
    expect(onToggle).toHaveBeenCalledWith(0);
    expect(onSubmit).not.toHaveBeenCalled();
    form.remove();
  });
});
