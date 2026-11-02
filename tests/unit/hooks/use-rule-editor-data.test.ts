// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const realtime = vi.hoisted(() => ({ callbacks: new Map<string, () => void>() }));
vi.mock("@/hooks/use-realtime", () => ({
  useRealtimeEvents: (types: readonly string[], callback: () => void) => {
    realtime.callbacks.set(types.join(","), callback);
  },
}));
vi.mock("@/hooks/use-integrations-health", () => ({
  useIntegrationsHealth: () => ({ health: { arrAnyReachable: false }, loading: false }),
}));

import {
  useRuleEditorData,
  playHistoryFaultOf,
  integrationsFrom,
  ruleSetNameValues,
} from "@/hooks/use-rule-editor-data";

const fetchMock = vi.fn();

/** Answer each URL the hook asks for; anything else is a 404. */
function routes(answers: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (!(url in answers)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(answers[url]), { status: 200 });
  });
}

const urls = () => fetchMock.mock.calls.map(([url]) => url as string);

beforeEach(() => {
  fetchMock.mockReset();
  realtime.callbacks.clear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playHistoryFaultOf", () => {
  it("reads an absent marker as established, a null one as unsynced, a running backfill as importing", () => {
    expect(playHistoryFaultOf({ id: "s", name: "S", type: "PLEX" })).toBeNull();
    expect(playHistoryFaultOf({ id: "s", name: "S", type: "PLEX", watchHistorySyncedAt: null })).toBe("unsynced");
    expect(
      playHistoryFaultOf({
        id: "s",
        name: "S",
        type: "PLEX",
        watchHistorySyncedAt: "2026-01-01T00:00:00Z",
        tracearrServerId: "t",
        tracearrBackfillComplete: false,
      }),
    ).toBe("importing");
    // Unsynced wins over importing, as the server-side guard decides.
    expect(
      playHistoryFaultOf({
        id: "s",
        name: "S",
        type: "PLEX",
        watchHistorySyncedAt: null,
        tracearrServerId: "t",
        tracearrBackfillComplete: false,
      }),
    ).toBe("unsynced");
  });
});

describe("integrationsFrom", () => {
  it("counts only an enabled Seerr instance as connected", () => {
    expect(integrationsFrom({ seerr: [{ id: "a", enabled: false }] }).seerrConnected).toBe(false);
    expect(integrationsFrom({ seerr: [{ id: "a", enabled: false }, { id: "b" }] }).seerrConnected).toBe(true);
    expect(integrationsFrom({}).radarr).toEqual([]);
  });
});

describe("ruleSetNameValues", () => {
  it("offers each name once, sorted", () => {
    expect(ruleSetNameValues([{ name: "b" }, { name: "A" }, { name: "b" }])).toEqual(["A", "b"]);
  });
});

describe("useRuleEditorData", () => {
  const ruleSets = [
    { id: "1", name: "Old movies", type: "MOVIE" },
    { id: "2", name: "Ended shows", type: "SERIES" },
  ];

  it("reads each list once, and the Seerr names only when an instance is enabled", async () => {
    routes({
      "/api/lifecycle/rules": { ruleSets },
      "/api/servers": { servers: [{ id: "s", name: "Plex", type: "PLEX", watchHistorySyncedAt: null }] },
      "/api/media/distinct-values": { genre: ["Drama"], matchedByRuleSet: ["stale"] },
      "/api/lifecycle/exceptions?idsOnly=1": { mediaItemIds: ["m1"] },
      "/api/integrations/instances": { radarr: [{ id: "r", name: "Radarr", url: "u" }], seerr: [] },
    });
    const { result } = renderHook(() => useRuleEditorData());
    await waitFor(() => expect(result.current.integrations).not.toBeNull());
    await waitFor(() => expect(result.current.ruleSets).toHaveLength(2));
    await waitFor(() => expect(result.current.exceptedItemIds.has("m1")).toBe(true));

    expect(result.current.servers).toEqual([
      { id: "s", name: "Plex", type: "PLEX", enabled: true, playHistoryFault: "unsynced" },
    ]);
    expect(result.current.integrations?.radarr).toHaveLength(1);
    expect(result.current.integrations?.seerrUsers).toBeNull();
    // The rule set names come from the rule sets held, not the stale listing.
    await waitFor(() => expect(result.current.distinctValues.genre).toEqual(["Drama"]));
    expect(result.current.distinctValues.matchedByRuleSet).toEqual(["Ended shows", "Old movies"]);
    expect(urls()).not.toContain("/api/integrations/instances?withMetadata=1");
    expect(new Set(urls()).size).toBe(urls().length);
  });

  it("adds the Seerr requester names after the instance lists", async () => {
    routes({
      "/api/lifecycle/rules": { ruleSets },
      "/api/servers": { servers: [] },
      "/api/media/distinct-values": {},
      "/api/lifecycle/exceptions?idsOnly=1": { mediaItemIds: [] },
      "/api/integrations/instances": { seerr: [{ id: "x", enabled: true }] },
      "/api/integrations/instances?withMetadata=1": { seerr: [{ id: "x", enabled: true }], seerrUsers: ["alice"] },
    });
    const { result } = renderHook(() => useRuleEditorData());
    await waitFor(() => expect(result.current.integrations?.seerrUsers).toEqual(["alice"]));
    expect(result.current.integrations?.seerrConnected).toBe(true);
  });

  it("re-reads the servers on a watch-history event, and the rule sets on request", async () => {
    routes({
      "/api/lifecycle/rules": { ruleSets },
      "/api/servers": { servers: [] },
      "/api/media/distinct-values": {},
      "/api/lifecycle/exceptions?idsOnly=1": { mediaItemIds: [] },
      "/api/integrations/instances": {},
    });
    const { result } = renderHook(() => useRuleEditorData());
    await waitFor(() => expect(result.current.ruleSets).not.toBeNull());
    const count = (url: string) => urls().filter((u) => u === url).length;

    act(() => realtime.callbacks.get("tracearr:import-progress,watch-history:updated")?.());
    await waitFor(() => expect(count("/api/servers")).toBe(2));
    await act(() => result.current.refreshRuleSets());
    expect(count("/api/lifecycle/rules")).toBe(2);
  });
});
