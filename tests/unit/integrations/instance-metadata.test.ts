import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  loadLidarrMetadata,
  loadRadarrMetadata,
  loadSeerrMetadata,
  loadSonarrMetadata,
} from "@/lib/integrations/instance-metadata";
import { INTEGRATIONS, LIDARR, RADARR, SEERR, SONARR, TRACEARR } from "@/lib/integrations/instance-routes";
import type { InstanceRow } from "@/lib/integrations/instance-routes";
import type { RadarrClient } from "@/lib/arr/radarr-client";
import type { SonarrClient } from "@/lib/arr/sonarr-client";
import type { LidarrClient } from "@/lib/arr/lidarr-client";
import type { SeerrClient } from "@/lib/seerr/seerr-client";

const INSTANCE = { id: "i1", name: "Seerr" } as InstanceRow;

describe("instance metadata loaders", () => {
  it("lists Radarr's tags, profiles, real languages, and the library's distinct quality names and statuses", async () => {
    const client = {
      getMovies: async () => [
        { tmdbId: 1, status: "released", movieFile: { quality: { quality: { name: "WEBDL-2160p" } } } },
        { tmdbId: 2, status: "announced", movieFile: { quality: { quality: { name: "Bluray-1080p" } } } },
        { tmdbId: 3, status: "released" },
      ],
      getQualityProfiles: async () => [{ id: 1, name: "HD", extra: true }],
      getTags: async () => [{ id: 2, label: "keep", extra: true }],
      getLanguages: async () => [{ id: 0, name: "Unknown" }, { id: 2, name: "French" }, { id: 1, name: "English" }, { id: -1, name: "Any" }],
    } as unknown as RadarrClient;
    expect(await loadRadarrMetadata(client)).toEqual({
      tags: [{ id: 2, label: "keep" }],
      qualityProfiles: [{ id: 1, name: "HD" }],
      languages: ["English", "French"],
      qualityNames: ["Bluray-1080p", "WEBDL-2160p"],
      statuses: ["announced", "released"],
    });
  });

  it("lists Sonarr's statuses and series types, and no per-series map", async () => {
    const client = {
      getSeries: async () => [{ status: "ended", seriesType: "anime" }, { status: "continuing" }, { seriesType: "standard" }],
      getQualityProfiles: async () => [],
      getTags: async () => [],
      getLanguages: async () => [{ id: -2, name: "Original" }],
    } as unknown as SonarrClient;
    expect(await loadSonarrMetadata(client)).toEqual({
      tags: [],
      qualityProfiles: [],
      languages: [],
      statuses: ["continuing", "ended"],
      seriesTypes: ["anime", "standard"],
    });
  });

  it("lists Lidarr's artist statuses", async () => {
    const client = {
      getArtists: async () => [{ status: "ended" }, { status: "ended" }, {}],
      getQualityProfiles: async () => [{ id: 3, name: "Lossless" }],
      getTags: async () => [],
    } as unknown as LidarrClient;
    expect(await loadLidarrMetadata(client)).toEqual({ tags: [], qualityProfiles: [{ id: 3, name: "Lossless" }], statuses: ["ended"] });
  });

  it("pages Seerr's users and names each as Requested By reads it, once", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ id: i, username: `user${String(i).padStart(3, "0")}` })),
      [{ id: 200, plexUsername: "PlexName", username: "local" }, { id: 201, username: "user000" }],
    ];
    const getUsers = vi.fn(async ({ skip }: { skip: number }) => ({ pageInfo: {}, results: pages[skip / 100] ?? [] }));
    const result = await loadSeerrMetadata({ getUsers } as unknown as SeerrClient, INSTANCE);
    expect(getUsers.mock.calls.map(([args]) => args)).toEqual([{ take: 100, skip: 0 }, { take: 100, skip: 100 }]);
    const users = result.users as string[];
    expect(users).toHaveLength(101);
    expect(users).toContain("PlexName");
    expect(users).not.toContain("local");
  });

  it("propagates a failed read, which the route answers with 502", async () => {
    const client = { getArtists: async () => { throw new Error("down"); }, getQualityProfiles: async () => [], getTags: async () => [] };
    await expect(loadLidarrMetadata(client as unknown as LidarrClient)).rejects.toThrow("down");
  });
});

describe("integration types", () => {
  it("lists all five, each named for its app and stored in its own model", () => {
    expect(Object.values(INTEGRATIONS).map((c) => [c.type, c.label, c.model])).toEqual([
      ["sonarr", "Sonarr", "sonarrInstance"],
      ["radarr", "Radarr", "radarrInstance"],
      ["lidarr", "Lidarr", "lidarrInstance"],
      ["seerr", "Seerr", "seerrInstance"],
      ["tracearr", "Tracearr", "tracearrInstance"],
    ]);
  });

  it("detaches lifecycle references only for the Arr apps, and stores an External URL for all but Tracearr", () => {
    expect([RADARR, SONARR, LIDARR].every((c) => c.detachOnDelete)).toBe(true);
    expect([SEERR, TRACEARR].some((c) => c.detachOnDelete)).toBe(false);
    expect(Object.values(INTEGRATIONS).filter((c) => !c.hasExternalUrl)).toEqual([TRACEARR]);
    expect(SEERR.afterChange).toBeTypeOf("function");
  });
});
