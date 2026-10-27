// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
const fetchWithReauth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/reauth-client", () => ({ fetchWithReauth }));

import { useIntegrationInstances } from "@/app/(authenticated)/settings/use-integration-instances";
import type { IntegrationBehavior, IntegrationInstance } from "@/app/(authenticated)/settings/integration-instances";
import { MASKED_VALUE } from "@/lib/api/sanitize";

const SONARR: IntegrationBehavior = {
  type: "sonarr",
  label: "Sonarr",
  hasExternalUrl: true,
  testBeforeAdd: true,
  toggleNoun: "integration",
};
const TRACEARR: IntegrationBehavior = {
  type: "tracearr",
  label: "Tracearr",
  hasExternalUrl: false,
  testBeforeAdd: false,
  toggleNoun: "Tracearr",
};

const instance = (overrides: Partial<IntegrationInstance> = {}): IntegrationInstance => ({
  id: "a",
  name: "Main",
  url: "http://sonarr.lan:8989",
  apiKey: MASKED_VALUE,
  externalUrl: null,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

/** A response that answers only when `resolve` is called. */
function deferred() {
  let resolve!: (body: unknown) => void;
  const response = new Promise((r) => {
    resolve = (body) => r(json(body));
  });
  return { response, resolve };
}

const fetchMock = vi.fn();
const refresh = vi.fn(async () => {});
const onUpdated = vi.fn();

function setup(behavior: IntegrationBehavior = SONARR, instances = [instance(), instance({ id: "b", name: "4K" })]) {
  return renderHook(() => useIntegrationInstances(behavior, { instances, refresh, onUpdated }));
}

const bodyOf = (mock: typeof fetchMock, call = 0) => JSON.parse(mock.mock.calls[call][1].body);

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(json({}));
  fetchWithReauth.mockReset().mockResolvedValue(json({ ok: true }));
  refresh.mockClear();
  onUpdated.mockClear();
  toasts.success.mockReset();
  toasts.error.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIntegrationInstances — add", () => {
  it("tests the form, then a URL or key change drops the answer", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true, appName: "Sonarr", version: "4.0" }));
    const { result } = setup();
    act(() => result.current.add.setForm({ name: "N", url: "http://s:8989", apiKey: "k", externalUrl: "" }));
    await act(async () => result.current.add.test());
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/sonarr/test", expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ url: "http://s:8989", apiKey: "k" });
    expect(result.current.add.testResult).toMatchObject({ ok: true });

    // A rename keeps it; a new URL does not.
    act(() => result.current.add.setForm({ ...result.current.add.form, name: "Renamed" }));
    expect(result.current.add.testResult).toMatchObject({ ok: true });
    act(() => result.current.add.setForm({ ...result.current.add.form, url: "http://other:8989" }));
    expect(result.current.add.testResult).toBeNull();
  });

  it("drops a test answer for credentials no longer on screen", async () => {
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.response);
    const { result } = setup();
    act(() => result.current.add.setForm({ name: "N", url: "http://s:8989", apiKey: "k", externalUrl: "" }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.add.test();
    });
    act(() => result.current.add.setForm({ ...result.current.add.form, apiKey: "other" }));
    await act(async () => {
      slow.resolve({ ok: true });
      await pending;
    });
    // The old key's pass must not enable Save for the new key.
    expect(result.current.add.testResult).toBeNull();
    expect(result.current.add.testing).toBe(false);
  });

  it("adds, closes, refreshes and toasts", async () => {
    fetchMock.mockResolvedValueOnce(json({ instance: { id: "new" } }));
    const { result } = setup();
    act(() => result.current.add.setOpen(true));
    act(() => result.current.add.setForm({ name: "N", url: "http://s:8989", apiKey: "k", externalUrl: "https://s.example.com" }));
    await act(async () => result.current.add.submit());
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/sonarr", expect.objectContaining({ method: "POST" }));
    expect(bodyOf(fetchMock)).toEqual({ name: "N", url: "http://s:8989", apiKey: "k", externalUrl: "https://s.example.com" });
    expect(result.current.add.open).toBe(false);
    expect(result.current.add.form).toEqual({ name: "", url: "", apiKey: "", externalUrl: "" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts.success).toHaveBeenCalledWith("Sonarr instance added");
  });

  it("shows the first validation detail of a refused add", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Validation failed", details: ["externalUrl: External URL must start with http:// or https://"] }, false));
    const { result } = setup();
    await act(async () => result.current.add.submit());
    expect(result.current.add.error).toBe(
      "Validation failed — externalUrl: External URL must start with http:// or https://",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends Tracearr no External URL, and shows its connection failure", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "Failed to connect to Tracearr", detail: "401 Unauthorized" }, false));
    const { result } = setup(TRACEARR);
    act(() => result.current.add.setForm({ name: "T", url: "http://t:3000", apiKey: "k", externalUrl: "" }));
    await act(async () => result.current.add.submit());
    expect(bodyOf(fetchMock)).toEqual({ name: "T", url: "http://t:3000", apiKey: "k" });
    expect(result.current.add.error).toBe("Failed to connect to Tracearr — 401 Unauthorized");
  });
});

