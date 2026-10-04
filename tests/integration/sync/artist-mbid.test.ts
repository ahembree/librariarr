import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));

// A Plex-like client: track metadata carries the track's own mbid, and the
// artist's comes from the artist (which is why `getLibraryArtists` exists).
const mockGetItemMetadata = vi.fn();
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    getItemMetadata: mockGetItemMetadata,
    getLibraryArtists: vi.fn(),
  })),
}));

vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));

import { writeArtistMbids } from "@/lib/sync/artist-mbid";
import { syncMediaServerItems } from "@/lib/sync/sync-incremental";

const ARTIST = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";
const OTHER = "1a2b3c4d-1111-2222-3333-444455556666";
const prisma = getTestPrisma();

async function seed() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { key: "3", type: "MUSIC" });
  return { user, server, library };
}

const sourcesOf = async (mediaItemId: string) =>
  (await prisma.mediaItemExternalId.findMany({ where: { mediaItemId }, orderBy: { source: "asc" } }))
    .map((e) => [e.source, e.externalId]);

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("writeArtistMbids", () => {
  it("gives every track its artist's MusicBrainz id, updates a changed one and drops a stale one", async () => {
    const { library } = await seed();
    const a = await createTestMediaItem(library.id, { type: "MUSIC", ratingKey: "t1", title: "A" });
    const b = await createTestMediaItem(library.id, { type: "MUSIC", ratingKey: "t2", title: "B" });
    const c = await createTestMediaItem(library.id, { type: "MUSIC", ratingKey: "t3", title: "C" });
    await prisma.mediaItem.update({ where: { id: a.id }, data: { grandparentRatingKey: "art1" } });
    await prisma.mediaItem.update({ where: { id: b.id }, data: { grandparentRatingKey: "art2" } });
    await prisma.mediaItem.update({ where: { id: c.id }, data: { grandparentRatingKey: "art3" } });
    await createTestExternalId(a.id, "MBID", "own-track-id");
    await createTestExternalId(b.id, "MUSICBRAINZ", "old-artist-id");
    await createTestExternalId(c.id, "MUSICBRAINZ", "stale");

    await writeArtistMbids(library.id, new Map([["art1", ARTIST], ["art2", OTHER]]));

    expect(await sourcesOf(a.id)).toEqual([["MBID", "own-track-id"], ["MUSICBRAINZ", ARTIST]]);
    expect(await sourcesOf(b.id)).toEqual([["MUSICBRAINZ", OTHER]]);
    expect(await sourcesOf(c.id)).toEqual([]);
  });
});

describe("incremental sync of a Plex track", () => {
  it("stores the artist's MusicBrainz id from the artist's metadata", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockImplementation(async (key: string) =>
      key === "art1"
        ? { ratingKey: "art1", type: "artist", title: "Artist", Guid: [{ id: `mbid://${ARTIST}` }] }
        : {
            ratingKey: "t1", key: "/library/metadata/t1", type: "track", title: "Song",
            grandparentTitle: "Artist", grandparentRatingKey: "art1", parentTitle: "Album",
            librarySectionID: 3, Guid: [{ id: `mbid://${OTHER}` }],
          },
    );

    const result = await syncMediaServerItems(server.id, ["t1"], []);
    expect(result.status).toBe("done");

    const item = await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "t1" } });
    expect(await sourcesOf(item.id)).toEqual([["MBID", OTHER], ["MUSICBRAINZ", ARTIST]]);
  });

  it("falls back instead of dropping the artist id when the artist fetch fails", async () => {
    const { server } = await seed();
    mockGetItemMetadata.mockImplementation(async (key: string) => {
      if (key === "art1") throw new Error("timeout");
      return {
        ratingKey: "t1", key: "/library/metadata/t1", type: "track", title: "Song",
        grandparentTitle: "Artist", grandparentRatingKey: "art1", librarySectionID: 3, Guid: [],
      };
    });

    const result = await syncMediaServerItems(server.id, ["t1"], []);

    expect(result.status).toBe("fell-back");
    expect(await prisma.mediaItem.count({ where: { ratingKey: "t1" } })).toBe(0);
  });
});
