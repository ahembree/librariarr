import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
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
// The fraction arithmetic is a pure helper beside the route, so its edge cases
// are exercised directly as well as through the response shape.
import { computeBackfillFraction } from "@/app/api/integrations/tracearr/status/backfill-fraction";

interface StatusRow {
  serverId: string;
  serverName: string;
  tracearrServerId: string | null;
  backfillComplete: boolean;
  importedCount: number;
  oldestImported: string | null;
  newestImported: string | null;
  oldestPlayAt: string | null;
  backfillFraction: number | null;
}

const STATUS_URL = "/api/integrations/tracearr/status";

/**
 * Map a server to a Tracearr server id. `createTestServer` has no override for
 * the Tracearr columns, so the mapping is applied after creation rather than
 * reaching into the shared factory.
 */
async function mapToTracearr(
  serverId: string,
  tracearrServerId: string,
  opts: { backfillComplete?: boolean; oldestPlayAt?: Date | null } = {}
) {
  const prisma = getTestPrisma();
  return prisma.mediaServer.update({
    where: { id: serverId },
    data: {
      tracearrServerId,
      tracearrBackfillComplete: opts.backfillComplete ?? false,
      tracearrOldestPlayAt: opts.oldestPlayAt ?? null,
    },
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
      backfillFraction: null,
    });
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
