import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import type { Prisma } from "@/generated/prisma/client";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// For the cases that run the real importer.
const m = vi.hoisted(() => ({
  getHistoryPage: vi.fn(),
  listServers: vi.fn(),
  getServerAccountNames: vi.fn(),
  findOldestPlayAt: vi.fn(),
}));
vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    this.getHistoryPage = m.getHistoryPage;
    this.listServers = m.listServers;
    this.getServerAccountNames = m.getServerAccountNames;
    this.findOldestPlayAt = m.findOldestPlayAt;
  },
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/integrations/tracearr/status/route";
// Saves that queue a slice, driven for real into the job table the route reads.
import { PUT as PUT_SERVER } from "@/app/api/servers/[id]/route";
import { PUT as PUT_INSTANCE } from "@/app/api/integrations/tracearr/[id]/route";
import { releaseJobsClient } from "@/lib/jobs/client";
import {
  releaseLibraryResyncHold,
  requireLibraryResync,
  restartTracearrBackfill,
} from "@/lib/media/watch-evidence";
import { syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { TRACEARR_SERVER_ID, play } from "../sync/fake-tracearr-archive";
// The fraction arithmetic is a pure helper beside the route, so its edge cases
// are exercised directly as well as through the response shape.
import {
  computeBackfillFraction,
  importAwaitingSync,
  importPausedReason,
  importPending,
  resolveBackfillReach,
} from "@/app/api/integrations/tracearr/status/backfill-fraction";
import {
  beginTracearrImport,
  endTracearrImport,
  recordTracearrImportPage,
  retireTracearrImports,
} from "@/lib/sync/tracearr-import-activity";

interface StatusRow {
  serverId: string;
  serverName: string;
  tracearrServerId: string | null;
  backfillComplete: boolean;
  importedCount: number;
  oldestImported: string | null;
  newestImported: string | null;
  oldestPlayAt: string | null;
  reachedAt: string | null;
  backfillFraction: number | null;
  pending: boolean;
  pausedReason:
    | "server-disabled"
    | "instance-unavailable"
    | "no-library-items"
    | "import-failing"
    | "awaiting-sync"
    | null;
  lastWalkAt: string | null;
  activeImport: {
    pass: "forward" | "backfill" | null;
    startedAt: string;
    pages: number;
    imported: number;
    oldestReached: string | null;
    backfillReached: string | null;
  } | null;
}

const STATUS_URL = "/api/integrations/tracearr/status";

/**
 * Map a server to a Tracearr server id. `createTestServer` has no override for
 * the Tracearr columns, so the mapping is applied after creation rather than
 * reaching into the shared factory.
 *
 * Also gives an itemless server an item: an empty server reads `no-library-items`.
 */
async function mapToTracearr(
  serverId: string,
  tracearrServerId: string,
  opts: { backfillComplete?: boolean; oldestPlayAt?: Date | null } = {}
) {
  const prisma = getTestPrisma();
  const populated = await prisma.mediaItem.count({
    where: { library: { mediaServerId: serverId, enabled: true } },
  });
  if (populated === 0) await createItemFor(serverId, `Seed ${tracearrServerId.slice(-4)}`);
  return prisma.mediaServer.update({
    where: { id: serverId },
    data: {
      tracearrServerId,
      tracearrBackfillComplete: opts.backfillComplete ?? false,
      tracearrOldestPlayAt: opts.oldestPlayAt ?? null,
    },
  });
}

/** An enabled Tracearr instance — without one no mapped server can import. */
async function createInstance(userId: string, enabled = true) {
  return getTestPrisma().tracearrInstance.create({
    data: { userId, name: "Tracearr", url: "http://tracearr.test", apiKey: "key", enabled },
  });
}

/** A media item on its own library, so watch rows have something to hang off. */
async function createItemFor(serverId: string, title: string) {
  const library = await createTestLibrary(serverId, { title: `${title} Library` });
  return createTestMediaItem(library.id, { title });
}

/**
 * Seed one imported play. `sourceEventId` is unique per (server, event), which
 * mirrors the importer's dedup constraint — reusing an id across servers is
 * legal and is what the "two mapped servers" case relies on.
 */
async function createWatchRow(opts: {
  mediaItemId: string;
  mediaServerId: string;
  watchedAt: Date | null;
  source?: string;
  sourceEventId?: string | null;
}) {
  const prisma = getTestPrisma();
  return prisma.watchHistory.create({
    data: {
      mediaItemId: opts.mediaItemId,
      mediaServerId: opts.mediaServerId,
      serverUsername: "viewer",
      watchedAt: opts.watchedAt,
      source: opts.source ?? "TRACEARR",
      sourceEventId: opts.sourceEventId ?? null,
    },
  });
}

// `pending` is judged on the job table when one can be read; every test outside
// the "job on the queue" block runs without one.
beforeAll(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
  await pool.end();
});

