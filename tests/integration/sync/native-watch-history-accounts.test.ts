/**
 * The native watch-history sync against a Plex server whose `/accounts` call
 * fails (a single 500 is not retried). Every play is attributed through that
 * map: the lenient lookup answered the failure with an empty map, so the full
 * replace rewrote the server's ENTIRE history under "Unknown" and marked it
 * established, and the incremental append stored each play in its overlap a
 * second time under the other name — a permanent playCount inflation, since
 * that column is reconciled monotonically. Drives the real PlexClient against a
 * local HTTP server.
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

const prisma = getTestPrisma();
const T0 = 1_750_000_000;
let server: http.Server;
let baseUrl = "";
let accountsFail = false;
let plays: Array<{ ratingKey: string; accountID: number; viewedAt: number }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("Content-Type", "application/json");
    if (url.startsWith("/accounts")) {
      if (accountsFail) {
        res.statusCode = 500;
        res.end("{}");
        return;
      }
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
  accountsFail = false;
  plays = [{ ratingKey: "r1", accountID: 1, viewedAt: T0 }];
});

async function seed() {
  const user = await createTestUser();
  const ms = await createTestServer(user.id, { type: "PLEX", url: baseUrl });
  const lib = await createTestLibrary(ms.id, { key: "1", type: "MOVIE" });
  const item = await createTestMediaItem(lib.id, { ratingKey: "r1", title: "Film" });
  return { ms, item };
}

describe("native watch history when Plex /accounts fails", () => {
  it("leaves the stored history as it was instead of re-labelling it Unknown", async () => {
    const { ms } = await seed();
    await syncWatchHistory(ms.id);
    expect((await prisma.watchHistory.findMany()).map((r) => r.serverUsername)).toEqual(["alice"]);
    const establishedAt = (await prisma.mediaServer.findUniqueOrThrow({ where: { id: ms.id } }))
      .watchHistorySyncedAt;

    accountsFail = true;
    await expect(syncWatchHistory(ms.id)).resolves.toEqual({ count: 0 });

    expect((await prisma.watchHistory.findMany()).map((r) => r.serverUsername)).toEqual(["alice"]);
    // A failed fetch establishes nothing.
    expect(
      (await prisma.mediaServer.findUniqueOrThrow({ where: { id: ms.id } })).watchHistorySyncedAt,
    ).toEqual(establishedAt);
  });

  it("does not double-store a play across an incremental refresh made during the outage", async () => {
    const { ms, item } = await seed();
    await syncWatchHistory(ms.id); // one play by alice

    // alice watches it again; the realtime refresh runs while /accounts fails...
    plays.push({ ratingKey: "r1", accountID: 1, viewedAt: T0 + 7200 });
    accountsFail = true;
    await syncWatchHistory(ms.id, undefined, undefined, { incremental: true });
    // ...and the next one, inside the same overlap window, runs healthy.
    accountsFail = false;
    await syncWatchHistory(ms.id, undefined, undefined, { incremental: true });

    const rows = await prisma.watchHistory.findMany({ orderBy: { watchedAt: "asc" } });
    expect(rows.map((r) => r.serverUsername)).toEqual(["alice", "alice"]);
    expect((await prisma.mediaItem.findUniqueOrThrow({ where: { id: item.id } })).playCount).toBe(2);
  });
});
