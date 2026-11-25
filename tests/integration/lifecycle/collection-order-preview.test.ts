import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  expectStreamResult,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
  createTestCollection,
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

// Plex: what the collection holds now. Every write is a mock the test asserts
// is never called — the preview reads only.
const plex = vi.hoisted(() => ({
  getCollections: vi.fn(),
  getCollectionItems: vi.fn(),
  getLibraryItems: vi.fn(),
  createCollection: vi.fn(),
  addCollectionItems: vi.fn(),
  removeCollectionItem: vi.fn(),
  moveCollectionItem: vi.fn(),
  editCollectionSort: vi.fn(),
  editCollectionSortTitle: vi.fn(),
  deleteCollection: vi.fn(),
  updateCollectionVisibility: vi.fn(),
}));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: function () { return plex; },
}));

import { POST } from "@/app/api/lifecycle/collections/order-preview/route";
import type { CollectionOrderPreview } from "@/lib/lifecycle/collection-order-preview";

const GB = BigInt(1024 ** 3);
const OLD_MOVIES = [{ id: "r1", field: "year", operator: "lessThan", value: 2010, condition: "AND" }];

function expectNoPlexWrites() {
  for (const write of [
    plex.createCollection, plex.addCollectionItems, plex.removeCollectionItem, plex.moveCollectionItem,
    plex.editCollectionSort, plex.editCollectionSortTitle, plex.deleteCollection, plex.updateCollectionVisibility,
  ]) {
    expect(write).not.toHaveBeenCalled();
  }
}

/**
 * Four movies on one Plex library. A, B and C are old (match the unsaved
 * rules), D is new. The edited rule set has stored only B; another rule set
 * feeding the collection has stored D.
 */
async function seed(options: { sort?: string; sortDirection?: string } = {}) {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { name: "Home Plex" });
  const library = await createTestLibrary(server.id, { type: "MOVIE", title: "Movies", key: "1" });
  const a = await createTestMediaItem(library.id, { ratingKey: "a", title: "Alpha", type: "MOVIE", year: 2000, fileSize: BigInt(5) * GB });
  const b = await createTestMediaItem(library.id, { ratingKey: "b", title: "Bravo", type: "MOVIE", year: 2001, fileSize: GB });
  const c = await createTestMediaItem(library.id, { ratingKey: "c", title: "Charlie", type: "MOVIE", year: 2002, fileSize: BigInt(3) * GB });
  const d = await createTestMediaItem(library.id, { ratingKey: "d", title: "Delta", type: "MOVIE", year: 2020, fileSize: BigInt(2) * GB });
  const collection = await createTestCollection(user.id, {
    name: "Big", type: "MOVIE", sort: options.sort ?? "FILE_SIZE", sortDirection: options.sortDirection ?? "desc",
  });
  const edited = await createTestRuleSet(user.id, {
    name: "Edited", type: "MOVIE", collectionId: collection.id,
    rules: [{ id: "g", condition: "AND", rules: [{ id: "old", field: "year", operator: "lessThan", value: "1990", condition: "AND" }], groups: [] }],
  });
  await createTestRuleMatch(edited.id, b.id, { id: b.id, libraryId: library.id, ratingKey: "b", title: "Bravo", parentTitle: null });
  const other = await createTestRuleSet(user.id, { name: "Other", type: "MOVIE", collectionId: collection.id });
  await createTestRuleMatch(other.id, d.id, { id: d.id, libraryId: library.id, ratingKey: "d", title: "Delta", parentTitle: null });
  return { user, server, library, collection, edited, other, items: { a, b, c, d } };
}

function body(seeded: Awaited<ReturnType<typeof seed>>, overrides: Record<string, unknown> = {}) {
  return {
    rules: OLD_MOVIES,
    type: "MOVIE",
    serverIds: [seeded.server.id],
    ruleSetId: seeded.edited.id,
    collectionId: seeded.collection.id,
    collectionName: "Big",
    sort: "FILE_SIZE",
    sortDirection: "desc",
    ...overrides,
  };
}

