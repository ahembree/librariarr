// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  useIntegrationsHealth,
  deriveIntegrationsStatus,
  arrTypeForMediaType,
  type IntegrationsHealth,
} from "@/hooks/use-integrations-health";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const inst = (id: string, reachable: boolean) => ({ id, name: `name-${id}`, reachable, error: reachable ? null : "down" });

const EMPTY_TYPE = { configured: 0, reachable: 0, instances: [] };
const EMPTY_HEALTH: IntegrationsHealth = {
  sonarr: EMPTY_TYPE,
  radarr: EMPTY_TYPE,
  lidarr: EMPTY_TYPE,
  seerr: EMPTY_TYPE,
  arrAnyReachable: false,
};

const HEALTH: IntegrationsHealth = {
  sonarr: { configured: 2, reachable: 1, instances: [inst("s1", true), inst("s2", false)] },
  radarr: { configured: 1, reachable: 1, instances: [inst("r1", true)] },
  lidarr: { configured: 1, reachable: 0, instances: [inst("l1", false)] },
  seerr: { configured: 2, reachable: 1, instances: [inst("e1", true), inst("e2", false)] },
  arrAnyReachable: true,
};

describe("useIntegrationsHealth", () => {
  it("starts empty and loading, then applies the server snapshot", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => HEALTH });
    const { result } = renderHook(() => useIntegrationsHealth());
    expect(result.current.loading).toBe(true);
    expect(result.current.health.arrAnyReachable).toBe(false);
    expect(result.current.health.sonarr.instances).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/health");
    expect(result.current.health).toEqual(HEALTH);
  });

  it("keeps the empty snapshot on a non-OK response", async () => {
    const json = vi.fn(async () => ({ error: "Unauthorized" }));
    fetchMock.mockResolvedValue({ ok: false, status: 401, json });
    const { result } = renderHook(() => useIntegrationsHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.health).toEqual(EMPTY_HEALTH);
    expect(json).not.toHaveBeenCalled();
  });

  it("stops loading on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useIntegrationsHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.health).toEqual(EMPTY_HEALTH);
  });

  it("settles quietly when the response lands after unmount", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useIntegrationsHealth());
    unmount();
    await act(async () => {
      resolve({ ok: true, json: async () => HEALTH });
    });
    expect(result.current).toEqual({ health: EMPTY_HEALTH, loading: true });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("arrTypeForMediaType", () => {
  it("maps each library type to its Arr app", () => {
    expect(arrTypeForMediaType("MOVIE")).toBe("radarr");
    expect(arrTypeForMediaType("SERIES")).toBe("sonarr");
    expect(arrTypeForMediaType("MUSIC")).toBe("lidarr");
  });
});

describe("deriveIntegrationsStatus", () => {
  it("considers every Arr type by default", () => {
    const s = deriveIntegrationsStatus(HEALTH);
    expect(s.arrConfigured).toBe(true);
    expect(s.arrUnreachable).toBe(true);
    expect(s.unreachableArrNames).toEqual(["name-s2", "name-l1"]);
    expect(s.seerrUnreachable).toBe(true);
    expect(s.unreachableSeerrNames).toEqual(["name-e2"]);
  });

  it("accepts a bare type list for backward compatibility", () => {
    const s = deriveIntegrationsStatus(HEALTH, ["radarr"]);
    expect(s.arrConfigured).toBe(true);
    expect(s.arrUnreachable).toBe(false);
    expect(s.unreachableArrNames).toEqual([]);
  });

  it("filters to the given instance ids, an empty list meaning none", () => {
    expect(deriveIntegrationsStatus(HEALTH, { arrInstanceIds: ["s1"] }).arrUnreachable).toBe(false);
    expect(deriveIntegrationsStatus(HEALTH, { arrInstanceIds: ["s2"] }).unreachableArrNames).toEqual(["name-s2"]);
    const none = deriveIntegrationsStatus(HEALTH, { arrInstanceIds: [], seerrInstanceIds: [] });
    expect(none.arrConfigured).toBe(false);
    expect(none.arrUnreachable).toBe(false);
    expect(none.seerrConfigured).toBe(false);
    expect(none.seerrUnreachable).toBe(false);
  });

  it("scopes instance ids within the relevant types", () => {
    // l1 is unreachable but not a sonarr instance.
    const s = deriveIntegrationsStatus(HEALTH, { relevantArrTypes: ["sonarr"], arrInstanceIds: ["l1"] });
    expect(s.arrConfigured).toBe(false);
  });

  it("filters Seerr instances by id", () => {
    const s = deriveIntegrationsStatus(HEALTH, { seerrInstanceIds: ["e1"] });
    expect(s.seerrConfigured).toBe(true);
    expect(s.seerrUnreachable).toBe(false);
  });
});
