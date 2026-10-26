/**
 * The exceptions route's listing shape and its collection clean-up, over a
 * mocked database: the `idsOnly` answer, each row's server from one library
 * lookup, and the disarm reading only the listed copies of collection-fed
 * matches and handing every Plex removal over in one batch. The database
 * behaviour itself is covered by tests/integration/lifecycle/exceptions*.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mockPrisma = vi.hoisted(() => ({
  lifecycleException: { findMany: vi.fn(), upsert: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  library: { findMany: vi.fn() },
  mediaItem: { findFirst: vi.fn(), findMany: vi.fn() },
  ruleMatch: { findMany: vi.fn(), deleteMany: vi.fn() },
  lifecycleAction: { deleteMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));
const mockRemoveItems = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({ isLoggedIn: true, userId: "u1" })),
}));
vi.mock("@/lib/lifecycle/collections", () => ({ removeItemsFromCollections: mockRemoveItems }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST, DELETE, PATCH } from "@/app/api/lifecycle/exceptions/route";

const get = (query = "") => GET(new NextRequest(`http://localhost/api/lifecycle/exceptions${query}`));
const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/lifecycle/exceptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.ruleMatch.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.lifecycleAction.deleteMany.mockResolvedValue({ count: 0 });
});

describe("GET", () => {
  it("answers idsOnly with the item ids alone, filtered by type", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([{ mediaItemId: "m1" }, { mediaItemId: "m2" }]);

    const response = await get("?idsOnly=1&type=MOVIE");

    expect(await response.json()).toEqual({ mediaItemIds: ["m1", "m2"] });
    const args = mockPrisma.lifecycleException.findMany.mock.calls[0][0];
    expect(args.select).toEqual({ mediaItemId: true });
    expect(args.where).toEqual({ userId: "u1", mediaItem: { type: "MOVIE" } });
    expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
  });

  it("names each row's server from one lookup of the rows' libraries", async () => {
    const row = (id: string, libraryId: string) => ({
      id: `e-${id}`,
      userId: "u1",
      mediaItemId: id,
      reason: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      mediaItem: { id, title: id, fileSize: BigInt(1024), libraryId },
    });
    mockPrisma.lifecycleException.findMany.mockResolvedValue([row("a", "lib1"), row("b", "lib2"), row("c", "lib1")]);
    mockPrisma.library.findMany.mockResolvedValue([
      { id: "lib1", mediaServer: { id: "s1", name: "One", type: "PLEX" } },
      { id: "lib2", mediaServer: { id: "s2", name: "Two", type: "JELLYFIN" } },
    ]);

    const body = (await (await get()).json()) as { exceptions: Array<{ mediaItem: Record<string, unknown> }> };

    expect(mockPrisma.library.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.library.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["lib1", "lib2"] } });
    // The listing no longer reads the server through a relation per row.
    const include = mockPrisma.lifecycleException.findMany.mock.calls[0][0].include;
    expect(include.mediaItem.select.library).toBeUndefined();
    expect(include.mediaItem.select.summary).toBe(true);
    expect(body.exceptions.map((e) => e.mediaItem)).toEqual([
      { id: "a", title: "a", fileSize: "1024", library: { mediaServer: { id: "s1", name: "One", type: "PLEX" } } },
      { id: "b", title: "b", fileSize: "1024", library: { mediaServer: { id: "s2", name: "Two", type: "JELLYFIN" } } },
      { id: "c", title: "c", fileSize: "1024", library: { mediaServer: { id: "s1", name: "One", type: "PLEX" } } },
    ]);
  });

  it("skips the library lookup when there is nothing to list", async () => {
    mockPrisma.lifecycleException.findMany.mockResolvedValue([]);
    expect(await (await get()).json()).toEqual({ exceptions: [] });
    expect(mockPrisma.library.findMany).not.toHaveBeenCalled();
  });
});

describe("POST — collection clean-up", () => {
  const movie = {
    id: "m1",
    title: "Movie",
    parentTitle: null,
    albumTitle: null,
    type: "MOVIE",
    seriesKey: null,
    dedupKey: null,
    externalIds: [],
  };

  it("reads the copies of collection-fed matches only, and removes every entry in one batch", async () => {
    mockPrisma.mediaItem.findFirst.mockResolvedValue(movie);
    mockPrisma.lifecycleException.upsert.mockResolvedValue({ id: "e1" });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { id: "rm1", ruleSetId: "rs1", mediaItemId: "m1", mediaItem: { parentTitle: null, seriesKey: null, externalIds: [] }, ruleSet: { type: "MOVIE", collection: { name: "Leaving" }, seriesScope: false } },
      { id: "rm2", ruleSetId: "rs2", mediaItemId: "m1", mediaItem: { parentTitle: null, seriesKey: null, externalIds: [] }, ruleSet: { type: "MOVIE", collection: { name: "Leaving" }, seriesScope: false } },
      { id: "rm3", ruleSetId: "rs3", mediaItemId: "m1", mediaItem: { parentTitle: null, seriesKey: null, externalIds: [] }, ruleSet: { type: "MOVIE", collection: null, seriesScope: false } },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      { id: "rm1", copies: [{ id: "m2", libraryId: "lib2", ratingKey: "rk2", title: "Movie" }, { id: "bad" }] },
      { id: "rm2", copies: null },
    ]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "m1", ratingKey: "rk1", libraryId: "lib1", title: "Movie", parentTitle: null },
    ]);

    expect((await post({ mediaItemId: "m1" })).status).toBe(201);

    // Not a whole `itemData` read: one path, for the two matches with a collection.
    expect(mockPrisma.ruleMatch.findMany.mock.calls[0][0].select.itemData).toBeUndefined();
    const [sql, ids] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`"itemData"->'copies'`);
    expect(ids).toEqual(["rm1", "rm2"]);
    // Read before the matches are deleted.
    expect(mockPrisma.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.ruleMatch.deleteMany.mock.invocationCallOrder[0],
    );

    expect(mockRemoveItems).toHaveBeenCalledTimes(1);
    const [userId, removals] = mockRemoveItems.mock.calls[0];
    expect(userId).toBe("u1");
    // The kept copy appears once although two rule sets feed the collection.
    expect(removals).toEqual([
      { type: "MOVIE", collectionName: "Leaving", itemRatingKey: "rk1", seriesTitle: null, libraryId: "lib1" },
      { type: "MOVIE", collectionName: "Leaving", itemRatingKey: "rk2", seriesTitle: null, libraryId: "lib2" },
    ]);
  });

  it("removes a series-scope show by its title", async () => {
    const episode = { ...movie, id: "e1", title: "Pilot", parentTitle: "Lost", type: "SERIES", seriesKey: "tvdb:1" };
    mockPrisma.mediaItem.findFirst.mockResolvedValue(episode);
    mockPrisma.lifecycleException.upsert.mockResolvedValue({ id: "x" });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { id: "rm1", ruleSetId: "rs1", mediaItemId: "e1", mediaItem: { parentTitle: "Lost", seriesKey: "tvdb:1", externalIds: [] }, ruleSet: { type: "SERIES", collection: { name: "Leaving" }, seriesScope: true } },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: "rm1", copies: null }]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "e1", ratingKey: "ep1", libraryId: "lib1", title: "Pilot", parentTitle: "Lost" },
    ]);

    expect((await post({ mediaItemId: "e1" })).status).toBe(201);
    expect(mockRemoveItems.mock.calls[0][1]).toEqual([
      { type: "SERIES", collectionName: "Leaving", itemRatingKey: "ep1", seriesTitle: "Lost", libraryId: "lib1" },
    ]);
  });

  it("does not read copies or call Plex when no match feeds a collection", async () => {
    mockPrisma.mediaItem.findFirst.mockResolvedValue(movie);
    mockPrisma.lifecycleException.upsert.mockResolvedValue({ id: "e1" });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { id: "rm1", ruleSetId: "rs1", mediaItemId: "m1", mediaItem: { parentTitle: null, seriesKey: null, externalIds: [] }, ruleSet: { type: "MOVIE", collection: null, seriesScope: false } },
    ]);

    expect((await post({ mediaItemId: "m1" })).status).toBe(201);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(mockRemoveItems).not.toHaveBeenCalled();
  });

  it("still answers 201 when the collection clean-up throws", async () => {
    mockPrisma.mediaItem.findFirst.mockResolvedValue(movie);
    mockPrisma.lifecycleException.upsert.mockResolvedValue({ id: "e1" });
    mockPrisma.ruleMatch.findMany.mockResolvedValue([
      { id: "rm1", ruleSetId: "rs1", mediaItemId: "m1", mediaItem: { parentTitle: null, seriesKey: null, externalIds: [] }, ruleSet: { type: "MOVIE", collection: { name: "Leaving" }, seriesScope: false } },
    ]);
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    mockPrisma.mediaItem.findMany.mockResolvedValue([
      { id: "m1", ratingKey: "rk1", libraryId: "lib1", title: "Movie", parentTitle: null },
    ]);
    mockRemoveItems.mockRejectedValue(new Error("plex down"));

    expect((await post({ mediaItemId: "m1" })).status).toBe(201);
  });
});

describe("bulk DELETE and PATCH — a row past the bind-parameter limit", () => {
  const send = (handler: typeof DELETE, body: unknown) =>
    handler(
      new NextRequest("http://localhost/api/lifecycle/exceptions", {
        method: handler === DELETE ? "DELETE" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const ids = Array.from({ length: 40_000 }, (_, i) => `e${i}`);

  beforeEach(() => {
    mockPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  });

  it("removes in slices, in one transaction, and counts every removal once", async () => {
    mockPrisma.lifecycleException.deleteMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }));

    const response = await send(DELETE, { ids: [...ids, "e0"] });

    expect(await response.json()).toEqual({ deleted: 40_000 });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    const slices = mockPrisma.lifecycleException.deleteMany.mock.calls.map(([a]) => a.where.id.in.length);
    expect(slices).toEqual([10_000, 10_000, 10_000, 10_000]);
    for (const [args] of mockPrisma.lifecycleException.deleteMany.mock.calls) expect(args.where.userId).toBe("u1");
  });

  it("re-words in slices, never counting a repeated id twice", async () => {
    mockPrisma.lifecycleException.updateMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) => ({
      count: args.where.id.in.length,
    }));

    const response = await send(PATCH, { ids: [...ids, "e1"], reason: "keep" });

    expect(await response.json()).toEqual({ updated: 40_000 });
    expect(mockPrisma.lifecycleException.updateMany).toHaveBeenCalledTimes(4);
    expect(mockPrisma.lifecycleException.updateMany.mock.calls[0][0].data).toEqual({ reason: "keep" });
  });
});
