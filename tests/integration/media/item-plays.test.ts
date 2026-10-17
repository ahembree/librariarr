import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import { GET } from "@/app/api/media/[id]/plays/route";
import { MAX_SKIP } from "@/lib/api/pagination";

/**
 * `GET /api/media/[id]/plays` — the per-play watch history for ONE item, which
 * is what finally gives movies and tracks the view series pages have had.
 *
 * It is a sibling of `/api/media/[id]/history`, not a replacement: that one is
 * a per-user AGGREGATE fetched live from the media server (username, play
 * count, last played) with no timestamps and none of the Tracearr detail. This
 * one reads the stored `WatchHistory` rows.
 */
interface PlayRow {
  id: string;
  serverUsername: string;
  watchedAt: string | null;
  deviceName: string | null;
  source: string;
  watched: boolean | null;
  percentComplete: number | null;
  isTranscode: boolean | null;
  player: string | null;
  resolution: string | null;
  mediaItem: { id: string; title: string; type: string };
  server: { id: string; name: string; type: string };
}
interface PlaysResponse {
  items: PlayRow[];
  pagination: { page: number; limit: number; hasMore: boolean; totalCount: number };
}

async function fixture() {
  const prisma = getTestPrisma();
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const movie = await createTestMediaItem(library.id, { type: "MOVIE", title: "Arrival" });
  const other = await createTestMediaItem(library.id, { type: "MOVIE", title: "Dune" });
  return { prisma, user, server, library, movie, other };
}

function get(id: string, query = "") {
  return callRouteWithParams(GET, { id }, { url: `/api/media/${id}/plays${query}` });
}