describe("useIntegrationInstances — edit", () => {
  it("opens with the stored values and tests the stored connection", async () => {
    const { result } = setup();
    await act(async () => result.current.edit.start(instance({ externalUrl: "https://s.example.com" })));
    expect(result.current.edit.id).toBe("a");
    expect(result.current.edit.form).toEqual({
      name: "Main",
      url: "http://sonarr.lan:8989",
      apiKey: "",
      externalUrl: "https://s.example.com",
    });
    expect(fetchWithReauth).toHaveBeenCalledWith(
      "/api/integrations/sonarr/a/test-connection",
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf(fetchWithReauth)).toEqual({});
    expect(result.current.edit.testResult).toEqual({ ok: true });
  });

  it("keeps a test for the instance edited before from landing on the next one", async () => {
    const slow = deferred();
    fetchWithReauth.mockReturnValueOnce(slow.response).mockResolvedValueOnce(json({ ok: false, error: "refused" }));
    const { result } = setup();
    act(() => result.current.edit.start(instance()));
    act(() => result.current.edit.cancel());
    await act(async () => result.current.edit.start(instance({ id: "b", name: "4K" })));
    await act(async () => slow.resolve({ ok: true }));
    // B's own (failed) answer stands: A's late pass would enable Save on B.
    expect(result.current.edit.id).toBe("b");
    expect(result.current.edit.testResult).toEqual({ ok: false, error: "refused" });
  });

  it("re-tests what is on screen, dropping a blank key", async () => {
    const { result } = setup();
    await act(async () => result.current.edit.start(instance()));
    act(() => result.current.edit.setForm({ ...result.current.edit.form, url: "http://new:8989" }));
    expect(result.current.edit.testResult).toBeNull();
    await act(async () => result.current.edit.test());
    expect(bodyOf(fetchWithReauth, 1)).toEqual({ url: "http://new:8989" });
  });

  it("saves through fetchWithReauth, sending the External URL only when it changed", async () => {
    const stored = instance({ externalUrl: "https://old.example.com" });
    const { result } = setup(SONARR, [stored]);
    await act(async () => result.current.edit.start(stored));
    act(() => result.current.edit.setForm({ ...result.current.edit.form, name: "Renamed" }));
    fetchWithReauth.mockResolvedValueOnce(json({ instance: stored }));
    await act(async () => result.current.edit.save());
    expect(fetchWithReauth).toHaveBeenLastCalledWith("/api/integrations/sonarr/a", expect.objectContaining({ method: "PUT" }));
    expect(bodyOf(fetchWithReauth, 1)).toEqual({ name: "Renamed", url: "http://sonarr.lan:8989" });
    expect(result.current.edit.id).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith("a");
    expect(toasts.success).toHaveBeenCalledWith("Sonarr instance updated");
  });

  it("keeps the form open with the reason when the save is refused", async () => {
    const { result } = setup();
    await act(async () => result.current.edit.start(instance()));
    fetchWithReauth.mockResolvedValueOnce(json({ error: "Failed to connect to Sonarr", detail: "ECONNREFUSED" }, false));
    await act(async () => result.current.edit.save());
    expect(result.current.edit.id).toBe("a");
    expect(result.current.edit.error).toBe("Failed to connect to Sonarr — ECONNREFUSED");
    expect(onUpdated).not.toHaveBeenCalled();
  });
});

describe("useIntegrationInstances — toggle and removal", () => {
  it("toggles with a plain PUT and the type's own wording", async () => {
    const { result } = setup();
    await act(async () => result.current.setEnabled("a", false));
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/sonarr/a", expect.objectContaining({ method: "PUT" }));
    expect(bodyOf(fetchMock)).toEqual({ enabled: false });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts.success).toHaveBeenCalledWith("Integration disabled");

    fetchMock.mockResolvedValueOnce(json({}, false));
    await act(async () => result.current.setEnabled("a", true));
    expect(toasts.error).toHaveBeenCalledWith("Failed to update integration");
  });

  it("names Tracearr in its toggle toasts", async () => {
    const { result } = setup(TRACEARR);
    await act(async () => result.current.setEnabled("a", true));
    expect(toasts.success).toHaveBeenCalledWith("Tracearr enabled");
  });

  it("removes and refreshes, or reports the failure", async () => {
    const { result } = setup();
    await act(async () => result.current.remove("b"));
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/sonarr/b", { method: "DELETE" });
    expect(toasts.success).toHaveBeenCalledWith("Sonarr instance removed");
    expect(refresh).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json({}, false));
    await act(async () => result.current.remove("b"));
    expect(toasts.error).toHaveBeenCalledWith("Failed to remove Sonarr instance");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
