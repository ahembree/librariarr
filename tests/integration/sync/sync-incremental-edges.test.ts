/**
 * Incremental-sync paths the main suite leaves out: the early skips (server
 * gone or disabled, empty change set), an item the server answers with no
 * rating key, show genres/summary reaching new episodes, the artist MusicBrainz
 * id in a batch mixing music with another library type, the exception warning
 * on a removal, the unresolved-id log cap, and a failing canonical recompute.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: log.error },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

const client = vi.hoisted(() => ({
  getItemMetadata: vi.fn(),
  withArtists: false,
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    getItemMetadata: client.getItemMetadata,
    ...(client.withArtists ? { getLibraryArtists: vi.fn() } : {}),
  })),
}));

const side = vi.hoisted(() => ({
  invalidate: vi.fn(),
  recompute: vi.fn(async () => {}),
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: side.invalidate }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: side.recompute }));

import { syncMediaServerItems } from "@/lib/sync/sync-incremental";
import { createMediaServerClient } from "@/lib/media-server/factory";

const prisma = getTestPrisma();
const ARTIST_MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";

beforeEach(async () => {
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  vi.clearAllMocks();
  client.withArtists = false;
  side.recompute.mockImplementation(async () => {});
});
afterAll(async () => {
  await prisma.lifecycleException.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("early skips", () => {
  it("skips a server that does not exist", async () => {
    await expect(syncMediaServerItems("missing", ["a"], [])).resolves.toMatchObject({
      status: "skipped", reason: "server not found",
    });
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it("skips a disabled server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { enabled: false });
    await expect(syncMediaServerItems(server.id, ["a"], [])).resolves.toMatchObject({
      status: "skipped", reason: "server disabled",
    });
    expect(createMediaServerClient).not.toHaveBeenCalled();
  });

  it("completes with nothing to do for an empty change set", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    await expect(syncMediaServerItems(server.id, [], [])).resolves.toMatchObject({
      status: "done", upserted: 0, deleted: 0,
    });
    expect(side.invalidate).not.toHaveBeenCalled();
  });
});

describe("item classification", () => {
  it("deletes a stored item the server answers with no rating key, warning about its exceptions", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    const item = await createTestMediaItem(lib.id, { ratingKey: "m1" });
    await prisma.lifecycleException.create({ data: { mediaItemId: item.id, userId: user.id, reason: "keep" } });
    client.getItemMetadata.mockResolvedValue({ type: "movie", title: "No key" });

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result).toMatchObject({ status: "done", deleted: 1 });
    expect(await prisma.mediaItem.count()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith("SyncIncremental", expect.stringContaining("deletes 1 lifecycle exception(s)"));
  });

  it("caps the logged unresolved ids at ten", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    const ids = Array.from({ length: 12 }, (_, i) => `x${i}`);
    // Plex items with no library section are dropped, not escalated.
    client.getItemMetadata.mockImplementation(async (rk: string) => ({
      ratingKey: rk, key: rk, type: "movie", title: rk,
    }));

    const result = await syncMediaServerItems(server.id, ids, []);

    expect(result).toMatchObject({ status: "done", unresolved: 12 });
    const line = log.warn.mock.calls.map((c) => String(c[1])).find((l) => l.includes("could not map"));
    expect(line).toContain("x0, x1, x2, x3, x4, x5, x6, x7, x8, x9 (+2 more)");
  });

  it("names the plural when items in several disabled libraries are skipped", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    await createTestLibrary(server.id, { key: "1", type: "MOVIE", enabled: false });
    client.getItemMetadata.mockImplementation(async (rk: string) => ({
      ratingKey: rk, key: rk, type: "movie", title: rk, librarySectionID: 1,
    }));

    const result = await syncMediaServerItems(server.id, ["a", "b"], []);

    expect(result).toMatchObject({ status: "done", skippedDisabled: 2, upserted: 0 });
    expect(await prisma.mediaItem.count()).toBe(0);
  });
});

describe("enrichment of new items", () => {
  it("files a new episode under its show's genres and summary", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    await createTestLibrary(server.id, { key: "2", type: "SERIES" });
    client.getItemMetadata.mockImplementation(async (rk: string) =>
      rk === "show1"
        ? { ratingKey: "show1", key: "s", type: "show", title: "Show", Guid: [{ id: "tvdb://42" }], Genre: [{ tag: "Comedy" }], summary: "Funny." }
        : { ratingKey: rk, key: rk, type: "episode", title: "Pilot", grandparentRatingKey: "show1", grandparentTitle: "Show", parentIndex: 1, index: 1, librarySectionID: 2 },
    );

    await syncMediaServerItems(server.id, ["e1"], []);

    const ep = await prisma.mediaItem.findFirstOrThrow({ include: { externalIds: true } });
    expect(ep.genres).toEqual(["Comedy"]);
    expect(ep.parentSummary).toBe("Funny.");
    expect(ep.seriesKey).toBe("tvdb:42");
    expect(ep.externalIds.map((e) => [e.source, e.externalId])).toEqual([["TVDB", "42"]]);
  });

  it("adds the artist MusicBrainz id to tracks only, in a batch that also carries a movie", async () => {
    client.withArtists = true;
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    await createTestLibrary(server.id, { key: "3", type: "MUSIC" });
    client.getItemMetadata.mockImplementation(async (rk: string) => {
      if (rk === "artist1") return { ratingKey: "artist1", key: "a", type: "artist", title: "Band", Guid: [{ id: `mbid://${ARTIST_MBID}` }] };
      if (rk === "artist2") return { ratingKey: "artist2", key: "a2", type: "artist", title: "Unknown" };
      if (rk === "m1") return { ratingKey: "m1", key: "m1", type: "movie", title: "Film", librarySectionID: 1, Guid: [{ id: "tmdb://1" }] };
      return { ratingKey: rk, key: rk, type: "track", title: rk, grandparentRatingKey: rk === "t1" ? "artist1" : "artist2", grandparentTitle: "Band", librarySectionID: 3 };
    });

    const result = await syncMediaServerItems(server.id, ["m1", "t1", "t2"], []);

    expect(result).toMatchObject({ status: "done", upserted: 3 });
    const ids = async (rk: string) =>
      (await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: rk }, include: { externalIds: true } }))
        .externalIds.map((e) => [e.source, e.externalId]);
    expect(await ids("t1")).toEqual([["MUSICBRAINZ", ARTIST_MBID]]);
    expect(await ids("t2")).toEqual([]);
    expect(await ids("m1")).toEqual([["TMDB", "1"]]);
  });
});

describe("post-write side effects", () => {
  it("still drops the caches when the canonical recompute fails", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { type: "PLEX" });
    await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    client.getItemMetadata.mockResolvedValue({ ratingKey: "m1", key: "m1", type: "movie", title: "Film", librarySectionID: 1 });
    side.recompute.mockRejectedValueOnce(new Error("deadlock"));

    const result = await syncMediaServerItems(server.id, ["m1"], []);

    expect(result.status).toBe("done");
    expect(log.error).toHaveBeenCalledWith("SyncIncremental", "recomputeCanonical failed", { error: "Error: deadlock" });
    expect(side.invalidate).toHaveBeenCalledTimes(1);
  });
});
