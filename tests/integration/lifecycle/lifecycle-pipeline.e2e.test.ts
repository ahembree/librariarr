/**
 * End-to-end lifecycle pipeline: detection → action scheduling → execution,
 * driven through the real processor against the test database.
 *
 * Uses the DO_NOTHING action so the full chain (detect-matches → processor →
 * actions) runs without any external Arr/Plex calls. A second scenario covers
 * incremental stale-match removal + pending-action cancellation when an item
 * stops matching.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
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

// Never reach out to Discord or Plex during the pipeline.
vi.mock("@/lib/discord/client", () => ({
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
  buildSuccessSummaryEmbed: vi.fn(),
  buildFailureSummaryEmbed: vi.fn(),
  buildMatchChangeEmbed: vi.fn(),
  buildMaintenanceEmbed: vi.fn(),
}));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn().mockResolvedValue(undefined),
  syncCollectionById: vi.fn().mockResolvedValue(undefined),
  syncAllCollections: vi.fn().mockResolvedValue(undefined),
  removeItemFromCollections: vi.fn().mockResolvedValue(undefined),
  removePlexCollection: vi.fn().mockResolvedValue(undefined),
  renameCollectionInPlex: vi.fn().mockResolvedValue(undefined),
}));

import { processLifecycleRules, executeLifecycleActions } from "@/lib/lifecycle/processor";

const MATCH_RULE = [
  {
    id: "g1",
    condition: "AND",
    rules: [{ id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" }],
    groups: [],
  },
];

describe("lifecycle pipeline (e2e)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("detects matches, schedules a DO_NOTHING action, and executes it", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const matched = await createTestMediaItem(library.id, { title: "Unwatched", type: "MOVIE", playCount: 0 });
    await createTestMediaItem(library.id, { title: "Watched", type: "MOVIE", playCount: 5 });

    const ruleSet = await createTestRuleSet(user.id, {
      name: "Unwatched movies",
      type: "MOVIE",
      rules: MATCH_RULE,
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 0,
    });

    // --- Detection + scheduling ---
    await processLifecycleRules(user.id);

    const matches = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0].mediaItemId).toBe(matched.id);

    const pending = await prisma.lifecycleAction.findMany({ where: { ruleSetId: ruleSet.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("PENDING");
    expect(pending[0].actionType).toBe("DO_NOTHING");
    expect(pending[0].mediaItemId).toBe(matched.id);

    // --- Execution (actionDelayDays 0 → scheduledFor is already due) ---
    await executeLifecycleActions(user.id);

    const executed = await prisma.lifecycleAction.findUnique({ where: { id: pending[0].id } });
    expect(executed?.status).toBe("COMPLETED");
    expect(executed?.executedAt).not.toBeNull();
  });

  it("removes stale matches and cancels their pending actions on re-detection", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Flips", type: "MOVIE", playCount: 0 });

    const ruleSet = await createTestRuleSet(user.id, {
      name: "Unwatched",
      type: "MOVIE",
      rules: MATCH_RULE,
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DO_NOTHING",
      actionDelayDays: 7, // future-dated so it stays PENDING
    });

    await processLifecycleRules(user.id);
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(1);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(1);

    // The item is now watched → no longer matches. Re-run detection.
    await prisma.mediaItem.update({ where: { id: item.id }, data: { playCount: 3 } });
    await processLifecycleRules(user.id);

    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(0);
  });

  it("never floods matches for a foundInArr rule when no enabled Radarr instance exists (match-all guard)", async () => {
    // With zero enabled Radarr instances, "foundInArr = false" would be
    // vacuously true for the ENTIRE movie library — one detection cycle would
    // persist a match and schedule a DELETE for every item. The pipeline must
    // skip the rule set instead, writing nothing.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { title: "Movie A", type: "MOVIE", playCount: 0 });
    await createTestMediaItem(library.id, { title: "Movie B", type: "MOVIE", playCount: 5 });

    const ruleSet = await createTestRuleSet(user.id, {
      name: "Orphan purge",
      type: "MOVIE",
      rules: [
        {
          id: "g1",
          condition: "AND",
          rules: [{ id: "r1", field: "foundInArr", operator: "equals", value: "false", condition: "AND" }],
          groups: [],
        },
      ],
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DELETE_RADARR",
      arrInstanceId: "radarr-gone",
      actionDelayDays: 0,
    });

    await processLifecycleRules(user.id);

    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
  });

  it("disarms a pre-existing vacuous flood when a MUSIC+Seerr rule set becomes permanently unevaluable", async () => {
    // Simulates the upgrade scenario: before Seerr fields were gated off MUSIC,
    // such a rule set vacuously matched every artist and armed destructive
    // actions. Detection must not just skip it — it must clear the stale
    // matches and cancel the armed actions so they can never fire.
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MUSIC" });
    const track = await createTestMediaItem(library.id, { title: "Track", type: "MUSIC", parentTitle: "Artist" });

    const ruleSet = await createTestRuleSet(user.id, {
      name: "Legacy music seerr",
      type: "MUSIC",
      rules: [
        {
          id: "g1",
          condition: "AND",
          rules: [{ id: "r1", field: "seerrRequested", operator: "equals", value: "false", condition: "AND" }],
          groups: [],
        },
      ],
      serverIds: [server.id],
      actionEnabled: true,
      actionType: "DELETE_LIDARR",
      arrInstanceId: "lidarr-1",
      actionDelayDays: 0,
    });

    // Pre-armed vacuous state from before the guard existed
    await prisma.ruleMatch.create({
      data: { ruleSetId: ruleSet.id, mediaItemId: track.id, itemData: { id: track.id, title: "Artist" } },
    });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: track.id,
        ruleSetId: ruleSet.id,
        actionType: "DELETE_LIDARR",
        status: "PENDING",
        scheduledFor: new Date(Date.now() - 1000), // already due
      },
    });

    await processLifecycleRules(user.id);

    // The flood is disarmed, not frozen
    expect(await prisma.ruleMatch.count({ where: { ruleSetId: ruleSet.id } })).toBe(0);
    expect(await prisma.lifecycleAction.count({ where: { ruleSetId: ruleSet.id, status: "PENDING" } })).toBe(0);
  });
});
