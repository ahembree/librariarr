/**
 * A FULL backup brings back its lifecycle matches and actions, and they are as
 * old as the backup: an item watched since it was taken still holds its match.
 *
 * The restore holds every server (`requireLibraryResync`), so detection skips
 * play-activity rule sets until the next full sync — but that hold lifts there,
 * and before this an execution that ran after the sync and before the next
 * detection (execution scheduled more often than detection, Settings "Run
 * now", `POST /api/v1/jobs/execution`, Execute on the Pending page) acted on
 * the backup's match of a movie watched since. The restore now latches every
 * rule set that reads play activity and that it brought matches back for
 * (`RuleSet.playHistoryPausedAt`), so its actions wait until detection has
 * evaluated it.
 *
 * Real Postgres, a real backup file, and the real sync engine, native history
 * sync, detection, executor and Execute route; only the media server is faked,
 * and the Arr call itself (`executeAction`).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestRuleSet,
} from "../../setup/test-helpers";

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-backup-"));
process.env.BACKUP_DIR = backupDir;

const m = vi.hoisted(() => ({
  libraries: [] as Array<{ key: string; title: string; type: string }>,
  listings: {} as Record<string, { items: Array<Record<string, unknown>>; total?: number | null }>,
  history: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => {
    const findItem = (ratingKey: string) =>
      Object.values(m.listings).flatMap((l) => l.items).find((i) => i.ratingKey === ratingKey);
    return {
      bulkListingIncomplete: false,
      supportsHistorySince: false,
      testConnection: vi.fn(async () => ({ ok: true, serverName: "Test Server" })),
      getLibraries: vi.fn(async () => m.libraries),
      getWatchCounts: vi.fn(async () => new Map()),
      getLibraryShows: vi.fn(async () => []),
      getLibraryItemsPage: vi.fn(async (key: string, _type: string, offset: number, limit: number) => {
        const listing = m.listings[key] ?? { items: [] };
        return {
          items: listing.items.slice(offset, offset + limit).map((i) => ({ ...i })),
          total: listing.total === undefined ? listing.items.length : listing.total,
        };
      }),
      getItemMetadata: vi.fn(async (ratingKey: string) => ({ ...findItem(ratingKey) })),
      getDetailedWatchHistory: vi.fn((...args: unknown[]) => m.history(...args)),
    };
  }),
}));
vi.mock("@/lib/jobs/client", () => ({ enqueueJob: m.enqueueJob, isJobRetrying: vi.fn(async () => false) }));
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));
vi.mock("@/lib/dedup/recompute-canonical", () => ({ recomputeCanonical: vi.fn(async () => {}) }));
vi.mock("@/lib/image-cache/image-cache", () => ({
  invalidateCachedUrls: vi.fn(),
  normalizeCacheUrl: (u: string | null) => u ?? "",
}));
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
  buildSuccessSummaryEmbed: vi.fn(),
  buildFailureSummaryEmbed: vi.fn(),
  buildMatchChangeEmbed: vi.fn(),
  buildMaintenanceEmbed: vi.fn(),
  buildApiKeyEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));
// The Arr call itself is beside the point; what matters is whether it is made.
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/actions")>();
  return { ...actual, executeAction: vi.fn().mockResolvedValue(undefined) };
});

// After BACKUP_DIR is set: the service reads it when it loads.
const { createBackup, restoreBackup } = await import("@/lib/backup/backup-service");
const { syncMediaServer } = await import("@/lib/sync/sync-server");
const { processLifecycleRules, executeLifecycleActions } = await import("@/lib/lifecycle/processor");
const { checkWatchHistoryCompleteness } = await import("@/lib/lifecycle/evaluability");
const { executeAction } = await import("@/lib/lifecycle/actions");
const { POST: executePost } = await import("@/app/api/lifecycle/actions/execute/route");

const prisma = getTestPrisma();
const movie = (ratingKey: string) => ({ ratingKey, title: `Movie ${ratingKey}`, type: "movie" });
const play = (ratingKey: string, username = "alice") => ({
  ratingKey,
  username,
  watchedAt: "2026-09-30T20:00:00.000Z",
  deviceName: null,
  platform: null,
});
const rule = (field: string, operator: string, value: unknown) => [
  { id: "g1", condition: "AND", rules: [{ id: "r1", field, operator, value, condition: "AND" }], groups: [] },
];
const NEVER_PLAYED = rule("playCount", "equals", 0);
const BY_TITLE = rule("title", "contains", "Movie");

let userId: string;
let serverId: string;
let ruleSetId: string;

const itemId = async (ratingKey: string) => (await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey } })).id;
const statusOf = async (ratingKey: string, rs = ruleSetId) =>
  (await prisma.lifecycleAction.findFirst({ where: { ruleSetId: rs, mediaItemId: await itemId(ratingKey) } }))?.status ??
  "none";
const pausedAt = async (id: string) =>
  (await prisma.ruleSet.findUniqueOrThrow({ where: { id }, select: { playHistoryPausedAt: true } })).playHistoryPausedAt;

/** The backup's m1 is watched after it was taken: restore, then the full sync the docs advise. */
async function restoreThenSync(configOnly = false) {
  const file = await createBackup(undefined, configOnly);
  m.history.mockResolvedValue([play("m1")]);
  const before = Date.now();
  await restoreBackup(file);
  await syncMediaServer(serverId, undefined, { trigger: "test: full sync after restore" });
  await expect(checkWatchHistoryCompleteness(userId, [serverId])).resolves.toEqual({ complete: true });
  return before;
}