describe("GET /api/integrations/tracearr/status", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns an empty list when no server is mapped to Tracearr", async () => {
    const user = await createTestUser();
    await createTestServer(user.id);
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);
    expect(body.servers).toEqual([]);
  });

  it("reports the count and both boundaries for a mapped server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Test Plex" });
    await mapToTracearr(server.id, "11111111-1111-1111-1111-111111111111");
    const item = await createItemFor(server.id, "Arrival");

    const oldest = new Date("2024-03-06T03:50:09.000Z");
    const middle = new Date("2025-01-01T12:00:00.000Z");
    const newest = new Date("2026-09-03T18:55:34.377Z");
    for (const [i, watchedAt] of [oldest, middle, newest].entries()) {
      await createWatchRow({
        mediaItemId: item.id,
        mediaServerId: server.id,
        watchedAt,
        sourceEventId: `evt-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toEqual({
      serverId: server.id,
      serverName: "Test Plex",
      tracearrServerId: "11111111-1111-1111-1111-111111111111",
      backfillComplete: false,
      importedCount: 3,
      oldestImported: oldest.toISOString(),
      newestImported: newest.toISOString(),
      // Nothing has measured the far edge of Tracearr's archive yet, so how far
      // the walk has to go is unknown — indeterminate, not zero.
      oldestPlayAt: null,
      reachedAt: oldest.toISOString(),
      backfillFraction: null,
      // Owed, but no Tracearr instance is configured to serve it.
      pending: false,
      pausedReason: "instance-unavailable",
      lastWalkAt: null,
      activeImport: null,
    });
  });

  it("reports no live import when nothing is running", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Idle" });
    await mapToTracearr(server.id, "55555555-5555-5555-5555-555555555555", { backfillComplete: true });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const body = await expectJson<{ servers: StatusRow[] }>(await callRoute(GET, { url: STATUS_URL }));

    expect(body.servers[0].activeImport).toBeNull();
  });

  it("reports the import running right now, even after the backfill completed", async () => {
    // The stored rows say how much history is here; only this says a job is
    // importing at this moment — which "History fully imported" cannot.
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Busy" });
    await mapToTracearr(server.id, "66666666-6666-6666-6666-666666666666", { backfillComplete: true });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const run = beginTracearrImport(server.id, user.id);
    recordTracearrImportPage(run, {
      pass: "forward",
      pages: 2,
      imported: 140,
      oldestReached: new Date("2025-07-10T11:00:00.000Z"),
    });
    try {
      const body = await expectJson<{ servers: StatusRow[] }>(await callRoute(GET, { url: STATUS_URL }));
      expect(body.servers[0].activeImport).toMatchObject({
        pass: "forward",
        pages: 2,
        imported: 140,
        oldestReached: "2025-07-10T11:00:00.000Z",
      });
      expect(body.servers[0].activeImport).not.toHaveProperty("userId");
    } finally {
      endTracearrImport(run);
    }
  });

  it("excludes a server that is not mapped to Tracearr", async () => {
    const user = await createTestUser();
    const mapped = await createTestServer(user.id, { name: "Mapped" });
    await mapToTracearr(mapped.id, "22222222-2222-2222-2222-222222222222");
    const unmapped = await createTestServer(user.id, { name: "Unmapped" });

    // The unmapped server even has native history — it still must not appear,
    // because it has no Tracearr import to report progress on.
    const nativeItem = await createItemFor(unmapped.id, "Native Movie");
    await createWatchRow({
      mediaItemId: nativeItem.id,
      mediaServerId: unmapped.id,
      watchedAt: new Date("2025-05-05T00:00:00.000Z"),
      source: "NATIVE",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers.map((s) => s.serverId)).toEqual([mapped.id]);
  });

  it("returns zero with null boundaries for a mapped server with nothing imported", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Fresh" });
    await mapToTracearr(server.id, "33333333-3333-3333-3333-333333333333");

    // Native rows on this very server must not be mistaken for imported ones:
    // a server mapped partway through its life keeps its pre-mapping history.
    const item = await createItemFor(server.id, "Pre-mapping Play");
    await createWatchRow({
      mediaItemId: item.id,
      mediaServerId: server.id,
      watchedAt: new Date("2023-01-01T00:00:00.000Z"),
      source: "NATIVE",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].importedCount).toBe(0);
    expect(body.servers[0].oldestImported).toBeNull();
    expect(body.servers[0].newestImported).toBeNull();
  });

  it("excludes another user's mapped server", async () => {
    const user = await createTestUser();
    const other = await createTestUser({ plexId: "plex-other", username: "other" });

    const mine = await createTestServer(user.id, { name: "Mine" });
    await mapToTracearr(mine.id, "44444444-4444-4444-4444-444444444444");
    const theirs = await createTestServer(other.id, { name: "Theirs" });
    await mapToTracearr(theirs.id, "55555555-5555-5555-5555-555555555555");

    const theirItem = await createItemFor(theirs.id, "Their Movie");
    await createWatchRow({
      mediaItemId: theirItem.id,
      mediaServerId: theirs.id,
      watchedAt: new Date("2025-02-02T00:00:00.000Z"),
      sourceEventId: "their-evt",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers.map((s) => s.serverId)).toEqual([mine.id]);
  });

  it("keeps each mapped server's rows to itself", async () => {
    const user = await createTestUser();
    // Names chosen so the response order (name asc) is deterministic.
    const alpha = await createTestServer(user.id, { name: "Alpha" });
    const bravo = await createTestServer(user.id, { name: "Bravo" });
    await mapToTracearr(alpha.id, "66666666-6666-6666-6666-666666666666");
    await mapToTracearr(bravo.id, "77777777-7777-7777-7777-777777777777", {
      backfillComplete: true,
    });

    const alphaItem = await createItemFor(alpha.id, "Alpha Movie");
    const bravoItem = await createItemFor(bravo.id, "Bravo Movie");

    // Two plays on Alpha, five on Bravo, with non-overlapping windows so a
    // grouped query that leaked rows across servers would move a boundary too.
    for (let i = 0; i < 2; i++) {
      await createWatchRow({
        mediaItemId: alphaItem.id,
        mediaServerId: alpha.id,
        watchedAt: new Date(Date.UTC(2024, 0, 1 + i)),
        sourceEventId: `alpha-${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      await createWatchRow({
        mediaItemId: bravoItem.id,
        mediaServerId: bravo.id,
        watchedAt: new Date(Date.UTC(2026, 0, 1 + i)),
        sourceEventId: `bravo-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers).toHaveLength(2);
    const [first, second] = body.servers;

    expect(first.serverName).toBe("Alpha");
    expect(first.importedCount).toBe(2);
    expect(first.oldestImported).toBe(new Date(Date.UTC(2024, 0, 1)).toISOString());
    expect(first.newestImported).toBe(new Date(Date.UTC(2024, 0, 2)).toISOString());
    // The backfill flag is read straight off the column, per server.
    expect(first.backfillComplete).toBe(false);

    expect(second.serverName).toBe("Bravo");
    expect(second.importedCount).toBe(5);
    expect(second.oldestImported).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
    expect(second.newestImported).toBe(new Date(Date.UTC(2026, 0, 5)).toISOString());
    expect(second.backfillComplete).toBe(true);
    // Alpha has rows but no measured edge (indeterminate); Bravo is flagged
    // complete, which is 1 regardless of what its boundaries look like.
    expect(first.backfillFraction).toBeNull();
    expect(second.backfillFraction).toBe(1);
  });

  it("reports a determinate fraction part-way through the walk", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Walking" });

    // A clean 10-day span with 3 days covered, so the expected fraction is an
    // exact 0.3 rather than something the test has to reverse-engineer. Whole
    // UTC days keep the arithmetic free of month/leap-year length differences.
    const oldestPlayAt = new Date(Date.UTC(2026, 0, 1));
    const oldestImported = new Date(Date.UTC(2026, 0, 8));
    const newestImported = new Date(Date.UTC(2026, 0, 11));

    await mapToTracearr(server.id, "88888888-8888-8888-8888-888888888888", {
      oldestPlayAt,
    });
    const item = await createItemFor(server.id, "Mid Walk");
    for (const [i, watchedAt] of [oldestImported, newestImported].entries()) {
      await createWatchRow({
        mediaItemId: item.id,
        mediaServerId: server.id,
        watchedAt,
        sourceEventId: `walk-${i}`,
      });
    }

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers[0].backfillComplete).toBe(false);
    // Serialised like every other instant on this surface.
    expect(body.servers[0].oldestPlayAt).toBe(oldestPlayAt.toISOString());
    expect(body.servers[0].backfillFraction).toBeCloseTo(0.3, 10);
  });

  it("clamps to 1 when an imported play predates the measured oldest play", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Overshot" });

    // Reachable, not paranoia: the edge is measured once, and the forward pass
    // keeps importing. A play older than the measurement can already be stored.
    await mapToTracearr(server.id, "99999999-9999-9999-9999-999999999999", {
      oldestPlayAt: new Date(Date.UTC(2026, 0, 5)),
    });
    const item = await createItemFor(server.id, "Older Than Measured");
    await createWatchRow({
      mediaItemId: item.id,
      mediaServerId: server.id,
      watchedAt: new Date(Date.UTC(2026, 0, 1)),
      sourceEventId: "overshot-old",
    });
    await createWatchRow({
      mediaItemId: item.id,
      mediaServerId: server.id,
      watchedAt: new Date(Date.UTC(2026, 0, 20)),
      sourceEventId: "overshot-new",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    // 19 days covered of a 15-day span — a full bar, never 1.27.
    expect(body.servers[0].backfillFraction).toBe(1);
  });

  it("returns null instead of dividing by zero when the newest import is the oldest play", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Single" });

    const only = new Date(Date.UTC(2026, 0, 9, 4, 30));
    await mapToTracearr(server.id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
      oldestPlayAt: only,
    });
    const item = await createItemFor(server.id, "Only Play");
    await createWatchRow({
      mediaItemId: item.id,
      mediaServerId: server.id,
      watchedAt: only,
      sourceEventId: "single-evt",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    // The span is zero, so there is no fraction of it to report — null, not
    // Infinity, not NaN (both of which would serialise as garbage or crash).
    expect(body.servers[0].backfillFraction).toBeNull();
  });

  it("returns a null fraction when the oldest play has not been measured", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Unmeasured" });
    await mapToTracearr(server.id, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    const item = await createItemFor(server.id, "Measured Nothing");
    await createWatchRow({
      mediaItemId: item.id,
      mediaServerId: server.id,
      watchedAt: new Date(Date.UTC(2026, 1, 2)),
      sourceEventId: "unmeasured-evt",
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers[0].importedCount).toBe(1);
    expect(body.servers[0].oldestPlayAt).toBeNull();
    expect(body.servers[0].backfillFraction).toBeNull();
  });

  it("returns a null fraction when the edge is measured but nothing is imported", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "Measured Empty" });
    const oldestPlayAt = new Date(Date.UTC(2019, 6, 21));
    await mapToTracearr(server.id, "cccccccc-cccc-cccc-cccc-cccccccccccc", {
      oldestPlayAt,
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRoute(GET, { url: STATUS_URL });
    const body = await expectJson<{ servers: StatusRow[] }>(response);

    expect(body.servers[0].importedCount).toBe(0);
    // The edge is known but there is no covered span yet — still unknowable,
    // because with no import there is no near boundary to measure from.
    expect(body.servers[0].oldestPlayAt).toBe(oldestPlayAt.toISOString());
    expect(body.servers[0].backfillFraction).toBeNull();
  });
});

describe("GET /api/integrations/tracearr/status — pending and reach", () => {
  let userId: string;
  let instanceId: string;
  let tracearrSeq = 0;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    userId = (await createTestUser()).id;
    instanceId = (await createInstance(userId)).id;
    setMockSession({ userId, plexToken: "tok", isLoggedIn: true });
  });

  const read = async () =>
    (await expectJson<{ servers: StatusRow[] }>(await callRoute(GET, { url: STATUS_URL }))).servers;
  const setServer = (id: string, data: Prisma.MediaServerUpdateInput) =>
    getTestPrisma().mediaServer.update({ where: { id }, data });

  /** A mapped, enabled server holding an item, with nothing imported. */
  async function freshServer(name: string, opts: Parameters<typeof mapToTracearr>[2] = {}) {
    const server = await createTestServer(userId, { name });
    await mapToTracearr(server.id, `a0000000-0000-4000-8000-${String(++tracearrSeq).padStart(12, "0")}`, opts);
    return server;
  }

  /** A mapped, enabled server with two imported plays and its far edge measured. */
  async function walkingServer(name: string) {
    const server = await freshServer(name, { oldestPlayAt: new Date(Date.UTC(2026, 0, 1)) });
    const item = await createItemFor(server.id, `${name} item`);
    for (const [i, watchedAt] of [new Date(Date.UTC(2026, 0, 8)), new Date(Date.UTC(2026, 0, 11))].entries()) {
      await createWatchRow({ mediaItemId: item.id, mediaServerId: server.id, watchedAt, sourceEventId: `${name}-${i}` });
    }
    return server;
  }

  it("is pending while an owed import has history to walk, and not once it is complete", async () => {
    const server = await walkingServer("Walking");

    const [row] = await read();
    expect(row.pending).toBe(true);
    expect(row.pausedReason).toBeNull();
    expect(row.backfillComplete).toBe(false);

    await setServer(server.id, { tracearrBackfillComplete: true });
    expect((await read())[0].pending).toBe(false);
  });

  // Without a readable job table (none here) the stored evidence stands in for
  // the queue; with one, these read `awaiting-sync` (below).
  it("is pending for a mapping no walk has run for yet, measured or restarted alike", async () => {
    // Reported as not pending, Settings read "Tracearr has no plays".
    await freshServer("A measured", { oldestPlayAt: new Date(Date.UTC(2020, 0, 1)) });
    const restarted = await freshServer("B restarted");
    await setServer(restarted.id, { tracearrBackfillCursorAt: new Date() });

    expect((await read()).map(({ importedCount, lastWalkAt, pending, pausedReason }) => ({
      importedCount,
      lastWalkAt,
      pending,
      pausedReason,
    }))).toEqual([
      { importedCount: 0, lastWalkAt: null, pending: true, pausedReason: null },
      { importedCount: 0, lastWalkAt: null, pending: true, pausedReason: null },
    ]);
  });

  describe("with a backfill job on the queue", () => {
    let pool: Pool;
    let utils: WorkerUtils;

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
      await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
      // Runs graphile-worker's own migrations: the real `graphile_worker.jobs`.
      utils = await makeWorkerUtils({ pgPool: pool });
      await utils.migrate();
    });

    afterAll(async () => {
      await releaseJobsClient();
      if (utils) await Promise.resolve(utils.release()).catch(() => {});
      if (pool) {
        await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE").catch(() => {});
        await pool.end().catch(() => {});
      }
    });

    const queueBackfill = (serverId: string) =>
      utils.addJob("tracearr-backfill", { serverId }, {
        jobKey: `tracearr-backfill:${serverId}`,
        maxAttempts: 3,
      });
    const park = (serverId: string) =>
      pool.query(
        `UPDATE graphile_worker._private_jobs SET attempts = max_attempts WHERE key = $1`,
        [`tracearr-backfill:${serverId}`],
      );
    const putServer = (serverId: string, body: Record<string, unknown>) =>
      callRouteWithParams(PUT_SERVER, { id: serverId }, { url: `/api/servers/${serverId}`, method: "PUT", body });
    const putInstance = (body: Record<string, unknown>) =>
      callRouteWithParams(PUT_INSTANCE, { id: instanceId }, {
        url: `/api/integrations/tracearr/${instanceId}`,
        method: "PUT",
        body,
      });

    it("is pending while a slice waits on the queue, even after an empty walk", async () => {
      const server = await freshServer("Queued");
      await setServer(server.id, { tracearrBackfillLastWalkAt: new Date() });

      // Walked and empty: its own end state, not awaiting a sync.
      const [empty] = await read();
      expect(empty.pending).toBe(false);
      expect(empty.pausedReason).toBeNull();

      await queueBackfill(server.id);
      expect((await read())[0].pending).toBe(true);
    });

    it("reports a parked slice as failing — never pending, even with plays imported", async () => {
      // Imported rows used to read "pending", polled forever.
      const server = await walkingServer("Failing");
      await queueBackfill(server.id);
      await park(server.id);

      const [row] = await read();
      expect(row.importedCount).toBe(2);
      expect(row.pending).toBe(false);
      expect(row.pausedReason).toBe("import-failing");

      // A run in progress (a Refresh, a slice re-queued since) is progress.
      const run = beginTracearrImport(server.id, userId);
      try {
        const [live] = await read();
        expect(live.pending).toBe(true);
        expect(live.pausedReason).toBeNull();
      } finally {
        endTracearrImport(run);
      }

      // The next watch-history sync re-queues it with fresh attempts.
      await queueBackfill(server.id);
      const [requeued] = await read();
      expect(requeued.pending).toBe(true);
      expect(requeued.pausedReason).toBeNull();
    });

    it("does not read a slice running its last attempt as parked", async () => {
      // graphile counts the attempt when it takes the job.
      const server = await walkingServer("Last try");
      await queueBackfill(server.id);
      await pool.query(
        `UPDATE graphile_worker._private_jobs
            SET attempts = max_attempts, locked_at = now(), locked_by = 'worker-1'
          WHERE key = $1`,
        [`tracearr-backfill:${server.id}`],
      );

      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("stops reading failing once a re-enabled Tracearr instance re-queues the slice", async () => {
      const server = await walkingServer("Parked");
      await queueBackfill(server.id);
      await park(server.id);
      expect((await read())[0].pausedReason).toBe("import-failing");

      await expectJson(await putInstance({ enabled: false }), 200);
      expect((await read())[0].pausedReason).toBe("instance-unavailable");

      await expectJson(await putInstance({ enabled: true }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("queues a fresh mapping's first slice on save, so it reads pending", async () => {
      const server = await createTestServer(userId, { name: "Fresh" });
      await createItemFor(server.id, "Fresh item");

      await expectJson(await putServer(server.id, { tracearrServerId: "a0000000-0000-4000-8000-000000000018" }), 200);

      const { rows } = await pool.query<{ queue_name: string; max_attempts: number; attempts: number }>(
        `SELECT "queue_name", "max_attempts", "attempts" FROM graphile_worker.jobs WHERE "key" = $1`,
        [`tracearr-backfill:${server.id}`],
      );
      expect(rows).toEqual([{ queue_name: "librariarr:main", max_attempts: 3, attempts: 0 }]);
      const [row] = await read();
      expect(row.lastWalkAt).toBeNull();
      expect(row.pending).toBe(true);
      expect(row.pausedReason).toBeNull();
    });

    it("queues the slice of a server re-enabled while its import was owed", async () => {
      const server = await walkingServer("Back");
      await setServer(server.id, { enabled: false });
      expect((await read())[0].pausedReason).toBe("server-disabled");

      await expectJson(await putServer(server.id, { enabled: true }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("reports an import held for a library resync as awaiting a sync, queued or not, until released", async () => {
      // The walk must follow the re-sync; a queued slice only no-ops.
      const server = await walkingServer("Purged");
      await setServer(server.id, { tracearrBackfillLastWalkAt: new Date() });
      // What a purge records before deleting (it also restarts the walk).
      await requireLibraryResync([server.id]);
      await queueBackfill(server.id);

      const [held] = await read();
      expect(held.pausedReason).toBe("awaiting-sync");
      expect(held.pending).toBe(false);

      // The sync that releases the hold leaves the queued slice to run.
      await releaseLibraryResyncHold(server.id, new Date());
      const [released] = await read();
      expect(released.pausedReason).toBeNull();
      expect(released.pending).toBe(true);
    });

    it("reports no-library-items when every library holding items is disabled — even with a slice queued", async () => {
      // No sync adds items to a disabled library; a queued slice only no-ops.
      const server = await freshServer("All disabled");
      await getTestPrisma().library.updateMany({ where: { mediaServerId: server.id }, data: { enabled: false } });
      await queueBackfill(server.id);

      const [row] = await read();
      expect(row.pausedReason).toBe("no-library-items");
      expect(row.pending).toBe(false);

      // A parked slice is not the cause while there is nothing to import into.
      await park(server.id);
      expect((await read())[0].pausedReason).toBe("no-library-items");

      // Re-enabled, the parked slice is the cause again.
      await getTestPrisma().library.updateMany({ where: { mediaServerId: server.id }, data: { enabled: true } });
      expect((await read())[0].pausedReason).toBe("import-failing");
    });

    describe("superseded runs, and restarted walks that find nothing", () => {
      let serverId: string;
      const row = async () => (await read())[0];

      beforeEach(async () => {
        for (const fn of Object.values(m)) fn.mockReset();
        m.listServers.mockResolvedValue([{ id: TRACEARR_SERVER_ID }]);
        m.getServerAccountNames.mockResolvedValue(new Map([["acct-1", "walter"]]));
        m.findOldestPlayAt.mockResolvedValue(null);
        serverId = (await createTestServer(userId, { name: "Plex", tracearrServerId: TRACEARR_SERVER_ID })).id;
        const library = await createTestLibrary(serverId, { type: "MOVIE" });
        await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE", title: "The Matrix" });
      });

      it("does not report a run a mapping change retired, so pending follows the job table", async () => {
        const run = beginTracearrImport(serverId, userId);
        try {
          recordTracearrImportPage(run, { pass: "backfill", pages: 40, imported: 3900, oldestReached: null });
          const live = await row();
          expect(live.activeImport).toMatchObject({ pages: 40, imported: 3900 });
          expect(live.pending).toBe(true);

          retireTracearrImports(serverId);

          const retired = await row();
          expect(retired.activeImport).toBeNull();
          // Owed with nothing queued: waiting on a sync, not "importing".
          expect(retired.pending).toBe(false);
          expect(retired.pausedReason).toBe("awaiting-sync");

          await queueBackfill(serverId);
          expect((await row()).pending).toBe(true);
        } finally {
          endTracearrImport(run);
        }
      });

      it("keeps a run a restart superseded on the readout, so it does not read as failing beside a parked slice", async () => {
        await queueBackfill(serverId);
        await park(serverId);
        const refresh = beginTracearrImport(serverId, userId);
        try {
          recordTracearrImportPage(refresh, { pass: "forward", pages: 2, imported: 120, oldestReached: null });
          expect((await row()).pausedReason).toBeNull();

          // The Refresh's plays are still this server's.
          await restartTracearrBackfill([serverId]);

          const during = await row();
          expect(during.activeImport).toMatchObject({ pass: "forward", pages: 2, imported: 120 });
          expect(during.pausedReason).toBeNull();
          expect(during.pending).toBe(true);
        } finally {
          endTracearrImport(refresh);
        }
        // Once it ends, the parked slice is all that is left.
        expect((await row()).pausedReason).toBe("import-failing");
      });

      it("keeps a slice the restart superseded mid-walk on the readout, without the reach it had", async () => {
        // A purge restarts the walk under a running backfill slice.
        let duringRun: StatusRow | undefined;
        m.getHistoryPage
          .mockImplementationOnce(async () => ({
            records: [play("p1", "2026-01-02T00:00:00.000Z")],
            nextCursor: "c2",
          }))
          .mockImplementationOnce(async () => {
            expect((await row()).activeImport).toMatchObject({
              pass: "backfill",
              pages: 1,
              backfillReached: "2026-01-02T00:00:00.000Z",
            });
            await requireLibraryResync([serverId]);
            duringRun = await row();
            return { records: [play("p2", "2026-01-01T00:00:00.000Z")], nextCursor: null };
          });

        await syncTracearrHistory(serverId, { passes: "backfill" });

        expect(duringRun?.activeImport).toMatchObject({ pass: "backfill", pages: 1, backfillReached: null });
        // Held until the library sync that brings the purged items back.
        expect(duringRun?.pausedReason).toBe("awaiting-sync");
        expect(duringRun?.pending).toBe(false);
      });

      it("reads walked-and-empty, not 'starts after the next full sync', once a released walk finds nothing", async () => {
        // A purge holds the server and moves the cursor to the restart instant.
        await requireLibraryResync([serverId]);
        const held = await row();
        expect(held.pausedReason).toBe("awaiting-sync");
        expect(held.pending).toBe(false);
        expect(await releaseLibraryResyncHold(serverId, new Date())).toBe(true);

        // The walk it queues finds nothing; the cursor stays at the restart.
        m.getHistoryPage.mockResolvedValue({ records: [], nextCursor: null });
        const walk = await syncTracearrHistory(serverId, { passes: "backfill" });
        expect(walk).toMatchObject({ backfillOutcome: "exhausted", backfillPending: true });
        expect(walk.heldReason).toBeUndefined();
        const stored = await getTestPrisma().mediaServer.findUniqueOrThrow({ where: { id: serverId } });
        expect(stored.tracearrBackfillCursorAt).not.toBeNull();

        // Nothing queued: the "no plays imported" end state, not pending.
        const after = await row();
        expect(after.lastWalkAt).not.toBeNull();
        expect(after.pausedReason).toBeNull();
        expect(after.pending).toBe(false);

        // A slice queued later (the next watch-history sync) reads as pending.
        await queueBackfill(serverId);
        expect((await row()).pending).toBe(true);
      });
    });
  });

  it("measures the bar from a live backfill run's reach, never a forward pass's", async () => {
    // The cursor is written once per slice; between writes the bar stood still.
    // A forward pass's reach (the newest hour) says nothing about the archive.
    const server = await walkingServer("Live");

    expect((await read())[0].backfillFraction).toBeCloseTo(0.3, 10);

    const run = beginTracearrImport(server.id, userId);
    try {
      recordTracearrImportPage(run, {
        pass: "forward",
        pages: 1,
        imported: 3,
        oldestReached: new Date(Date.UTC(2025, 0, 1)),
      });
      const [forward] = await read();
      expect(forward.backfillFraction).toBeCloseTo(0.3, 10);
      expect(forward.reachedAt).toBe(new Date(Date.UTC(2026, 0, 8)).toISOString());

      recordTracearrImportPage(run, {
        pass: "backfill",
        pages: 40,
        imported: 0,
        oldestReached: new Date(Date.UTC(2026, 0, 6)),
      });
      const [backfill] = await read();
      expect(backfill.backfillFraction).toBeCloseTo(0.5, 10);
      expect(backfill.reachedAt).toBe(new Date(Date.UTC(2026, 0, 6)).toISOString());
    } finally {
      endTracearrImport(run);
    }
  });

  it("reports the reach the fraction is measured from, not the oldest surviving row, after a purge restart", async () => {
    // The restart moves the cursor to now; rows that survived the purge still
    // reach the far end. The line read "0% … reached 2019".
    const server = await walkingServer("Restarted");
    const restartedAt = new Date(Date.UTC(2026, 0, 12));
    await setServer(server.id, { tracearrBackfillCursorAt: restartedAt });

    const [row] = await read();
    expect(row.backfillFraction).toBe(0);
    expect(row.reachedAt).toBe(restartedAt.toISOString());
    expect(row.oldestImported).toBe(new Date(Date.UTC(2026, 0, 8)).toISOString());
  });
});

describe("resolveBackfillReach", () => {
  const cursorAt = new Date(Date.UTC(2026, 0, 6));
  const oldestImported = new Date(Date.UTC(2026, 0, 8));

  it("prefers the cursor over the oldest row", () => {
    expect(resolveBackfillReach({ oldestImported, cursorAt })).toEqual(cursorAt);
    expect(resolveBackfillReach({ oldestImported, cursorAt: null })).toEqual(oldestImported);
    expect(resolveBackfillReach({ oldestImported: null })).toBeNull();
  });

  it("takes the live reach only when it is further back", () => {
    const older = new Date(Date.UTC(2026, 0, 3));
    const newer = new Date(Date.UTC(2026, 0, 7));
    expect(resolveBackfillReach({ oldestImported, cursorAt, liveReached: older })).toEqual(older);
    expect(resolveBackfillReach({ oldestImported, cursorAt, liveReached: newer })).toEqual(cursorAt);
    expect(resolveBackfillReach({ oldestImported: null, liveReached: newer })).toEqual(newer);
  });
});

describe("computeBackfillFraction", () => {
  const oldestPlayAt = new Date(Date.UTC(2026, 0, 1));
  const newestImported = new Date(Date.UTC(2026, 0, 11));

  it("is 1 whenever the backfill is flagged complete", () => {
    // Even when the arithmetic would say otherwise: the walk stops on an empty
    // slice, which can leave the oldest STORABLE play newer than the oldest play
    // Tracearr holds (that tail may all reference deleted media). The flag wins.
    expect(
      computeBackfillFraction({
        backfillComplete: true,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 10)),
        newestImported,
      })
    ).toBe(1);
  });

  it("is 1 when complete even with nothing measured or imported", () => {
    expect(
      computeBackfillFraction({
        backfillComplete: true,
        oldestPlayAt: null,
        oldestImported: null,
        newestImported: null,
      })
    ).toBe(1);
  });

  it("is null when the oldest play has not been measured", () => {
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt: null,
        oldestImported: new Date(Date.UTC(2026, 0, 8)),
        newestImported,
      })
    ).toBeNull();
  });

  it("is null when either import boundary is missing", () => {
    // MIN/MAX over `watchedAt` are null for a server with no imported rows —
    // and, because the column is nullable, can be null even with rows present.
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: null,
        newestImported: null,
      })
    ).toBeNull();
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 8)),
        newestImported: null,
      })
    ).toBeNull();
  });

  it("computes covered span over total span", () => {
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 8)),
        newestImported,
      })
    ).toBeCloseTo(0.3, 10);
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 6)),
        newestImported,
      })
    ).toBeCloseTo(0.5, 10);
  });

  it("reports a real 0 — which is not the same answer as null", () => {
    // One play imported, nothing walked yet. The bar is determinate and empty;
    // a caller that treats this as "unknown" shows an indeterminate spinner for
    // a server whose progress is perfectly well known to be zero.
    const fraction = computeBackfillFraction({
      backfillComplete: false,
      oldestPlayAt,
      oldestImported: newestImported,
      newestImported,
    });
    expect(fraction).toBe(0);
    expect(fraction).not.toBeNull();
  });

  it("clamps a covered span longer than the total span to 1", () => {
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2025, 0, 1)),
        newestImported,
      })
    ).toBe(1);
  });

  it("measures how far the walk reached by its cursor when one is recorded", () => {
    // The cursor also counts stretches of history that could not be stored.
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 8)),
        newestImported,
        cursorAt: new Date(Date.UTC(2026, 0, 6)),
      })
    ).toBeCloseTo(0.5, 10);
  });

  it("reads a walk restarted by a purge as starting over, not as nearly done", () => {
    // `restartTracearrBackfill` moves the cursor to now, while the rows that
    // survived a partial purge still reach back to the far end.
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt,
        oldestImported: new Date(Date.UTC(2026, 0, 1, 1)),
        newestImported,
        cursorAt: new Date(Date.UTC(2026, 0, 12)),
      })
    ).toBe(0);
  });

  it("is null for a zero or negative span rather than Infinity or NaN", () => {
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt: newestImported,
        oldestImported: newestImported,
        newestImported,
      })
    ).toBeNull();
    expect(
      computeBackfillFraction({
        backfillComplete: false,
        oldestPlayAt: new Date(Date.UTC(2027, 0, 1)),
        oldestImported: new Date(Date.UTC(2026, 0, 8)),
        newestImported,
      })
    ).toBeNull();
  });
});

describe("importPending", () => {
  const base = {
    pausedReason: null,
    backfillComplete: false,
    importedCount: 0,
    oldestPlayAt: null,
    cursorAt: null,
    lastWalkAt: new Date(),
    running: false,
    queued: false,
  } as const;

  it("is pending for a mapping never walked or a slice running or waiting, not one walked with nothing to show", () => {
    expect(importPending({ ...base, lastWalkAt: null })).toBe(true);
    expect(importPending(base)).toBe(false);
    expect(importPending({ ...base, running: true })).toBe(true);
    expect(importPending({ ...base, queued: true })).toBe(true);
  });

  it("with the job table read, is pending only while a slice runs or waits", () => {
    // Nothing queued is then KNOWN — the evidence no longer stands in for it.
    const known = { ...base, jobsKnown: true } as const;
    expect(importPending({ ...known, lastWalkAt: null })).toBe(false);
    expect(importPending({ ...known, importedCount: 5, cursorAt: new Date() })).toBe(false);
    expect(importPending({ ...known, importedCount: 5, queued: true })).toBe(true);
    expect(importPending({ ...known, lastWalkAt: null, running: true })).toBe(true);
  });

  it("is never pending when paused for any reason, or complete", () => {
    for (const pausedReason of ["server-disabled", "instance-unavailable", "no-library-items", "import-failing", "awaiting-sync"] as const) {
      expect(importPending({ ...base, pausedReason, importedCount: 5, running: true, lastWalkAt: null })).toBe(false);
    }
    expect(importPending({ ...base, backfillComplete: true, queued: true })).toBe(false);
  });
});

describe("importAwaitingSync", () => {
  const owed = {
    backfillComplete: false,
    importedCount: 5,
    oldestPlayAt: null,
    cursorAt: new Date(),
    lastWalkAt: null,
    running: false,
    queued: false,
    parked: false,
    jobsKnown: true,
  } as const;

  it("is an owed import with nothing queued, running or parked", () => {
    expect(importAwaitingSync(owed)).toBe(true);
    // A never-walked mapping waits for the sync just the same.
    expect(importAwaitingSync({ ...owed, importedCount: 0, cursorAt: null })).toBe(true);
  });

  it("is not while anything is queued, running or parked, or once complete", () => {
    expect(importAwaitingSync({ ...owed, queued: true })).toBe(false);
    expect(importAwaitingSync({ ...owed, running: true })).toBe(false);
    expect(importAwaitingSync({ ...owed, parked: true })).toBe(false);
    expect(importAwaitingSync({ ...owed, backfillComplete: true })).toBe(false);
  });

  it("is not without a readable job table — no job is then unknown, not known", () => {
    expect(importAwaitingSync({ ...owed, jobsKnown: false })).toBe(false);
    expect(importAwaitingSync({ ...owed, jobsKnown: undefined })).toBe(false);
  });

  it("leaves the walked-and-empty end state alone, whether or not a restart left a cursor", () => {
    const walkedEmpty = { ...owed, importedCount: 0, lastWalkAt: new Date() };
    expect(importAwaitingSync({ ...walkedEmpty, cursorAt: null })).toBe(false);
    expect(importAwaitingSync(walkedEmpty)).toBe(false);
    // Rows or a measured far edge are history still to show.
    expect(importAwaitingSync({ ...walkedEmpty, importedCount: 3 })).toBe(true);
    expect(importAwaitingSync({ ...walkedEmpty, oldestPlayAt: new Date(0) })).toBe(true);
  });

  it("is, while a restart holds the walk, whatever is queued or running", () => {
    // A slice queued against the hold only no-ops; the full sync is next.
    const held = { ...owed, resyncRequiredAt: new Date() };
    expect(importAwaitingSync({ ...held, queued: true })).toBe(true);
    expect(importAwaitingSync({ ...held, running: true })).toBe(true);
    expect(importAwaitingSync({ ...held, jobsKnown: false })).toBe(true);
    expect(importAwaitingSync({ ...held, importedCount: 0, lastWalkAt: new Date() })).toBe(true);
    expect(importAwaitingSync({ ...held, backfillComplete: true })).toBe(false);
  });

  it("does not infer a hold from a cursor with no walk stamp", () => {
    // A first walk that errored after committing a page looks exactly so.
    expect(importAwaitingSync({ ...owed, lastWalkAt: null, resyncRequiredAt: null, queued: true })).toBe(false);
  });
});

describe("importPausedReason", () => {
  const owed = {
    backfillComplete: false,
    importedCount: 5,
    oldestPlayAt: null,
    cursorAt: new Date(),
    lastWalkAt: new Date(),
    resyncRequiredAt: null,
    running: false,
    queued: true,
    jobsKnown: true,
    serverEnabled: true,
    instanceEnabled: true,
    hasLibraryItems: true,
    failing: false,
  } as const;

  it("is null with a slice queued, else names the cause in the order it must be fixed", () => {
    expect(importPausedReason(owed)).toBeNull();
    // What nothing but the user can lift first.
    expect(importPausedReason({ ...owed, serverEnabled: false, resyncRequiredAt: new Date() })).toBe("server-disabled");
    expect(importPausedReason({ ...owed, instanceEnabled: false, hasLibraryItems: false })).toBe("instance-unavailable");
    // A hold before empty libraries: the releasing sync refills them.
    expect(importPausedReason({ ...owed, resyncRequiredAt: new Date(), hasLibraryItems: false })).toBe("awaiting-sync");
    // Empty libraries before a parked slice.
    expect(importPausedReason({ ...owed, hasLibraryItems: false, failing: true, queued: false })).toBe(
      "no-library-items",
    );
    expect(importPausedReason({ ...owed, failing: true, queued: false })).toBe("import-failing");
  });

  it("reports nothing about a completed backfill but a disabled server or instance", () => {
    const done = { ...owed, backfillComplete: true };
    expect(importPausedReason({ ...done, hasLibraryItems: false, resyncRequiredAt: new Date(), failing: true })).toBeNull();
    expect(importPausedReason({ ...done, serverEnabled: false })).toBe("server-disabled");
  });
});
