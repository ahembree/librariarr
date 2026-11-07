// @vitest-environment happy-dom
/**
 * The manual action runs' results (`src/components/action-result-dialog.tsx`):
 * the toast is green only when nothing failed and nothing was left alone, and
 * otherwise opens a dialog listing every failed item and every episode or
 * track an action that ran left alone, each with its reason.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, isValidElement, type ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  ActionResultDialog,
  addActionResult,
  emptyActionResult,
  hasActionResultDetails,
  summarizeActionResult,
  toastActionResult,
  type ActionResultReport,
} from "@/components/action-result-dialog";

const report = (over: Partial<ActionResultReport> = {}): ActionResultReport => ({
  ...emptyActionResult("episode"),
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("summary and totals", () => {
  it("names what ran, what failed, what was left alone and what was skipped", () => {
    expect(summarizeActionResult(report({ executed: 3 }))).toBe("3 executed");
    expect(summarizeActionResult(report({ executed: 1, failed: 2, notActedOnCount: 4, skipped: 1 }))).toBe(
      "1 executed, 2 failed, 4 episodes not acted on, 1 skipped",
    );
    expect(summarizeActionResult(report({ executed: 1, notActedOnCount: 1, memberNoun: "track" }))).toBe(
      "1 executed, 1 track not acted on",
    );
  });

  it("adds a batch's counts and details", () => {
    const total = addActionResult(addActionResult(report(), {
      executed: 1, failed: 1, skipped: 2,
      failures: [{ title: "Lost", error: "HTTP 500" }],
      notActedOn: [{ title: "Survivor S15E10", reason: "numbered differently" }],
      notActedOnCount: 3,
    }), { executed: 2 });
    expect(total).toMatchObject({ executed: 3, failed: 1, skipped: 2, notActedOnCount: 3 });
    expect(total.failures).toHaveLength(1);
    expect(hasActionResultDetails(total)).toBe(true);
    expect(hasActionResultDetails(report({ executed: 5 }))).toBe(false);
  });
});

describe("toastActionResult", () => {
  it("is green only when nothing failed and nothing was left alone", () => {
    toastActionResult(report({ executed: 2 }), vi.fn());
    expect(toastMock.success).toHaveBeenCalledWith("Action complete", { description: "2 executed" });
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("warns when an action that ran left episodes alone, and opens the details from the toast", () => {
    const showDetails = vi.fn();
    const r = report({ executed: 1, notActedOn: [{ title: "Survivor S15E10", reason: "numbered differently" }], notActedOnCount: 1 });
    toastActionResult(r, showDetails);

    expect(toastMock.success).not.toHaveBeenCalled();
    const [title, opts] = toastMock.warning.mock.calls[0];
    expect(title).toBe("Action completed with problems");
    // The View Details button and the text itself both open the dialog.
    opts.action.onClick();
    expect(showDetails).toHaveBeenLastCalledWith(r);
    expect(isValidElement(opts.description)).toBe(true);
    render(opts.description as ReactElement);
    fireEvent.click(screen.getByRole("button", { name: /1 executed, 1 episode not acted on — click for details/ }));
    expect(showDetails).toHaveBeenCalledTimes(2);
  });

  it("is never green when the counts show a failure, even with no reason listed", () => {
    toastActionResult(report({ executed: 1, failed: 2 }), vi.fn());
    expect(toastMock.success).not.toHaveBeenCalled();
    const [title, opts] = toastMock.warning.mock.calls[0];
    expect(title).toBe("Action completed with problems");
    // Nothing to list, so no View Details.
    expect(opts.action).toBeUndefined();
    expect(opts.description).toBe("1 executed, 2 failed");
  });

  it("says a stopped run in one toast, with the reason, never beside a green one", () => {
    const showDetails = vi.fn();
    toastActionResult(report({ executed: 3 }), showDetails, { stopped: "The rule set was edited while its actions ran" });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.warning.mock.calls[0];
    expect(title).toBe("Action stopped part-way");
    expect(opts.description).toBe("3 executed — The rule set was edited while its actions ran");
  });

  it("is an error when nothing ran", () => {
    toastActionResult(report({ failed: 1, failures: [{ title: "Lost", error: "HTTP 500" }] }), vi.fn());
    expect(toastMock.error.mock.calls[0][0]).toBe("Action failed");
  });
});

describe("ActionResultDialog", () => {
  it("lists each failed item and each member left alone with its reason", async () => {
    await act(async () => {
      render(createElement(ActionResultDialog, {
        report: report({
          executed: 1,
          failed: 1,
          failures: [{ title: "Lost", error: "Sonarr HTTP 500" }],
          notActedOn: [{ title: "Survivor S15E10", reason: "The media server and Sonarr may number this show differently" }],
          notActedOnCount: 3,
        }),
        onOpenChange: vi.fn(),
      }));
    });
    expect(screen.getByText("Failed (1)")).toBeTruthy();
    expect(screen.getByText("Sonarr HTTP 500")).toBeTruthy();
    expect(screen.getByText("Episodes Not Acted On (3)")).toBeTruthy();
    expect(screen.getByText("Survivor S15E10")).toBeTruthy();
    expect(screen.getByText(/and 2 more episodes not listed/)).toBeTruthy();
  });
});
