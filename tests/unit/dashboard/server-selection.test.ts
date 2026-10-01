import { describe, it, expect } from "vitest";
import {
  ALL_SERVERS,
  ALL_TYPES,
  dashboardStatsUrl,
  reconcileSelectedServer,
  reconcileSelectedType,
  selectableServers,
} from "@/lib/dashboard/server-selection";

describe("selectableServers", () => {
  it("drops disabled servers, whose stats answer 404", () => {
    const out = selectableServers([
      { id: "a", name: "Plex", type: "PLEX", enabled: true },
      { id: "b", name: "Old", type: "JELLYFIN", enabled: false },
    ]);
    expect(out.map((s) => s.id)).toEqual(["a"]);
  });

  it("keeps a server whose enabled flag is absent", () => {
    expect(selectableServers([{ id: "a", name: "Plex", type: "PLEX" }])).toHaveLength(1);
  });

  it("returns only id, name and type", () => {
    const raw = { id: "a", name: "Plex", type: "PLEX", enabled: true, url: "http://x" };
    expect(selectableServers([raw])).toEqual([{ id: "a", name: "Plex", type: "PLEX" }]);
  });
});

describe("reconcileSelectedServer", () => {
  const servers = [{ id: "a", name: "Plex", type: "PLEX" }];

  it("keeps all servers selected", () => {
    expect(reconcileSelectedServer(ALL_SERVERS, servers)).toBe(ALL_SERVERS);
  });

  it("keeps a server that is still selectable", () => {
    expect(reconcileSelectedServer("a", servers)).toBe("a");
  });

  it("falls back to all servers when the selection was deleted or disabled", () => {
    expect(reconcileSelectedServer("gone", servers)).toBe(ALL_SERVERS);
    expect(reconcileSelectedServer("a", [])).toBe(ALL_SERVERS);
  });
});

describe("dashboardStatsUrl", () => {
  it("is unfiltered for all servers", () => {
    expect(dashboardStatsUrl(ALL_SERVERS)).toBe("/api/media/stats");
  });

  it("carries the selected server", () => {
    expect(dashboardStatsUrl("srv-1")).toBe("/api/media/stats?serverId=srv-1");
  });

  it("encodes the id", () => {
    expect(dashboardStatsUrl("a&b")).toBe("/api/media/stats?serverId=a%26b");
  });
});

describe("reconcileSelectedType", () => {
  it("keeps all types", () => {
    expect(reconcileSelectedType(ALL_TYPES, ["MOVIE"])).toBe(ALL_TYPES);
  });

  it("keeps a type still in the library", () => {
    expect(reconcileSelectedType("MOVIE", ["MOVIE", "SERIES"])).toBe("MOVIE");
  });

  it("falls back to all types when the selected type is gone", () => {
    expect(reconcileSelectedType("MOVIE", ["SERIES"])).toBe(ALL_TYPES);
  });

  it("keeps the selection while the types are unknown", () => {
    expect(reconcileSelectedType("MOVIE", [])).toBe("MOVIE");
  });
});

describe("reconcileSelectedType with a custom all-value", () => {
  it("falls back to the caller's all-value", () => {
    expect(reconcileSelectedType("MOVIE", ["SERIES"], "ALL")).toBe("ALL");
    expect(reconcileSelectedType("ALL", ["SERIES"], "ALL")).toBe("ALL");
    expect(reconcileSelectedType("SERIES", ["SERIES"], "ALL")).toBe("SERIES");
  });
});
