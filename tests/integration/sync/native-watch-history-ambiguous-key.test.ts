/**
 * The native watch-history sync on a server that holds the same rating key in
 * two libraries (`@@unique([libraryId, ratingKey])` allows it). The full
 * replace and the incremental append both mapped key → item across the whole
 * server, so whichever row came last took every play for that key — plays on
 * the wrong item, and `playCount`/`lastPlayedAt` are reconciled monotonically,
 * so nothing ever walked them back. A play is now placed by the library section
 * Plex's history names, and skipped when it names none. Drives the real
 * PlexClient against a local HTTP server.
 */
import http from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { createTestUser, createTestServer, createTestLibrary, createTestMediaItem } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

import { syncWatchHistory } from "@/lib/sync/sync-watch-history";
import { logger } from "@/lib/logger";

const prisma = getTestPrisma();
const T0 = 1_750_000_000;
let server: http.Server;
let baseUrl = "";
let plays: Array<{ ratingKey: string; accountID: number; viewedAt: number; librarySectionID?: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/accounts")) {
      res.end(JSON.stringify({ MediaContainer: { Account: [{ id: 1, name: "alice" }] } }));
      return;
    }
    if (url.startsWith("/devices")) {
      res.end(JSON.stringify({ MediaContainer: { Device: [] } }));
      return;
    }
    if (url.startsWith("/status/sessions/history/all")) {
      const m = /viewedAt>=(\d+)/.exec(url);
      const since = m ? Number(m[1]) : 0;
      const list = plays.filter((p) => p.viewedAt >= since);
      res.end(JSON.stringify({ MediaContainer: { totalSize: list.length, Metadata: list } }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.watchHistory.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await cleanDatabase();
  vi.clearAllMocks();
});

/** One server, rating key "r1" in two libraries, plus an unambiguous "r2". */
async function seed() {
  const user = await createTestUser();
  const ms = await createTestServer(user.id, { type: "PLEX", url: baseUrl });
  const movies = await createTestLibrary(ms.id, { key: "1", type: "MOVIE" });
  const kids = await createTestLibrary(ms.id, { key: "2", type: "MOVIE" });
  const inMovies = await createTestMediaItem(movies.id, { ratingKey: "r1", title: "Heat" });
  const inKids = await createTestMediaItem(kids.id, { ratingKey: "r1", title: "Paddington" });
  const unique = await createTestMediaItem(movies.id, { ratingKey: "r2", title: "Ronin" });
  return { ms, inMovies, inKids, unique };
}

async function playsOn(itemId: string) {
  return prisma.watchHistory.count({ where: { mediaItemId: itemId } });
}

describe("native watch history with a rating key two libraries hold", () => {
  it("full replace places a play by its library section and skips one with none", async () => {
    const { ms, inMovies, inKids, unique } = await seed();
    plays = [
      { ratingKey: "r1", accountID: 1, viewedAt: T0, librarySectionID: "2" },
      // No section: nothing says which "r1" was played.
      { ratingKey: "r1", accountID: 1, viewedAt: T0 + 60 },
      { ratingKey: "r2", accountID: 1, viewedAt: T0 + 120 },
    ];

    await expect(syncWatchHistory(ms.id)).resolves.toEqual({ count: 2 });

    expect(await playsOn(inKids.id)).toBe(1);
    expect(await playsOn(inMovies.id)).toBe(0);
    // An unambiguous key needs no section.
    expect(await playsOn(unique.id)).toBe(1);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: inMovies.id } })).playCount).toBe(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      "WatchHistory",
      expect.stringContaining("1 rating key(s)"),
      { ratingKeys: ["r1"] },
    );
  });

  it("incremental append places a play the same way", async () => {
    const { ms, inMovies, inKids } = await seed();
    plays = [{ ratingKey: "r2", accountID: 1, viewedAt: T0 }];
    await syncWatchHistory(ms.id); // establishes the history the append resumes from

    plays.push(
      { ratingKey: "r1", accountID: 1, viewedAt: T0 + 60, librarySectionID: "1" },
      { ratingKey: "r1", accountID: 1, viewedAt: T0 + 120 },
    );
    await expect(
      syncWatchHistory(ms.id, undefined, undefined, { incremental: true }),
    ).resolves.toEqual({ count: 1 });

    expect(await playsOn(inMovies.id)).toBe(1);
    expect(await playsOn(inKids.id)).toBe(0);
  });
});
