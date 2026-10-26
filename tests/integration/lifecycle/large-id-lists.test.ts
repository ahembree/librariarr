/**
 * Lists as long as a library, against the real database. Postgres takes at
 * most 32,767 bind parameters per statement: a track-scope music rule set
 * matching ~38k tracks sent them to the exception guard as one IN list beside
 * the owner filter (P2029), and Re-evaluate All answered 500. Each helper here
 * is handed more ids than that limit.
 */
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

import { findExceptedItemIds, findExceptionProtectedGroups, isGroupProtected } from "@/lib/lifecycle/exception-guard";
import { arrExternalIdsOf } from "@/lib/lifecycle/cross-server-copies";

const prisma = getTestPrisma();
const PAST_THE_LIMIT = 40_000;

/** Ids no row carries, past the parameter limit. */
const fakeIds = (n: number) => Array.from({ length: n }, (_, i) => `missing-${i}`);

describe("helpers handed more ids than Postgres takes bind parameters", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("findExceptedItemIds finds an excepted item and another copy of it among 40k candidates", async () => {
    const user = await createTestUser();
    const s1 = await createTestServer(user.id);
    const s2 = await createTestServer(user.id);
    const l1 = await createTestLibrary(s1.id, { type: "MUSIC" });
    const l2 = await createTestLibrary(s2.id, { type: "MUSIC" });
    const excepted = await createTestMediaItem(l1.id, { type: "MUSIC", title: "Creep", parentTitle: "Radiohead" });
    const copy = await createTestMediaItem(l2.id, { type: "MUSIC", title: "Creep", parentTitle: "Radiohead" });
    const other = await createTestMediaItem(l1.id, { type: "MUSIC", title: "Karma Police", parentTitle: "Radiohead" });
    await prisma.mediaItem.updateMany({ where: { id: { in: [excepted.id, copy.id] } }, data: { dedupKey: "track:creep" } });
    await prisma.mediaItem.update({ where: { id: other.id }, data: { dedupKey: "track:karma" } });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: excepted.id } });

    const result = await findExceptedItemIds(user.id, [...fakeIds(PAST_THE_LIMIT), excepted.id, copy.id, other.id]);

    expect(result).toEqual(new Set([excepted.id, copy.id]));
  });

  it("findExceptionProtectedGroups answers for 40k artists at once", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const track = await createTestMediaItem(library.id, { type: "MUSIC", title: "Creep", parentTitle: "Radiohead" });
    await createTestExternalId(track.id, "MUSICBRAINZ", "mbid-radiohead");
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: track.id } });

    const targets = [
      ...Array.from({ length: PAST_THE_LIMIT }, (_, i) => ({
        parentTitle: `Artist ${i}`,
        type: "MUSIC",
        externalIds: [{ source: "MUSICBRAINZ", externalId: `mbid-${i}` }],
      })),
      { parentTitle: "radiohead", type: "MUSIC", externalIds: [{ source: "MUSICBRAINZ", externalId: "mbid-radiohead" }] },
    ];

    const keys = await findExceptionProtectedGroups(user.id, targets);

    expect(isGroupProtected(keys, { parentTitle: "Radiohead", type: "MUSIC" })).toBe(true);
    expect(isGroupProtected(keys, { parentTitle: "Artist 7", type: "MUSIC" })).toBe(false);
  });

  it("arrExternalIdsOf loads the ids of 40k items detection returned without them", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Heat" });
    await createTestExternalId(movie.id, "TMDB", "949");

    const ids = await arrExternalIdsOf(
      "MOVIE",
      [...fakeIds(PAST_THE_LIMIT), movie.id].map((id) => ({ id })),
    );

    expect(ids.get(movie.id)).toBe("949");
    expect(ids.size).toBe(1);
  });
});