describe("restoring a full backup brings back its matches and actions, held until detection", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    m.enqueueJob.mockResolvedValue(true);
    m.history.mockResolvedValue([]);
    const user = await createTestUser();
    userId = user.id;
    const server = await createTestServer(user.id, { type: "JELLYFIN", watchHistorySyncedAt: null });
    serverId = server.id;
    await createTestLibrary(server.id, { key: "1", title: "Movies", type: "MOVIE" });
    m.libraries = [{ key: "1", title: "Movies", type: "movie" }];
    m.listings = { "1": { items: [movie("m1"), movie("m2")] } };
    await syncMediaServer(serverId, undefined, { trigger: "test: first sync" });
    await prisma.mediaItem.updateMany({ data: { createdAt: new Date("2025-01-01T00:00:00.000Z") } });
    const rs = await createTestRuleSet(user.id, {
      name: "Never played",
      type: "MOVIE",
      rules: NEVER_PLAYED,
      serverIds: [serverId],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 0,
    });
    ruleSetId = rs.id;
    await processLifecycleRules(userId);
    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");
    expect(await pausedAt(ruleSetId)).toBeNull();
  });

  afterAll(async () => {
    await disconnectTestDb();
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("control: detection before execution drops the movie watched since the backup", async () => {
    await restoreThenSync();
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();

    await executeLifecycleActions(userId);

    expect(await statusOf("m1")).toBe("none");
    expect(await statusOf("m2")).toBe("COMPLETED");
  });

  it("an execution after the sync and before detection holds the restored actions", async () => {
    const before = await restoreThenSync();
    expect((await prisma.mediaItem.findFirstOrThrow({ where: { ratingKey: "m1" } })).playCount).toBe(1);
    const latch = await pausedAt(ruleSetId);
    expect(latch).toBeInstanceOf(Date);
    expect(latch!.getTime()).toBeGreaterThanOrEqual(before - 5);

    await executeLifecycleActions(userId);

    expect(executeAction).not.toHaveBeenCalled();
    expect(await statusOf("m1")).toBe("PENDING");
    expect(await statusOf("m2")).toBe("PENDING");

    // Detection evaluates the rule set: the watched m1 drops out, m2 runs.
    await processLifecycleRules(userId);
    expect(await pausedAt(ruleSetId)).toBeNull();
    await executeLifecycleActions(userId);
    expect(await statusOf("m1")).toBe("none");
    expect(await statusOf("m2")).toBe("COMPLETED");
  });

  it("Execute answers 409 on the restored matches until detection has evaluated the rule set", async () => {
    await restoreThenSync();
    setMockSession({ isLoggedIn: true, userId });
    const execute = (ratingKey: string) =>
      itemId(ratingKey).then((id) =>
        callRoute(executePost, {
          url: "/api/lifecycle/actions/execute",
          method: "POST",
          body: { ruleSetId, mediaItemIds: [id] },
        }),
      );

    const refused = await expectJson<{ error: string }>(await execute("m1"), 409);
    expect(refused.error).toMatch(/a backup restore brought the matches back/);
    expect(executeAction).not.toHaveBeenCalled();

    await processLifecycleRules(userId);
    await expectJson<{ executed: number }>(await execute("m2"), 200);
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("latches only the play-activity rule sets it brought matches back for; one reading no play activity runs", async () => {
    // A second rule set reading no play activity, with its own matches and
    // actions, and a third with neither.
    const byTitle = await createTestRuleSet(userId, {
      name: "By title",
      type: "MOVIE",
      rules: BY_TITLE,
      serverIds: [serverId],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 0,
    });
    const empty = await createTestRuleSet(userId, {
      name: "Nothing yet",
      type: "MOVIE",
      rules: NEVER_PLAYED,
      serverIds: [serverId],
      enabled: false,
    });
    await processLifecycleRules(userId);
    expect(await statusOf("m1", byTitle.id)).toBe("PENDING");

    await restoreThenSync();

    expect(await pausedAt(ruleSetId)).toBeInstanceOf(Date);
    // Not latched: the latch would hold nothing there, and detection lifting
    // it would announce a hold that never was.
    expect(await pausedAt(byTitle.id)).toBeNull();
    expect(await pausedAt(empty.id)).toBeNull();
    await executeLifecycleActions(userId);
    expect(await statusOf("m1", byTitle.id)).toBe("COMPLETED");
    expect(await statusOf("m1")).toBe("PENDING");
  });

  it("a config-only restore brings back no matches, so it latches nothing", async () => {
    await restoreThenSync(true);

    expect(await prisma.ruleMatch.count()).toBe(0);
    expect(await prisma.lifecycleAction.count()).toBe(0);
    expect(await pausedAt(ruleSetId)).toBeNull();
  });
});
