// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("requestIdleCallback", undefined);
});

afterEach(() => {
  vi.doUnmock("@/components/reauth-dialog");
  vi.unstubAllGlobals();
});

describe("ReauthDialogHost", () => {
  it("shows the prompt when one is asked for", async () => {
    vi.doMock("@/components/reauth-dialog", () => ({
      ReauthDialog: () => createElement("span", null, "prompt"),
    }));
    const { ReauthDialogHost } = await import("@/components/reauth-dialog-host");
    const { confirmIdentity } = await import("@/lib/auth/reauth-client");
    const { container } = render(createElement(ReauthDialogHost));
    await act(async () => {
      void confirmIdentity(["password"]);
    });
    expect(container.textContent).toBe("prompt");
  });

  it("answers a prompt it cannot load with false rather than leaving its caller waiting", async () => {
    vi.doMock("@/components/reauth-dialog", () => {
      throw new Error("chunk failed to load");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ReauthDialogHost } = await import("@/components/reauth-dialog-host");
    const { confirmIdentity } = await import("@/lib/auth/reauth-client");
    render(createElement(ReauthDialogHost));
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = confirmIdentity(["password"]);
    });
    await expect(answer).resolves.toBe(false);
    error.mockRestore();
  });
});