async function preview(requestBody: Record<string, unknown>) {
  const response = await callRoute(POST, {
    url: "/api/lifecycle/collections/order-preview",
    method: "POST",
    body: requestBody,
  });
  return (await expectStreamResult<CollectionOrderPreview>(response)).result;
}

describe("POST /api/lifecycle/collections/order-preview", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    for (const fn of Object.values(plex)) fn.mockReset();
    // Plex holds B, D and a member no rule set matches any more.
    plex.getCollections.mockResolvedValue([{ ratingKey: "col", title: "Big", collectionSort: "2" }]);
    plex.getCollectionItems.mockResolvedValue([
      { ratingKey: "b", title: "Bravo" },
      { ratingKey: "d", title: "Delta" },
      { ratingKey: "gone", title: "Gone Movie" },
    ]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/order-preview",
      method: "POST",
      body: {},
    });
    await expectJson(response, 401);
  });

  it("returns 400 for a body without a collection name or sort", async () => {
    const seeded = await seed();
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });
    for (const missing of ["collectionName", "sort", "sortDirection"]) {
      const b = body(seeded);
      delete (b as Record<string, unknown>)[missing];
      const response = await callRoute(POST, { url: "/api/lifecycle/collections/order-preview", method: "POST", body: b });
      const json = await expectJson<{ error: string }>(response, 400);
      expect(json.error).toBe("Validation failed");
    }
  });

  it("returns 404 for another user's collection or rule set", async () => {
    const seeded = await seed();
    const stranger = await createTestUser();
    const theirs = await createTestCollection(stranger.id, { name: "Theirs", type: "MOVIE" });
    const theirRuleSet = await createTestRuleSet(stranger.id, { name: "Theirs", type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const byCollection = await callRoute(POST, {
      url: "/api/lifecycle/collections/order-preview",
      method: "POST",
      body: body(seeded, { collectionId: theirs.id }),
    });
    expect((await expectJson<{ error: string }>(byCollection, 404)).error).toBe("Collection not found");

    const byRuleSet = await callRoute(POST, {
      url: "/api/lifecycle/collections/order-preview",
      method: "POST",
      body: body(seeded, { ruleSetId: theirRuleSet.id }),
    });
    expect((await expectJson<{ error: string }>(byRuleSet, 404)).error).toBe("Rule set not found");
  });

  it("returns 400 for a collection of another library type", async () => {
    const seeded = await seed();
    const tv = await createTestCollection(seeded.user.id, { name: "TV", type: "SERIES" });
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });
    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/order-preview",
      method: "POST",
      body: body(seeded, { collectionId: tv.id }),
    });
    await expectJson(response, 400);
  });

  it("returns 400 when no rule is active", async () => {
    const seeded = await seed();
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });
    const response = await callRoute(POST, {
      url: "/api/lifecycle/collections/order-preview",
      method: "POST",
      body: body(seeded, { rules: [{ ...OLD_MOVIES[0], enabled: false }] }),
    });
    expect((await expectJson<{ error: string }>(response, 400)).error).toBe("No active rules to evaluate");
  });

  it("orders the unsaved rules' matches with the other rule sets' stored ones, diffed against Plex", async () => {
    const seeded = await seed();
    // An exception keeps Charlie out, as detection does.
    await getTestPrisma().lifecycleException.create({ data: { userId: seeded.user.id, mediaItemId: seeded.items.c.id } });
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const result = await preview(body(seeded));

    expect(result.field).toBe("FILE_SIZE");
    expect(result.direction).toBe("desc");
    expect(result.libraries).toHaveLength(1);
    const library = result.libraries[0];
    expect(library).toMatchObject({
      libraryTitle: "Movies", serverName: "Home Plex", status: "ok", collectionExists: true, plexSorted: false,
    });
    // Alpha (5 GB, newly matched by the unsaved rules), Delta (2 GB, the other
    // rule set's), Bravo (1 GB).
    expect(library.items.map((i) => [i.title, i.position, i.previousPosition])).toEqual([
      ["Alpha", 0, null],
      ["Delta", 1, 1],
      ["Bravo", 2, 0],
    ]);
    expect(library.items[0].value).toBe(5 * 1024 ** 3);
    expect(library.removed).toEqual([{ ratingKey: "gone", title: "Gone Movie", previousPosition: 2 }]);
    // After the membership writes Plex holds Bravo, Delta, Alpha: two moves.
    expect(library.moves).toBe(2);
    expectNoPlexWrites();
  });

  it("leaves out a rule set the editor has switched off", async () => {
    const seeded = await seed();
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const result = await preview(body(seeded, { enabled: false }));

    expect(result.libraries[0].items.map((i) => i.title)).toEqual(["Delta"]);
    expect(result.libraries[0].removed.map((i) => i.ratingKey)).toEqual(["b", "gone"]);
  });

  it("reports Plex's own sort for Title ascending, with no moves", async () => {
    const seeded = await seed();
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const result = await preview(body(seeded, { sort: "ALPHABETICAL", sortDirection: "asc" }));

    const library = result.libraries[0];
    expect(library.plexSorted).toBe(true);
    expect(library.moves).toBeNull();
    expect(library.items.map((i) => i.title)).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("estimates an action date for a match with no pending action, and keeps a scheduled one", async () => {
    const seeded = await seed();
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await getTestPrisma().lifecycleAction.create({
      data: {
        userId: seeded.user.id, ruleSetId: seeded.edited.id, mediaItemId: seeded.items.b.id,
        actionType: "DELETE_RADARR", status: "PENDING", scheduledFor: soon,
      },
    });
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const before = Date.now();
    const result = await preview(body(seeded, {
      sort: "ACTION_DATE", sortDirection: "asc",
      actionEnabled: true, actionType: "DELETE_RADARR", actionDelayDays: 10,
    }));

    const items = result.libraries[0].items;
    // Bravo's scheduled date (3 days) comes first; Alpha and Charlie are
    // estimated at 10 days; Delta's rule set has no action, so it is last.
    expect(items[0]).toMatchObject({ title: "Bravo", value: soon.getTime() });
    expect(items[0].estimated).toBeUndefined();
    const estimated = items.filter((i) => i.estimated);
    expect(estimated.map((i) => i.title).sort()).toEqual(["Alpha", "Charlie"]);
    for (const item of estimated) {
      expect(item.value as number).toBeGreaterThanOrEqual(before + 10 * 24 * 60 * 60 * 1000);
    }
    expect(items[3]).toMatchObject({ title: "Delta", value: null });
  });

  it("previews a new collection Plex does not hold yet", async () => {
    const seeded = await seed();
    plex.getCollections.mockResolvedValue([]);
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const result = await preview(body(seeded, { collectionId: null, collectionName: "Brand New" }));

    const library = result.libraries[0];
    expect(library.collectionExists).toBe(false);
    // Only the editor's own matches: a new collection has no other rule set.
    expect(library.items.map((i) => [i.title, i.previousPosition])).toEqual([
      ["Alpha", null],
      ["Charlie", null],
      ["Bravo", null],
    ]);
    expect(library.removed).toEqual([]);
    expect(plex.getCollectionItems).not.toHaveBeenCalled();
  });

  it("still shows the target order when Plex cannot be read", async () => {
    const seeded = await seed();
    plex.getCollections.mockRejectedValue(new Error("connect ECONNREFUSED"));
    setMockSession({ isLoggedIn: true, userId: seeded.user.id });

    const result = await preview(body(seeded));

    const library = result.libraries[0];
    expect(library.status).toBe("currentUnknown");
    expect(library.message).toMatch(/current order is unknown/);
    expect(library.moves).toBeNull();
    expect(library.items.map((i) => [i.title, i.previousPosition])).toEqual([
      ["Alpha", null],
      ["Charlie", null],
      ["Delta", null],
      ["Bravo", null],
    ]);
  });
});