describe("GET /api/media/[id]/plays", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 when not authenticated", async () => {
    const { movie } = await fixture();
    await expectJson(await get(movie.id), 401);
  });

  it("404s an id that names no item", async () => {
    const { user } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<{ error: string }>(await get("nonexistent"), 404);
    expect(body.error).toBe("Not found");
  });

  it("returns the item's plays, newest first, with the full Tracearr detail", async () => {
    const { prisma, user, server, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    await prisma.watchHistory.createMany({
      data: [
        {
          mediaItemId: movie.id,
          mediaServerId: server.id,
          serverUsername: "alice",
          watchedAt: new Date("2025-01-01T00:00:00Z"),
          source: "TRACEARR",
          sourceEventId: "chain-old",
          watched: true,
          percentComplete: 98,
          isTranscode: true,
          player: "Chrome",
          resolution: "1080",
        },
        {
          mediaItemId: movie.id,
          mediaServerId: server.id,
          serverUsername: "bob",
          watchedAt: new Date("2025-06-01T00:00:00Z"),
          source: "TRACEARR",
          sourceEventId: "chain-new",
          watched: false,
          percentComplete: 4,
        },
      ],
    });

    const body = await expectJson<PlaysResponse>(await get(movie.id), 200);

    expect(body.pagination.totalCount).toBe(2);
    expect(body.items.map((i) => i.serverUsername)).toEqual(["bob", "alice"]);

    // The whole point of the endpoint: the enriched columns reach a movie page.
    const finished = body.items[1];
    expect(finished.percentComplete).toBe(98);
    expect(finished.isTranscode).toBe(true);
    expect(finished.player).toBe("Chrome");
    expect(finished.resolution).toBe("1080");
    expect(finished.mediaItem.type).toBe("MOVIE");

    // An abandoned play is display data and is returned like any other — only
    // the watch-state reconcile applies the completion threshold.
    expect(body.items[0].watched).toBe(false);
    expect(body.items[0].percentComplete).toBe(4);
  });

  it("returns native rows with the Tracearr columns present and null", async () => {
    // The UI keys its rich secondary line off exactly that, so they must be
    // returned rather than omitted.
    const { prisma, user, server, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2025-01-01T00:00:00Z"),
        deviceName: "Living Room",
      },
    });

    const body = await expectJson<PlaysResponse>(await get(movie.id), 200);
    const row = body.items[0];
    expect(row.source).toBe("NATIVE");
    expect(row.deviceName).toBe("Living Room");
    expect(row).toHaveProperty("percentComplete", null);
    expect(row).toHaveProperty("isTranscode", null);
    expect(row).toHaveProperty("watched", null);
  });

  it("does not leak another item's plays", async () => {
    const { prisma, user, server, movie, other } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    await prisma.watchHistory.create({
      data: {
        mediaItemId: other.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2025-01-05T21:00:00Z"),
      },
    });

    const body = await expectJson<PlaysResponse>(await get(movie.id), 200);
    expect(body.items).toHaveLength(0);
    expect(body.pagination.totalCount).toBe(0);
  });

  it("pages through a tie block without duplicating or dropping rows", async () => {
    const { prisma, user, server, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Identical timestamps. The shared query appends `{ id: "asc" }` after the
    // user-visible sort to keep the order total; without it Postgres may return
    // a tie block in any order, and two differently-planned requests permute the
    // block straddling a page boundary — some rows twice, others dropped.
    //
    // Five rows cannot force the permutation itself — the planner picks the
    // same plan for every page at this size — so this pins the contract the
    // tiebreaker provides instead: counts, hasMore, and the tie read in id
    // order, every play exactly once.
    const sameInstant = new Date("2025-03-03T12:00:00Z");
    await prisma.watchHistory.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: `user${i}`,
        watchedAt: sameInstant,
      })),
    });

    const first = await expectJson<PlaysResponse>(await get(movie.id, "?page=1&limit=2"), 200);
    const second = await expectJson<PlaysResponse>(await get(movie.id, "?page=2&limit=2"), 200);
    const third = await expectJson<PlaysResponse>(await get(movie.id, "?page=3&limit=2"), 200);

    expect([first, second, third].map((p) => p.pagination.hasMore)).toEqual([true, true, false]);
    expect([first, second, third].map((p) => p.pagination.totalCount)).toEqual([5, 5, 5]);

    // Within the tie, rows come in id order — every play once.
    const expected = (
      await prisma.watchHistory.findMany({ where: { mediaItemId: movie.id }, orderBy: { id: "asc" }, select: { id: true } })
    ).map((r) => r.id);
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(ids).toEqual(expected);
  });

  it("clamps a nonsense limit instead of erroring", async () => {
    // A zero or negative limit produced LIMIT 0 / a negative OFFSET, which
    // Postgres rejects outright.
    const { user, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const zero = await expectJson<PlaysResponse>(await get(movie.id, "?limit=0"), 200);
    expect(zero.pagination.limit).toBe(1);

    const negative = await expectJson<PlaysResponse>(await get(movie.id, "?limit=-3"), 200);
    expect(negative.pagination.limit).toBe(1);

    const huge = await expectJson<PlaysResponse>(await get(movie.id, "?limit=99999"), 200);
    expect(huge.pagination.limit).toBe(200);
  });

  it("answers an absurd page with an empty page and echoes a bounded page number", async () => {
    const { user, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const body = await expectJson<PlaysResponse & { pagination: { page: number } }>(
      await get(movie.id, "?page=99999999999999999999"),
      200,
    );
    expect(body.items).toEqual([]);
    expect(body.pagination.hasMore).toBe(false);
    expect(body.pagination.page).toBe(MAX_SKIP);
  });

  it("scopes to one server when asked", async () => {
    const { prisma, user, server, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const otherServer = await createTestServer(user.id, { name: "Second" });

    // A play is recorded on the server the item lives on.
    await prisma.watchHistory.createMany({
      data: [
        { mediaItemId: movie.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date("2025-02-01T20:00:00Z") },
        { mediaItemId: movie.id, mediaServerId: server.id, serverUsername: "bob", watchedAt: new Date("2025-02-02T20:00:00Z") },
      ],
    });

    const all = await expectJson<PlaysResponse>(await get(movie.id), 200);
    expect(all.pagination.totalCount).toBe(2);

    const scoped = await expectJson<PlaysResponse>(
      await get(movie.id, `?serverId=${server.id}`),
      200,
    );
    expect(scoped.items.map((i) => i.serverUsername)).toEqual(["bob", "alice"]);
    expect(scoped.items.every((i) => i.server.id === server.id)).toBe(true);

    const elsewhere = await expectJson<PlaysResponse>(
      await get(movie.id, `?serverId=${otherServer.id}`),
      200,
    );
    expect(elsewhere.items).toEqual([]);
    expect(elsewhere.pagination.totalCount).toBe(0);
  });
});
