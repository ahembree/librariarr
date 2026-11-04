// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ExecuteAllButton, ExecuteNowButton, HeldChip, RetryActionButton } from "@/components/held-actions";
import { heldActionsReason } from "@/lib/lifecycle/held-actions";

const SINCE = "2026-11-04T03:25:25.000Z";
const REASON = heldActionsReason(SINCE);

/** The Pending page renders these inside its TooltipProvider. */
function renderInPage(element: ReactElement) {
  return render(createElement(TooltipProvider, null, element));
}

/** Focus the control's tooltip trigger (the span a disabled button sits in) and read the tooltip. */
async function tooltipOnFocus(control: HTMLElement): Promise<string | null> {
  const trigger = control.closest("span[tabindex='0']") as HTMLElement | null;
  expect(trigger, "no focusable reason around the control").not.toBeNull();
  await act(async () => trigger!.focus());
  return (await screen.findByRole("tooltip")).textContent;
}

describe("ExecuteNowButton (a pending row's Execute)", () => {
  it("runs the action when its rule set is not held", () => {
    const onExecute = vi.fn();
    renderInPage(createElement(ExecuteNowButton, { heldSince: null, executing: false, onExecute }));
    const button = screen.getByRole("button", { name: "Execute now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Execute now");
    fireEvent.click(button);
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it("is disabled while its rule set is held, saying why instead of failing on click", async () => {
    const onExecute = vi.fn();
    renderInPage(createElement(ExecuteNowButton, { heldSince: SINCE, executing: false, onExecute }));
    const button = screen.getByRole("button", { name: "Execute now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // No native title stacked on the reason's tooltip.
    expect(button.title).toBe("");
    fireEvent.click(button);
    expect(onExecute).not.toHaveBeenCalled();
    expect(await tooltipOnFocus(button)).toBe(REASON);
  });

  it("stays disabled for an item that is gone, held or not", () => {
    renderInPage(createElement(ExecuteNowButton, { heldSince: null, executing: false, disabled: true, onExecute: vi.fn() }));
    expect((screen.getByRole("button", { name: "Execute now" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("RetryActionButton (a failed row's force-retry)", () => {
  it("retries when its rule set is not held", () => {
    const onRetry = vi.fn();
    renderInPage(createElement(RetryActionButton, { heldSince: null, retrying: false, onRetry }));
    fireEvent.click(screen.getByRole("button", { name: "Force retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("is disabled while its rule set is held, saying why", async () => {
    const onRetry = vi.fn();
    renderInPage(createElement(RetryActionButton, { heldSince: SINCE, retrying: false, onRetry }));
    const button = screen.getByRole("button", { name: "Force retry" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    expect(await tooltipOnFocus(button)).toBe(REASON);
  });
});

describe("ExecuteAllButton (a group's bulk Execute)", () => {
  it("runs the group when nothing in it is held", () => {
    const onExecuteAll = vi.fn();
    const { rerender } = renderInPage(
      createElement(ExecuteAllButton, { held: 0, heldSince: null, executing: false, onExecuteAll }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Execute All" }));
    expect(onExecuteAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/held until/)).toBeNull();

    rerender(
      createElement(TooltipProvider, null,
        createElement(ExecuteAllButton, { held: 0, heldSince: null, executing: true, onExecuteAll })),
    );
    expect((screen.getByRole("button", { name: "Executing..." }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("skips a held group's actions: disabled, saying how many it skips and why", async () => {
    const onExecuteAll = vi.fn();
    renderInPage(createElement(ExecuteAllButton, { held: 3, heldSince: SINCE, executing: false, onExecuteAll }));
    expect(screen.getByText("3 held until the next detection run")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Execute All" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onExecuteAll).not.toHaveBeenCalled();
    expect(await tooltipOnFocus(button)).toBe(REASON);
  });
});

describe("HeldChip", () => {
  it("labels a held row or group compactly, with the reason on focus", async () => {
    const { container } = renderInPage(createElement(HeldChip, { since: SINCE }));
    const chip = screen.getByText("Held");
    expect(chip.className).toMatch(/text-sky/);
    expect(container.querySelector(".lucide-circle-pause")).not.toBeNull();
    expect(await tooltipOnFocus(chip)).toBe(REASON);
  });
});
