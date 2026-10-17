import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ logger: mockLogger }));

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      interceptors: { response: { use: vi.fn() } },
    })),
    isAxiosError: () => false,
  },
}));

import { fetchTrashCatalog, catalogHasResource } from "@/lib/trash/catalog";
import { appCache } from "@/lib/cache/memory-cache";
import type { TrashCatalog } from "@/lib/trash/types";

function serve(tree: unknown, files: Record<string, unknown>) {
  mockGet.mockImplementation((url: string) => {
    if (url.includes("git/trees")) return Promise.resolve({ data: tree });
    const key = Object.keys(files).find((k) => url.endsWith(k));
    if (key) return Promise.resolve({ data: files[key] });
    return Promise.reject(new Error("Request failed with status code 404"));
  });
}

const blob = (path: string) => ({ path, type: "blob" });

beforeEach(() => {
  appCache.clear();
  mockGet.mockReset();
  vi.clearAllMocks();
});

describe("fetchTrashCatalog edge cases", () => {
  it("builds an empty catalog when the tree has no entries", async () => {
    serve({}, {});
    const cat = await fetchTrashCatalog("SONARR");
    expect(cat.service).toBe("SONARR");
    expect(cat.customFormats).toEqual([]);
    expect(cat.cfGroups).toEqual([]);
    expect(cat.qualityProfiles).toEqual([]);
    expect(cat.qualitySize).toBeNull();
    expect(cat.naming).toBeNull();
    // Only the tree was requested.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "TrashSync",
      expect.stringContaining("0 quality-size, 0 naming"),
    );
  });

  it("uses the Sonarr paths, prefers the series quality-size, and sorts everything by name", async () => {
    serve(
      {
        tree: [
          blob("docs/json/sonarr/cf/z.json"),
          blob("docs/json/sonarr/cf/a.json"),
          blob("docs/json/sonarr/cf/readme.md"),
          blob("docs/json/sonarr/cf-groups/g2.json"),
          blob("docs/json/sonarr/cf-groups/g1.json"),
          blob("docs/json/sonarr/cf-groups/broken.json"),
          blob("docs/json/sonarr/quality-profiles/web.json"),
          blob("docs/json/sonarr/quality-profiles/bad.json"),
          blob("docs/json/sonarr/quality-profiles/anime.json"),
          blob("docs/json/sonarr/quality-size/anime.json"),
          blob("docs/json/sonarr/quality-size/series.json"),
          blob("docs/json/sonarr/quality-size/junk.json"),
          blob("docs/json/radarr/cf/radarr-only.json"),
        ],
      },
      {
        "cf/z.json": { trash_id: "z", name: "Zulu", specifications: [] },
        "cf/a.json": { trash_id: "a", name: "Alpha", specifications: [] },
        "cf-groups/g2.json": { name: "[Unwanted] Bad", custom_formats: [null, { trash_id: "z" }, {}] },
        "cf-groups/g1.json": { name: "[Audio] Good", trash_id: "g1", custom_formats: [] },
        "cf-groups/broken.json": { name: "No list" },
        "quality-profiles/web.json": { trash_id: "w", name: "WEB", items: [] },
        "quality-profiles/bad.json": { trash_id: "x", name: "No items" },
        "quality-profiles/anime.json": { trash_id: "an", name: "Anime", items: [] },
        "quality-size/anime.json": { trash_id: "qa", type: "anime", qualities: [] },
        "quality-size/series.json": { trash_id: "qs", type: "series", qualities: [] },
        "quality-size/junk.json": { trash_id: "qj", type: "series" },
      },
    );

    const cat = await fetchTrashCatalog("SONARR");
    expect(cat.customFormats.map((c) => c.name)).toEqual(["Alpha", "Zulu"]);
    expect(cat.cfGroups.map((g) => g.name)).toEqual(["[Audio] Good", "[Unwanted] Bad"]);
    // Null/empty entries in a group's list are dropped.
    expect(cat.cfGroups[1].customFormats).toEqual(["z"]);
    expect(cat.cfGroups[1].trash_id).toBeUndefined();
    expect(cat.qualityProfiles.map((p) => p.trash_id)).toEqual(["an", "w"]);
    expect(cat.qualitySize?.trash_id).toBe("qs");
    expect(cat.naming).toBeNull();
    // A non-JSON file and another service's file are never fetched.
    const urls = mockGet.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.endsWith("readme.md"))).toBe(false);
    expect(urls.some((u) => u.includes("radarr-only"))).toBe(false);
  });

  it("falls back to the first valid quality-size when none matches the service type", async () => {
    serve(
      { tree: [blob("docs/json/radarr/quality-size/sqp.json"), blob("docs/json/radarr/quality-size/anime.json")] },
      {
        "quality-size/sqp.json": { trash_id: "sqp", type: "sqp-streaming", qualities: [] },
        "quality-size/anime.json": { trash_id: "anime", type: "anime", qualities: [] },
      },
    );
    const cat = await fetchTrashCatalog("RADARR");
    expect(cat.qualitySize?.trash_id).toBe("sqp");
  });

  it("fails the whole build (and caches nothing) when one guide file cannot be fetched", async () => {
    serve(
      { tree: [blob("docs/json/radarr/cf/ok.json"), blob("docs/json/radarr/cf/missing.json")] },
      { "cf/ok.json": { trash_id: "ok", name: "OK", specifications: [] } },
    );
    await expect(fetchTrashCatalog("RADARR")).rejects.toThrow(
      "Failed to fetch guide file docs/json/radarr/cf/missing.json: Request failed with status code 404",
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "TrashSync",
      expect.stringContaining("docs/json/radarr/cf/missing.json"),
    );

    // Not cached: the next call rebuilds and succeeds once the file is back.
    serve(
      { tree: [blob("docs/json/radarr/cf/ok.json")] },
      { "cf/ok.json": { trash_id: "ok", name: "OK", specifications: [] } },
    );
    const cat = await fetchTrashCatalog("RADARR");
    expect(cat.customFormats.map((c) => c.trash_id)).toEqual(["ok"]);
  });

  it("propagates a tree fetch failure", async () => {
    mockGet.mockRejectedValue(new Error("rate limited"));
    await expect(fetchTrashCatalog("RADARR")).rejects.toThrow("rate limited");
  });

  it("fetches more files than the concurrency limit, keeping every result in order", async () => {
    const tree = { tree: [] as { path: string; type: string }[] };
    const files: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      const id = `cf${String(i).padStart(2, "0")}`;
      tree.tree.push(blob(`docs/json/radarr/cf/${id}.json`));
      files[`cf/${id}.json`] = { trash_id: id, name: id.toUpperCase(), specifications: [] };
    }
    serve(tree, files);
    const cat = await fetchTrashCatalog("RADARR");
    expect(cat.customFormats).toHaveLength(30);
    expect(cat.customFormats[0].trash_id).toBe("cf00");
    expect(cat.customFormats[29].trash_id).toBe("cf29");
  });
});

describe("catalogHasResource edge cases", () => {
  const empty: TrashCatalog = {
    service: "RADARR",
    ref: "master",
    fetchedAt: "2026-01-01T00:00:00Z",
    customFormats: [],
    cfGroups: [],
    qualityProfiles: [],
    qualitySize: null,
    naming: null,
  };

  it("rejects a quality definition when the catalog has no quality-size", () => {
    expect(catalogHasResource(empty, "QUALITY_DEFINITION", "qs1")).toBe(false);
  });

  it("rejects a quality definition whose id differs", () => {
    const cat = { ...empty, qualitySize: { trash_id: "qs1", type: "movie", qualities: [] } };
    expect(catalogHasResource(cat, "QUALITY_DEFINITION", "other")).toBe(false);
    expect(catalogHasResource(cat, "QUALITY_DEFINITION", "qs1")).toBe(true);
  });

  it("rejects PROFILE_CF, which names a profile rather than a guide item", () => {
    // The assignment route validates a PROFILE_CF overlay by its custom formats.
    expect(catalogHasResource(empty, "PROFILE_CF", "x")).toBe(false);
  });
});
