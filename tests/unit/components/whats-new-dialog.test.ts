// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { WhatsNewDialog } from "@/components/whats-new-dialog";
import { shellSettingsWrapper } from "../../setup/shell-settings-wrapper";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: () => ({ connected: true, authExpired: false }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ show: false, notes: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WhatsNewDialog", () => {
  it("asks for nothing when the server layout found no dialog owed", async () => {
    render(createElement(WhatsNewDialog), { wrapper: shellSettingsWrapper({ whatsNewDue: false }) });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the release notes when the dialog is owed", async () => {
    render(createElement(WhatsNewDialog), { wrapper: shellSettingsWrapper({ whatsNewDue: true }) });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/whats-new", { priority: "low" });
  });

  it("fetches them outside the layout, where nothing is known", async () => {
    render(createElement(WhatsNewDialog));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/whats-new", { priority: "low" });
  });
});
