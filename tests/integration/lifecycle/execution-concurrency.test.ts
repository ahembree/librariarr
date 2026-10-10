/**
 * The scheduled executor against work that changes under it.
 *
 * `executeLifecycleActions` loads its due actions once, then runs them one by
 * one — minutes, on a slow Arr app. Meanwhile the Pending page or the public
 * API can run the same match inline (`POST /api/lifecycle/actions/execute`,
 * which deletes the PENDING row when it finishes), and the user can cancel the
 * action, file an exception or edit the rule set, each of which deletes it.
 * The executor acted on its loaded copy anyway — a second delete, or one the
 * user had just cancelled — and its write to the vanished row threw P2025 from
 * inside its catch, aborting the whole run.
 *
 * `executeAction` is mocked: a call to it is the request reaching the Arr app.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestExternalId,
  createTestRuleMatch,
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

const { mockExecuteAction, mockSyncMediaServer } = vi.hoisted(() => ({
  mockExecuteAction: vi.fn(),
  mockSyncMediaServer: vi.fn(),
}));

vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: mockExecuteAction,
}));
vi.mock("@/lib/discord/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord/client")>()),
  sendDiscordNotification: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/sync/sync-server", () => ({ syncMediaServer: mockSyncMediaServer }));
vi.mock("@/lib/lifecycle/collections", () => ({
  syncCollection: vi.fn(),
  syncCollectionById: vi.fn(),
  syncAllCollections: vi.fn(),
  removeItemFromCollections: vi.fn(),
}));

import { executeLifecycleActions } from "@/lib/lifecycle/processor";
import {
  tryBeginExecute,
  endExecute,
  _resetExecuteInFlightForTesting,
} from "@/lib/lifecycle/execute-in-flight";
import { reserveApiDestructive, resetApiDestructiveBudget } from "@/lib/api-keys/destructive-budget";
import { API_DESTRUCTIVE_PER_HOUR } from "@/lib/api-keys/limits";

const prisma = getTestPrisma();

type ActionArg = { id: string; mediaItem: { id: string } };

/** Two movies with due DELETE_RADARR actions, matched by one rule set. */
async function dueDeletes(count = 2) {
  const user = await createTestUser();
  await prisma.appSettings.create({ data: { userId: user.id } });
  const server = await createTestServer(user.id);
  const library = await createTestLibrary(server.id, { type: "MOVIE" });
  const ruleSet = await createTestRuleSet(user.id, {
    type: "MOVIE",
    actionEnabled: true,
    actionType: "DELETE_RADARR",
    arrInstanceId: "radarr-1",
  });
  const items = [];
  for (let i = 0; i < count; i++) {
    const tmdb = String(20_000 + i);
    const item = await createTestMediaItem(library.id, { title: `Movie ${i}`, year: 2001, type: "MOVIE" });
    await createTestExternalId(item.id, "TMDB", tmdb);
    await createTestRuleMatch(ruleSet.id, item.id, {
      id: item.id,
      title: item.title,
      parentTitle: null,
      year: item.year,
      externalIds: [{ source: "TMDB", externalId: tmdb }],
    });
    items.push(item);
  }
  await prisma.lifecycleAction.createMany({
    data: items.map((item) => ({
      userId: user.id,
      mediaItemId: item.id,
      mediaItemTitle: item.title,
      ruleSetId: ruleSet.id,
      ruleSetName: ruleSet.name,
      ruleSetType: "MOVIE",
      actionType: "DELETE_RADARR",
      arrInstanceId: "radarr-1",
      scheduledFor: new Date(Date.now() - 60_000),
      status: "PENDING" as const,
    })),
  });
  const actions = await prisma.lifecycleAction.findMany({ orderBy: { createdAt: "asc" } });
  const actionFor = (itemId: string) => actions.find((a) => a.mediaItemId === itemId)!;
  return { user, ruleSet, items, actionFor };
}

/** Which items reached the Arr app, in order. */
function actedOn(): string[] {
  return mockExecuteAction.mock.calls.map((c) => (c[0] as ActionArg).mediaItem.id);
}

/**
 * The executor does not order its actions, so a test that changes "the other
 * action" while one runs decides which one that is from the first call.
 */
function otherThan(items: { id: string }[], itemId: string): { id: string } {
  return items.find((i) => i.id !== itemId)!;
}

