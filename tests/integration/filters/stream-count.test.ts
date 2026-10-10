import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession, setMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
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

import { filterIdsByStreamCounts, parseStreamCountFilters } from "@/lib/filters/stream-count";
import { GET as moviesGET } from "@/app/api/media/movies/route";
import { getTestPrisma } from "../../setup/test-db";

describe("stream count filters", () => {
  const db = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function setupMediaWithStreams() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    // Item A: 3 audio streams, 2 subtitle streams
    const itemA = await createTestMediaItem(lib.id, { title: "Movie A" });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 0, codec: "aac" });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 1, codec: "ac3" });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 2, codec: "dts" });
    await createTestMediaStream(itemA.id, { streamType: 3, index: 3, codec: "srt" });
    await createTestMediaStream(itemA.id, { streamType: 3, index: 4, codec: "srt" });

    // Item B: 1 audio stream, 0 subtitle streams
    const itemB = await createTestMediaItem(lib.id, { title: "Movie B" });
    await createTestMediaStream(itemB.id, { streamType: 2, index: 0, codec: "aac" });

    // Item C: 2 audio streams, 5 subtitle streams
    const itemC = await createTestMediaItem(lib.id, { title: "Movie C" });
    await createTestMediaStream(itemC.id, { streamType: 2, index: 0, codec: "aac" });
    await createTestMediaStream(itemC.id, { streamType: 2, index: 1, codec: "ac3" });
    for (let i = 2; i <= 6; i++) await createTestMediaStream(itemC.id, { streamType: 3, index: i, codec: "srt" });

    // Item D: 0 audio streams, 0 subtitle streams (only video stream)
    const itemD = await createTestMediaItem(lib.id, { title: "Movie D" });
    await createTestMediaStream(itemD.id, { streamType: 1, index: 0, codec: "h264" });

    // Item E: no stream rows at all
    const itemE = await createTestMediaItem(lib.id, { title: "Movie E" });

    return { user, itemA, itemB, itemC, itemD, itemE, ids: [itemA, itemB, itemC, itemD, itemE].map((i) => i.id) };
  }

  async function matching(ids: string[], query: Record<string, string>): Promise<string[]> {
    const filters = parseStreamCountFilters(new URLSearchParams(query));
    if (!filters) throw new Error("expected filters");
    return [...(await filterIdsByStreamCounts(db, ids, filters))].sort();
  }

  it("parses nothing when no stream count params are present", () => {
    expect(parseStreamCountFilters(new URLSearchParams())).toBeNull();
    expect(parseStreamCountFilters(new URLSearchParams({ audioStreamCountConditions: "gte:x" }))).toBeNull();
  });

  it("filters by audio stream count with each operator", async () => {
    const { itemA, itemB, itemC, itemD, itemE, ids } = await setupMediaWithStreams();
    expect(await matching(ids, { audioStreamCountConditions: "eq:3" })).toEqual([itemA.id]);
    expect(await matching(ids, { audioStreamCountConditions: "3" })).toEqual([itemA.id]);
    expect(await matching(ids, { audioStreamCountConditions: "gte:2" })).toEqual([itemA.id, itemC.id].sort());
    expect(await matching(ids, { audioStreamCountConditions: "gt:2" })).toEqual([itemA.id]);
    expect(await matching(ids, { audioStreamCountConditions: "lte:1" })).toEqual([itemB.id, itemD.id, itemE.id].sort());
  });

  it("filters by subtitle stream count", async () => {
    const { itemA, itemB, itemC, itemD, itemE, ids } = await setupMediaWithStreams();
    expect(await matching(ids, { subtitleStreamCountConditions: "eq:5" })).toEqual([itemC.id]);
    expect(await matching(ids, { subtitleStreamCountConditions: "gt:3" })).toEqual([itemC.id]);
    expect(await matching(ids, { subtitleStreamCountConditions: "lt:3" })).toEqual(
      [itemA.id, itemB.id, itemD.id, itemE.id].sort(),
    );
  });

  it("combines conditions with AND, within and across stream types", async () => {
    const { itemA, itemC, ids } = await setupMediaWithStreams();
    expect(await matching(ids, { audioStreamCountConditions: "gte:3", subtitleStreamCountConditions: "eq:2" })).toEqual([itemA.id]);
    expect(await matching(ids, { audioStreamCountConditions: "gte:2|lte:3" })).toEqual([itemA.id, itemC.id].sort());
    expect(await matching(ids, { audioStreamCountConditions: "eq:100" })).toEqual([]);
  });

  it("counts an item with no stream rows at all as 0 tracks", async () => {
    // The old GROUP BY over MediaStream never saw such an item, so "eq:0"
    // missed it.
    const { itemD, itemE, ids } = await setupMediaWithStreams();
    expect(await matching(ids, { audioStreamCountConditions: "eq:0" })).toEqual([itemD.id, itemE.id].sort());
  });

  it("only answers for the ids it is given", async () => {
    const { itemA, itemC } = await setupMediaWithStreams();
    expect(await matching([itemC.id], { audioStreamCountConditions: "gte:2" })).toEqual([itemC.id]);
    expect(await matching([], { audioStreamCountConditions: "gte:2" })).toEqual([]);
    expect(itemA.id).toBeTruthy();
  });

  it("clamps a count past the integer range instead of failing the query", async () => {
    const { ids } = await setupMediaWithStreams();
    expect(await matching(ids, { audioStreamCountConditions: "gt:99999999999999999999" })).toEqual([]);
    expect(await matching(ids, { audioStreamCountConditions: "lt:99999999999999999999" })).toEqual([...ids].sort());
  });

  describe("on the movies list", () => {
    it("applies the filter with paging intact", async () => {
      const { user, itemA, itemC } = await setupMediaWithStreams();
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const page = async (searchParams: Record<string, string>) =>
        expectJson<{ items: { id: string }[]; pagination: { hasMore: boolean } }>(
          await callRoute(moviesGET, { url: "/api/media/movies", searchParams }),
          200,
        );

      const first = await page({ audioStreamCountConditions: "gte:2", limit: "1" });
      expect(first.items.map((i) => i.id)).toEqual([itemA.id]);
      expect(first.pagination.hasMore).toBe(true);
      const second = await page({ audioStreamCountConditions: "gte:2", limit: "1", page: "2" });
      expect(second.items.map((i) => i.id)).toEqual([itemC.id]);
      expect(second.pagination.hasMore).toBe(false);
      const all = await page({ audioStreamCountConditions: "gte:2", limit: "0" });
      expect(all.items.map((i) => i.id)).toEqual([itemA.id, itemC.id]);
      const sortedDesc = await page({ audioStreamCountConditions: "gte:2", sortBy: "title", sortOrder: "desc" });
      expect(sortedDesc.items.map((i) => i.id)).toEqual([itemC.id, itemA.id]);
    });

    it("answers on a library with more matches than the database takes bind parameters", async () => {
      // `id IN (<every match>)` failed here with P2029 → 500.
      const user = await createTestUser();
      const server = await createTestServer(user.id);
      const lib = await createTestLibrary(server.id, { type: "MOVIE" });
      const N = 33_000;
      const items = Array.from({ length: N }, (_, i) => ({
        id: `bulk-${String(i).padStart(5, "0")}`,
        libraryId: lib.id,
        ratingKey: `rk-${i}`,
        title: `Bulk ${String(i).padStart(5, "0")}`,
        type: "MOVIE" as const,
      }));
      for (let i = 0; i < N; i += 5000) await db.mediaItem.createMany({ data: items.slice(i, i + 5000) });
      const streams = items.map((it) => ({ mediaItemId: it.id, streamType: 2, index: 0 }));
      for (let i = 0; i < N; i += 5000) await db.mediaStream.createMany({ data: streams.slice(i, i + 5000) });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const body = await expectJson<{ items: { id: string }[]; pagination: { hasMore: boolean } }>(
        await callRoute(moviesGET, { url: "/api/media/movies", searchParams: { audioStreamCountConditions: "gte:1", limit: "3" } }),
        200,
      );
      expect(body.items.map((i) => i.id)).toEqual(["bulk-00000", "bulk-00001", "bulk-00002"]);
      expect(body.pagination.hasMore).toBe(true);

      const all = await expectJson<{ items: { id: string }[] }>(
        await callRoute(moviesGET, { url: "/api/media/movies", searchParams: { audioStreamCountConditions: "gte:1", limit: "0" } }),
        200,
      );
      expect(all.items).toHaveLength(N);
    }, 120_000);
  });
});
