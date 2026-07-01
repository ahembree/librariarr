import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({
  default: { create: vi.fn(() => ({ get: mockGet })), isAxiosError: () => false },
}));

import { fetchTrashCatalog, catalogHasResource } from "@/lib/trash/catalog";
import { appCache } from "@/lib/cache/memory-cache";
import type { TrashCatalog } from "@/lib/trash/types";

const tree = {
  tree: [
    { path: "docs/json/radarr/cf/amzn.json", type: "blob" },
    { path: "docs/json/radarr/cf/bad.json", type: "blob" },
    { path: "docs/json/radarr/quality-profiles/hd.json", type: "blob" },
    { path: "docs/json/radarr/quality-size/movie.json", type: "blob" },
    { path: "docs/json/radarr/naming/radarr-naming.json", type: "blob" },
    { path: "docs/json/sonarr/cf/other.json", type: "blob" },
    { path: "docs/json/radarr/cf", type: "tree" },
  ],
};

const files: Record<string, unknown> = {
  "cf/amzn.json": { trash_id: "amzn", name: "AMZN", specifications: [] },
  "cf/bad.json": { name: "no trash id" },
  "quality-profiles/hd.json": { trash_id: "hd", name: "HD", items: [] },
  "quality-size/movie.json": { trash_id: "qs", type: "movie", qualities: [] },
  "naming/radarr-naming.json": { folder: {}, file: {} },
};

beforeEach(() => {
  appCache.clear();
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url.includes("git/trees")) return Promise.resolve({ data: tree });
    const key = Object.keys(files).find((k) => url.endsWith(k));
    if (key) return Promise.resolve({ data: files[key] });
    return Promise.reject(new Error("404"));
  });
});

describe("fetchTrashCatalog", () => {
  it("fetches, filters and parses guide files for a service", async () => {
    const cat = await fetchTrashCatalog("RADARR");
    // bad.json has no trash_id/specifications and is filtered out.
    expect(cat.customFormats.map((c) => c.name)).toEqual(["AMZN"]);
    expect(cat.qualityProfiles.map((p) => p.name)).toEqual(["HD"]);
    expect(cat.qualitySize?.type).toBe("movie");
    expect(cat.naming).not.toBeNull();
    // Sonarr files are not pulled into the radarr catalog.
    expect(cat.customFormats.some((c) => c.name === "other")).toBe(false);
  });

  it("serves the cached catalog on subsequent calls", async () => {
    await fetchTrashCatalog("RADARR");
    const after = mockGet.mock.calls.length;
    await fetchTrashCatalog("RADARR");
    expect(mockGet.mock.calls.length).toBe(after);
  });

  it("re-fetches when force is set", async () => {
    await fetchTrashCatalog("RADARR");
    const before = mockGet.mock.calls.length;
    await fetchTrashCatalog("RADARR", { force: true });
    expect(mockGet.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("catalogHasResource (cross-service gate)", () => {
  const cat: TrashCatalog = {
    service: "RADARR",
    ref: "master",
    fetchedAt: "2026-01-01T00:00:00Z",
    customFormats: [{ trash_id: "cf1", name: "AMZN", specifications: [] }],
    qualityProfiles: [{ trash_id: "qp1", name: "HD", cutoff: "Bluray-1080p", items: [] }],
    qualitySize: { trash_id: "qs1", type: "movie", qualities: [] },
    naming: { folder: {}, file: {} },
  };

  it("accepts ids present in this service's catalog", () => {
    expect(catalogHasResource(cat, "CUSTOM_FORMAT", "cf1")).toBe(true);
    expect(catalogHasResource(cat, "QUALITY_PROFILE", "qp1")).toBe(true);
    expect(catalogHasResource(cat, "QUALITY_DEFINITION", "qs1")).toBe(true);
    expect(catalogHasResource(cat, "NAMING", "naming")).toBe(true);
  });

  it("rejects ids from another service's catalog", () => {
    // A Sonarr custom-format trash_id is not in the Radarr catalog.
    expect(catalogHasResource(cat, "CUSTOM_FORMAT", "sonarr-cf")).toBe(false);
    expect(catalogHasResource(cat, "QUALITY_PROFILE", "sonarr-qp")).toBe(false);
    expect(catalogHasResource(cat, "QUALITY_DEFINITION", "series")).toBe(false);
  });

  it("rejects the wrong resource type for an id", () => {
    // cf1 is a custom format, not a quality profile.
    expect(catalogHasResource(cat, "QUALITY_PROFILE", "cf1")).toBe(false);
  });

  it("rejects naming when the catalog has none", () => {
    expect(catalogHasResource({ ...cat, naming: null }, "NAMING", "naming")).toBe(false);
  });
});