describe("scheduled execution while the actions change under it", () => {
  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    _resetExecuteInFlightForTesting();
    resetApiDestructiveBudget();
    mockExecuteAction.mockResolvedValue({});
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("does not act on an action removed after the run loaded it (cancelled, or run by a manual Execute)", async () => {
    const { user, items, actionFor } = await dueDeletes();
    // While the first action runs, the other is removed — exactly what the
    // inline Execute's cleanup, a Pending-page cancel, a new exception or a
    // rule set edit does to a PENDING row.
    let first: string | undefined;
    mockExecuteAction.mockImplementationOnce(async (a: ActionArg) => {
      first = a.mediaItem.id;
      await prisma.lifecycleAction.deleteMany({ where: { id: actionFor(otherThan(items, first).id).id } });
      return {};
    });

    await expect(executeLifecycleActions(user.id)).resolves.not.toThrow();

    expect(actedOn()).toEqual([first]);
    const rows = await prisma.lifecycleAction.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mediaItemId: first, status: "COMPLETED" });
  });

  it("finishes the run when an action's row vanishes while its Arr call fails", async () => {
    const { user, items, actionFor } = await dueDeletes();
    // A manual Execute deleted the movie and removed this PENDING row while
    // the executor's own request was in flight; Radarr then answers "not found".
    let first: string | undefined;
    mockExecuteAction.mockImplementationOnce(async (a: ActionArg) => {
      first = a.mediaItem.id;
      await prisma.lifecycleAction.deleteMany({ where: { id: actionFor(first).id } });
      throw new Error("Movie not found in Radarr");
    });

    await expect(executeLifecycleActions(user.id)).resolves.not.toThrow();

    // The run went on to the next action instead of aborting on P2025.
    const second = otherThan(items, first!).id;
    expect(actedOn()).toEqual([first, second]);
    const rows = await prisma.lifecycleAction.findMany();
    // No FAILED row for the action that was done elsewhere.
    expect(rows.map((r) => [r.mediaItemId, r.status])).toEqual([[second, "COMPLETED"]]);
    // The post-delete re-sync still ran for what this run deleted.
    expect(mockSyncMediaServer).toHaveBeenCalled();
  });

  it("records an action that ran even though it was cancelled while its Arr call was in flight", async () => {
    const { user, ruleSet, items, actionFor } = await dueDeletes(1);
    const [only] = items;
    mockExecuteAction.mockImplementationOnce(async () => {
      await prisma.lifecycleAction.deleteMany({ where: { id: actionFor(only.id).id } });
      return {};
    });

    await expect(executeLifecycleActions(user.id)).resolves.not.toThrow();

    const rows = await prisma.lifecycleAction.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mediaItemId: only.id,
      ruleSetId: ruleSet.id,
      status: "COMPLETED",
      actionType: "DELETE_RADARR",
      mediaItemTitle: only.title,
    });
    expect(rows[0].executedAt).not.toBeNull();
    // The match goes with it, as for any completed action.
    expect(await prisma.ruleMatch.count({ where: { mediaItemId: only.id } })).toBe(0);
  });

  it("leaves an item pending while a manual Execute of it is running", async () => {
    const { user, ruleSet, items, actionFor } = await dueDeletes();
    const [first, second] = items;
    // `second` is the one a manual Execute holds, whichever order the run takes.
    expect(tryBeginExecute(ruleSet.id, [second.id])).toBe(true);
    try {
      await executeLifecycleActions(user.id);
    } finally {
      endExecute(ruleSet.id, [second.id]);
    }

    expect(actedOn()).toEqual([first.id]);
    expect((await prisma.lifecycleAction.findUnique({ where: { id: actionFor(second.id).id } }))?.status).toBe(
      "PENDING",
    );
  });

  it("holds each item against a manual Execute while it runs, and releases it after", async () => {
    const { user, ruleSet, items } = await dueDeletes(1);
    const [only] = items;
    let manualWhileRunning: boolean | undefined;
    mockExecuteAction.mockImplementationOnce(async () => {
      manualWhileRunning = tryBeginExecute(ruleSet.id, [only.id]);
      return {};
    });

    await executeLifecycleActions(user.id);

    // The inline route would have answered 409 instead of deleting it again.
    expect(manualWhileRunning).toBe(false);
    expect(tryBeginExecute(ruleSet.id, [only.id])).toBe(true);
    endExecute(ruleSet.id, [only.id]);
  });

  it("gives an API-queued run's budget back for an action it skipped", async () => {
    const { user, items, actionFor } = await dueDeletes();
    mockExecuteAction.mockImplementationOnce(async (a: ActionArg) => {
      await prisma.lifecycleAction.deleteMany({ where: { id: actionFor(otherThan(items, a.mediaItem.id).id).id } });
      return {};
    });

    await executeLifecycleActions(user.id, { viaApiKey: "n8n" });

    // Two were reserved, one was sent.
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: API_DESTRUCTIVE_PER_HOUR - 1 });
  });

  it("gives an API-queued run's budget back for the actions it left pending behind a dead Arr instance", async () => {
    const { user } = await dueDeletes(3);
    const { IntegrationError } = await import("@/lib/integration-error");
    mockExecuteAction.mockRejectedValueOnce(
      new IntegrationError("Radarr", { config: { url: "/api/v3/movie", method: "get" }, code: "ECONNREFUSED" } as never),
    );

    await executeLifecycleActions(user.id, { viaApiKey: "n8n" });

    expect(mockExecuteAction).toHaveBeenCalledTimes(1);
    expect(await prisma.lifecycleAction.count({ where: { status: "PENDING" } })).toBe(2);
    // Three were reserved; the two never sent come back.
    expect(reserveApiDestructive(0)).toMatchObject({ ok: true, remaining: API_DESTRUCTIVE_PER_HOUR - 1 });
  });
});
