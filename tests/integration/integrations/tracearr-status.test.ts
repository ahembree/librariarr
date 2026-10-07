import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
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

// Import route handler AFTER mocks
import { GET } from "@/app/api/integrations/tracearr/status/route";
// The saves that fix what an import waits on, driven for real so the slice
// they queue lands in the real job table the status route reads.
import { PUT as PUT_SERVER } from "@/app/api/servers/[id]/route";
import { PUT as PUT_INSTANCE } from "@/app/api/integrations/tracearr/[id]/route";
import { releaseJobsClient } from "@/lib/jobs/client";
import { releaseTracearrRestartHold, restartTracearrBackfill } from "@/lib/media/watch-evidence";
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
  supersedeTracearrImports,
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
 * Also gives the server an item in an enabled library unless it already has
 * one (or `withoutItems`): the importer walks nothing into an empty server,
 * and the status reports that as `no-library-items` — a state of its own,
 * exercised on purpose below, not the default every other case sits in.
 */
async function mapToTracearr(
  serverId: string,
  tracearrServerId: string,
  opts: { backfillComplete?: boolean; oldestPlayAt?: Date | null; withoutItems?: boolean } = {}
) {
  const prisma = getTestPrisma();
  if (!opts.withoutItems) {
    const populated = await prisma.mediaItem.count({
      where: { library: { mediaServerId: serverId, enabled: true } },
    });
    if (populated === 0) await createItemFor(serverId, `Seed ${tracearrServerId.slice(-4)}`);
  }
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

// Whether the job table can be read changes what `pending` is judged on (see
// `importPending`), and an earlier test file may have left a graphile schema
// behind. Every test outside the "job on the queue" block runs without one.
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
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  const read = async () =>
    (await expectJson<{ servers: StatusRow[] }>(await callRoute(GET, { url: STATUS_URL }))).servers;

  /** A mapped, enabled server with one imported play and its far edge measured. */
  async function walkingServer(userId: string, name: string, tracearrServerId: string) {
    const server = await createTestServer(userId, { name });
    await mapToTracearr(server.id, tracearrServerId, { oldestPlayAt: new Date(Date.UTC(2026, 0, 1)) });
    const item = await createItemFor(server.id, `${name} item`);
    for (const [i, watchedAt] of [new Date(Date.UTC(2026, 0, 8)), new Date(Date.UTC(2026, 0, 11))].entries()) {
      await createWatchRow({ mediaItemId: item.id, mediaServerId: server.id, watchedAt, sourceEventId: `${name}-${i}` });
    }
    return server;
  }

  it("is pending while an owed import has history to walk", async () => {
    const user = await createTestUser();
    await createInstance(user.id);
    await walkingServer(user.id, "Walking", "a0000000-0000-4000-8000-000000000001");
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const [row] = await read();
    expect(row.pending).toBe(true);
    expect(row.pausedReason).toBeNull();
    expect(row.backfillComplete).toBe(false);
  });

  it("is not pending once the backfill is complete", async () => {
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Done", "a0000000-0000-4000-8000-000000000002");
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillComplete: true },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    expect((await read())[0].pending).toBe(false);
  });

  it("lists a disabled server as paused, never pending, while backfillComplete stays as stored", async () => {
    // No sync runs for a disabled server, so a pending import there was a
    // spinner and a 30-second poll that never ended.
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Disabled", "a0000000-0000-4000-8000-000000000003");
    await getTestPrisma().mediaServer.update({ where: { id: server.id }, data: { enabled: false } });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const [row] = await read();
    expect(row.serverId).toBe(server.id);
    expect(row.backfillComplete).toBe(false);
    expect(row.pending).toBe(false);
    expect(row.pausedReason).toBe("server-disabled");
  });

  it("is paused when no Tracearr instance is enabled", async () => {
    const user = await createTestUser();
    await createInstance(user.id, false);
    await walkingServer(user.id, "Orphaned", "a0000000-0000-4000-8000-000000000004");
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const [row] = await read();
    expect(row.pending).toBe(false);
    expect(row.pausedReason).toBe("instance-unavailable");
  });

  it("is pending for a fresh mapping no walk has run for yet, with nothing queued", async () => {
    // The gap between saving a mapping and its first sync queueing a slice.
    // Reported as not pending, Settings read "Tracearr has no plays for this
    // server — check the mapping" — and with the event stream down, it stayed
    // on that for the whole multi-hour import.
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await createTestServer(user.id, { name: "Fresh" });
    await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000012");
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const [row] = await read();
    expect(row.importedCount).toBe(0);
    expect(row.lastWalkAt).toBeNull();
    expect(row.pending).toBe(true);
    expect(row.pausedReason).toBeNull();
  });

  it("is not pending for a mapping a walk ran for and found no history", async () => {
    // Tracearr holds no plays for it: the walk comes back exhausted and empty,
    // the backfill deliberately stays incomplete and the slice is not
    // re-enqueued — nothing will ever progress, so nothing may wait on it.
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await createTestServer(user.id, { name: "Empty" });
    await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000005");
    const walkedAt = new Date(Date.UTC(2026, 5, 1));
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillLastWalkAt: walkedAt },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const [row] = await read();
    expect(row.backfillComplete).toBe(false);
    expect(row.importedCount).toBe(0);
    expect(row.lastWalkAt).toBe(walkedAt.toISOString());
    expect(row.pending).toBe(false);
    expect(row.pausedReason).toBeNull();

    // A run in progress is the evidence it was missing.
    const run = beginTracearrImport(server.id, user.id);
    try {
      expect((await read())[0].pending).toBe(true);
    } finally {
      endTracearrImport(run);
    }
  });

  // Without a readable job table (none in this block) the stored evidence
  // stands in for the queue; with one, these read `awaiting-sync` (below).
  it("is pending with no rows yet once the far edge is measured or the walk restarted", async () => {
    const user = await createTestUser();
    await createInstance(user.id);
    const measured = await createTestServer(user.id, { name: "A measured" });
    await mapToTracearr(measured.id, "a0000000-0000-4000-8000-000000000006", {
      oldestPlayAt: new Date(Date.UTC(2020, 0, 1)),
    });
    const restarted = await createTestServer(user.id, { name: "B restarted" });
    await mapToTracearr(restarted.id, "a0000000-0000-4000-8000-000000000007");
    await getTestPrisma().mediaServer.update({
      where: { id: restarted.id },
      data: { tracearrBackfillCursorAt: new Date() },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    expect((await read()).map((row) => row.pending)).toEqual([true, true]);
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

    it("is pending while a slice waits on the queue, even after an empty walk", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Queued" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000008");
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillLastWalkAt: new Date() },
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      expect((await read())[0].pending).toBe(false);

      await queueBackfill(server.id);
      expect((await read())[0].pending).toBe(true);
    });

    it("reports a parked slice as failing — never pending, even with plays imported", async () => {
      // An instance that no longer monitors the mapping, an account list that
      // cannot be read: every slice fails, the job uses up its attempts and is
      // parked. Imported rows used to be enough to read "pending", so this
      // showed "importing" and was polled forever.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Failing", "a0000000-0000-4000-8000-000000000013");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);
      await park(server.id);

      const [row] = await read();
      expect(row.importedCount).toBe(2);
      expect(row.pending).toBe(false);
      expect(row.pausedReason).toBe("import-failing");

      // A run in progress (a Refresh, a slice re-queued since) is progress.
      const run = beginTracearrImport(server.id, user.id);
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

    it("is failing for a never-walked mapping whose every slice failed", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Never" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000014");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);
      await park(server.id);

      const [row] = await read();
      expect(row.lastWalkAt).toBeNull();
      expect(row.pending).toBe(false);
      expect(row.pausedReason).toBe("import-failing");
    });

    it("does not read a slice running its last attempt as parked", async () => {
      // graphile counts the attempt when it takes the job, so the final try
      // reads attempts = max while it is still running.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Last try", "a0000000-0000-4000-8000-000000000015");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
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

    const putServer = (serverId: string, body: Record<string, unknown>) =>
      callRouteWithParams(PUT_SERVER, { id: serverId }, { url: `/api/servers/${serverId}`, method: "PUT", body });
    const putInstance = (id: string, body: Record<string, unknown>) =>
      callRouteWithParams(PUT_INSTANCE, { id }, {
        url: `/api/integrations/tracearr/${id}`,
        method: "PUT",
        body,
      });

    it("stops reading failing once a re-enabled Tracearr instance re-queues the slice", async () => {
      // The instance went away (or pointed at the wrong place), every slice
      // failed and the job parked. Re-enabling it is the fix — and used to
      // leave "History import failing" up until the next watch-history sync.
      const user = await createTestUser();
      const instance = await createInstance(user.id);
      const server = await walkingServer(user.id, "Parked", "a0000000-0000-4000-8000-000000000017");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);
      await park(server.id);
      expect((await read())[0].pausedReason).toBe("import-failing");

      await expectJson(await putInstance(instance.id, { enabled: false }), 200);
      expect((await read())[0].pausedReason).toBe("instance-unavailable");

      await expectJson(await putInstance(instance.id, { enabled: true }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("queues a fresh mapping's first slice on save, so it reads pending", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Fresh" });
      await createItemFor(server.id, "Fresh item");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

    it("replaces a slice parked by the OLD mapping when the mapping changes", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Re-pointed", "a0000000-0000-4000-8000-000000000019");
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);
      await park(server.id);
      expect((await read())[0].pausedReason).toBe("import-failing");

      await expectJson(await putServer(server.id, { tracearrServerId: "a0000000-0000-4000-8000-000000000020" }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("queues the slice of a server re-enabled while its import was owed", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Back", "a0000000-0000-4000-8000-000000000021");
      await getTestPrisma().mediaServer.update({ where: { id: server.id }, data: { enabled: false } });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      expect((await read())[0].pausedReason).toBe("server-disabled");

      await expectJson(await putServer(server.id, { enabled: true }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("reports an owed import with nothing queued as awaiting a sync — never pending", async () => {
      // After a purge or restore the walk must follow the re-sync, so nothing
      // queues it early. It used to read "Still importing…" beside a spinner
      // and be polled with nothing queued.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Purged", "a0000000-0000-4000-8000-000000000022");
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillLastWalkAt: new Date() },
      });
      await restartTracearrBackfill([server.id]);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const [row] = await read();
      expect(row.pausedReason).toBe("awaiting-sync");
      expect(row.pending).toBe(false);

      // Re-enabling the instance must not start it ahead of the re-sync either.
      const [instance] = await getTestPrisma().tracearrInstance.findMany({ where: { userId: user.id } });
      await expectJson(await putInstance(instance.id, { enabled: false }), 200);
      await expectJson(await putInstance(instance.id, { enabled: true }), 200);
      expect((await read())[0].pausedReason).toBe("awaiting-sync");

      // A slice queued meanwhile (a watch-changed's forward sync queues one)
      // only no-ops against the hold — still waiting, still not pending.
      await queueBackfill(server.id);
      const [heldQueued] = await read();
      expect(heldQueued.pausedReason).toBe("awaiting-sync");
      expect(heldQueued.pending).toBe(false);

      // The full sync that releases the hold leaves the queued slice to run.
      await releaseTracearrRestartHold(server.id, new Date());
      const [released] = await read();
      expect(released.pausedReason).toBeNull();
      expect(released.pending).toBe(true);
    });

    it("does not hold a first walk that errored after a committed page", async () => {
      // A cursor and no walk stamp — the shape the hold used to be inferred
      // from — with its retry queued: pending, not awaiting a sync.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Errored", "a0000000-0000-4000-8000-000000000025");
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillCursorAt: new Date(Date.UTC(2026, 8, 1)), tracearrBackfillLastWalkAt: null },
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);

      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(true);
    });

    it("reports a mapping on a server with no items yet as waiting for library items", async () => {
      // The importer refuses to walk into an empty library, so the save queues
      // nothing; the watch-history step of a sync that adds items does.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Unsynced" });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      await expectJson(await putServer(server.id, { tracearrServerId: "a0000000-0000-4000-8000-000000000023" }), 200);
      const [row] = await read();
      expect(row.pausedReason).toBe("no-library-items");
      expect(row.pending).toBe(false);
    });

    it("reports no-library-items when every library holding items is disabled — even with a slice queued", async () => {
      // No sync adds items to a disabled library, so "starts with the next
      // sync" would be untrue; a queued slice only no-ops against the gate.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "All disabled" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000026");
      await getTestPrisma().library.updateMany({ where: { mediaServerId: server.id }, data: { enabled: false } });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
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

    it("reports a restart that emptied the libraries as awaiting a sync — the sync refills them", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Purged all" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000027", { withoutItems: true });
      await createTestLibrary(server.id, { title: "Emptied" });
      await restartTracearrBackfill([server.id]);
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const [row] = await read();
      expect(row.pausedReason).toBe("awaiting-sync");
      expect(row.pending).toBe(false);
    });

    it("does not report no-library-items for a completed backfill", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Done, emptied" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000028", {
        backfillComplete: true,
        withoutItems: true,
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      expect((await read())[0].pausedReason).toBeNull();
    });

    it("keeps a walked-and-empty mapping out of awaiting-sync", async () => {
      // A walk ran and found nothing — "No plays imported", its own state.
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await createTestServer(user.id, { name: "Empty walk" });
      await mapToTracearr(server.id, "a0000000-0000-4000-8000-000000000024");
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillLastWalkAt: new Date() },
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

      const [row] = await read();
      expect(row.pausedReason).toBeNull();
      expect(row.pending).toBe(false);
    });

    it("does not report a completed backfill as failing", async () => {
      const user = await createTestUser();
      await createInstance(user.id);
      const server = await walkingServer(user.id, "Complete", "a0000000-0000-4000-8000-000000000016");
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillComplete: true },
      });
      setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
      await queueBackfill(server.id);
      await park(server.id);

      const [row] = await read();
      expect(row.pending).toBe(false);
      expect(row.pausedReason).toBeNull();
    });
  });

  it("measures the bar from a live backfill run that is further back than the stored reach", async () => {
    // The cursor is written once per five-minute slice; between writes the
    // bar stood still while the walk paged on.
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Live", "a0000000-0000-4000-8000-000000000009");
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    expect((await read())[0].backfillFraction).toBeCloseTo(0.3, 10);

    const run = beginTracearrImport(server.id, user.id);
    try {
      recordTracearrImportPage(run, {
        pass: "backfill",
        pages: 40,
        imported: 0,
        oldestReached: new Date(Date.UTC(2026, 0, 6)),
      });
      const [row] = await read();
      expect(row.backfillFraction).toBeCloseTo(0.5, 10);
      expect(row.reachedAt).toBe(new Date(Date.UTC(2026, 0, 6)).toISOString());
    } finally {
      endTracearrImport(run);
    }
  });

  it("ignores a live forward pass's reach — the newest hour says nothing about the archive", async () => {
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Forward", "a0000000-0000-4000-8000-000000000010");
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const run = beginTracearrImport(server.id, user.id);
    try {
      recordTracearrImportPage(run, {
        pass: "forward",
        pages: 1,
        imported: 3,
        oldestReached: new Date(Date.UTC(2025, 0, 1)),
      });
      const [row] = await read();
      expect(row.backfillFraction).toBeCloseTo(0.3, 10);
      expect(row.reachedAt).toBe(new Date(Date.UTC(2026, 0, 8)).toISOString());
    } finally {
      endTracearrImport(run);
    }
  });

  it("ignores the live reach of a run superseded by a restart or a mapping change", async () => {
    // That run is still paging the OLD archive position; its deep reach would
    // beat the cursor the restart just moved to now ("older wins").
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Superseded", "a0000000-0000-4000-8000-000000000017");
    const restartedAt = new Date(Date.UTC(2026, 0, 12));
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const run = beginTracearrImport(server.id, user.id);
    try {
      recordTracearrImportPage(run, {
        pass: "backfill",
        pages: 40,
        imported: 0,
        oldestReached: new Date(Date.UTC(2026, 0, 2)),
      });
      await getTestPrisma().mediaServer.update({
        where: { id: server.id },
        data: { tracearrBackfillCursorAt: restartedAt },
      });
      supersedeTracearrImports(server.id);

      const [row] = await read();
      expect(row.reachedAt).toBe(restartedAt.toISOString());
      expect(row.backfillFraction).toBe(0);
    } finally {
      endTracearrImport(run);
    }
  });

  it("reports the reach the fraction is measured from, not the oldest surviving row, after a purge restart", async () => {
    // `restartTracearrBackfill` moves the cursor to now; rows that survived the
    // purge still reach the far end. The line read "0% … reached 2019".
    const user = await createTestUser();
    await createInstance(user.id);
    const server = await walkingServer(user.id, "Restarted", "a0000000-0000-4000-8000-000000000011");
    const restartedAt = new Date(Date.UTC(2026, 0, 12));
    await getTestPrisma().mediaServer.update({
      where: { id: server.id },
      data: { tracearrBackfillCursorAt: restartedAt },
    });
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

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

  it("is pending for a mapping never walked, and not for one walked with nothing to show", () => {
    expect(importPending({ ...base, lastWalkAt: null })).toBe(true);
    expect(importPending(base)).toBe(false);
  });

  it("is pending while a slice runs or waits", () => {
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
    // A never-walked mapping with nothing queued (an enqueue that failed, an
    // unsynced server) waits for the sync just the same.
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

  it("leaves the walked-and-empty end state alone", () => {
    expect(
      importAwaitingSync({ ...owed, importedCount: 0, cursorAt: null, lastWalkAt: new Date() }),
    ).toBe(false);
  });

  it("is, while a restart holds the walk, whatever is queued or running", () => {
    // A slice queued against the hold only no-ops; the full sync is next.
    const held = { ...owed, restartedAt: new Date() };
    expect(importAwaitingSync({ ...held, queued: true })).toBe(true);
    expect(importAwaitingSync({ ...held, running: true })).toBe(true);
    expect(importAwaitingSync({ ...held, jobsKnown: false })).toBe(true);
    expect(importAwaitingSync({ ...held, backfillComplete: true })).toBe(false);
  });

  it("does not infer a hold from a cursor with no walk stamp", () => {
    // A first walk that errored after committing a page looks exactly so.
    expect(importAwaitingSync({ ...owed, lastWalkAt: null, restartedAt: null, queued: true })).toBe(false);
  });
});

describe("importPausedReason", () => {
  const owed = {
    backfillComplete: false,
    importedCount: 5,
    oldestPlayAt: null,
    cursorAt: new Date(),
    lastWalkAt: new Date(),
    restartedAt: null,
    running: false,
    queued: true,
    jobsKnown: true,
    serverEnabled: true,
    instanceEnabled: true,
    hasLibraryItems: true,
    failing: false,
  } as const;

  it("is null for an import with a slice queued", () => {
    expect(importPausedReason(owed)).toBeNull();
  });

  it("puts what nothing but the user can lift first", () => {
    expect(importPausedReason({ ...owed, serverEnabled: false, restartedAt: new Date() })).toBe("server-disabled");
    expect(importPausedReason({ ...owed, instanceEnabled: false, hasLibraryItems: false })).toBe("instance-unavailable");
  });

  it("puts a restart hold before empty libraries — the releasing sync refills them", () => {
    expect(importPausedReason({ ...owed, restartedAt: new Date(), hasLibraryItems: false })).toBe("awaiting-sync");
  });

  it("puts empty libraries before a parked slice", () => {
    expect(importPausedReason({ ...owed, hasLibraryItems: false, failing: true, queued: false })).toBe(
      "no-library-items",
    );
    expect(importPausedReason({ ...owed, failing: true, queued: false })).toBe("import-failing");
  });

  it("reports nothing about a completed backfill but a disabled server or instance", () => {
    const done = { ...owed, backfillComplete: true };
    expect(importPausedReason({ ...done, hasLibraryItems: false, restartedAt: new Date(), failing: true })).toBeNull();
    expect(importPausedReason({ ...done, serverEnabled: false })).toBe("server-disabled");
  });
});
