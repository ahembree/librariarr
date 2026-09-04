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

  it("404s an item belonging to another owner rather than leaking its plays", async () => {
    // The reason ownership is checked on the ITEM before any history is read: a
    // bare `findUnique` by id would happily return someone else's watch history.
    const { movie } = await fixture();
    const intruder = await createTestUser({ username: "intruder" });
    setMockSession({ isLoggedIn: true, userId: intruder.id });

    await expectJson(await get(movie.id), 404);
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
        watchedAt: new Date(),
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
    // Honest caveat: five rows cannot force that. The planner picks the same
    // plan for every page at this size, so this test passes with or without the
    // tiebreaker — it guards the paging contract (counts, hasMore, no overlap),
    // not the tiebreaker itself, which only misbehaves at a scale no
    // integration test should seed.
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

    expect(first.pagination.hasMore).toBe(true);
    expect(third.pagination.hasMore).toBe(false);

    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("clamps a nonsense limit instead of erroring", async () => {
    // A zero or negative limit produced LIMIT 0 / a negative OFFSET, which
    // Postgres rejects outright.
    const { user, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });

    const zero = await expectJson<PlaysResponse>(await get(movie.id, "?limit=0"), 200);
    expect(zero.pagination.limit).toBeGreaterThan(0);

    const huge = await expectJson<PlaysResponse>(await get(movie.id, "?limit=99999"), 200);
    expect(huge.pagination.limit).toBeLessThanOrEqual(200);
  });

  it("scopes to one server when asked", async () => {
    const { prisma, user, server, movie } = await fixture();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const otherServer = await createTestServer(user.id, { name: "Second" });

    await prisma.watchHistory.createMany({
      data: [
        { mediaItemId: movie.id, mediaServerId: server.id, serverUsername: "alice", watchedAt: new Date() },
        { mediaItemId: movie.id, mediaServerId: otherServer.id, serverUsername: "bob", watchedAt: new Date() },
      ],
    });

    const all = await expectJson<PlaysResponse>(await get(movie.id), 200);
    expect(all.pagination.totalCount).toBe(2);

    const scoped = await expectJson<PlaysResponse>(
      await get(movie.id, `?serverId=${server.id}`),
      200,
    );
    expect(scoped.pagination.totalCount).toBe(1);
    expect(scoped.items[0].serverUsername).toBe("alice");
  });
});
