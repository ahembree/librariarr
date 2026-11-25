import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  library: { findMany: vi.fn() },
  lifecycleAction: { findMany: vi.fn() },
  appSettings: { findUnique: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));
const plex = vi.hoisted(() => ({
  getCollections: vi.fn(),
  getCollectionItems: vi.fn(),
  getLibraryItems: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: function () { return plex; },
}));

import {
  buildEditorContribution,
  editorPendingActions,
  previewCollectionOrder,
} from "@/lib/lifecycle/collection-order-preview";

const server = { id: "s1", name: "Home", url: "http://plex", accessToken: "t", machineId: "m1", tlsSkipVerify: false };
const movieLibrary = { id: "lib1", key: "1", title: "Movies", mediaServer: server };
const tvLibrary = { id: "lib1", key: "1", title: "TV", mediaServer: server };

/** Answer the preview's raw queries: sort values, then titles. */
function stubQueries(values: Array<{ key: string; value: number | string | null }>, titles: Array<Record<string, unknown>> = []) {
  mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) =>
    sql.includes(`AS "value"`) ? values : titles,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("buildEditorContribution", () => {
  it("marks a candidate the stored match lists as another server's copy", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ mediaItemId: "m1", copies: [{ id: "m2" }] }]);
    const contribution = await buildEditorContribution("rs1", false, [
      { id: "m1", libraryId: "lib1", ratingKey: "a", title: "A", parentTitle: null },
      { id: "m2", libraryId: "lib2", ratingKey: "a2", title: "A", parentTitle: null },
      { id: "m3", libraryId: "lib1", ratingKey: "", title: "No key", parentTitle: null },
    ]);
    expect(contribution).toEqual({
      ruleSetId: "rs1",
      seriesScope: false,
      items: [
        { libraryId: "lib1", ratingKey: "a", title: "A", parentTitle: null },
        { libraryId: "lib2", ratingKey: "a2", title: "A", parentTitle: null, copyOf: "m1" },
      ],
    });
  });

  it("adds the stored matches a sticky save keeps, once", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    const contribution = await buildEditorContribution("rs1", false, [
      { id: "m1", libraryId: "lib1", ratingKey: "a", title: "A", parentTitle: null },
    ], [
      { libraryId: "lib1", ratingKey: "a", title: "A", parentTitle: null },
      { libraryId: "lib1", ratingKey: "kept", title: "Kept", parentTitle: null },
    ]);
    expect(contribution.items.map((i) => i.ratingKey)).toEqual(["a", "kept"]);
  });

  it("stands in for a rule set not saved yet", async () => {
    const contribution = await buildEditorContribution(undefined, true, []);
    expect(contribution.ruleSetId).toBe("__editor__");
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("editorPendingActions", () => {
  const candidates = [
    { id: "m1", libraryId: "lib1", ratingKey: "a", title: "A", parentTitle: null },
    { id: "m2", libraryId: "lib1", ratingKey: "b", title: "B", parentTitle: null },
  ];
  const scheduled = (mediaItemId: string) => ({
    scheduledFor: new Date("2030-01-01"), ruleSetId: "rs1", mediaItemId,
    mediaItem: { ratingKey: mediaItemId, parentTitle: null, title: mediaItemId },
  });
  const config = (actionType: string) => ({
    actionType, arrInstanceId: "arr1", targetQualityProfileId: null, addImportExclusion: false,
    searchAfterAction: false, addArrTags: [], removeArrTags: [],
  });
  const settled = (mediaItemId: string, overrides: Record<string, unknown> = {}) => ({
    mediaItemId, status: "COMPLETED", ...config("UNMONITOR_RADARR"), matchedMediaItemIds: [], ...overrides,
  });
  const now = new Date("2029-12-01T00:00:00Z");

  /** The PENDING read, then the settled read (non-destructive actions only). */
  function stubActions(pending: unknown[], settledRows: unknown[] = []) {
    mockPrisma.lifecycleAction.findMany.mockImplementation(async ({ where }: { where: { status: unknown } }) =>
      where.status === "PENDING" ? pending : settledRows,
    );
  }

  it("keeps a candidate's pending action, estimates the rest and drops one no longer matched", async () => {
    stubActions([scheduled("m1"), scheduled("gone")]);
    const actions = await editorPendingActions("u1", "rs1", candidates, { armed: true, delayDays: 7, type: "MOVIE", config: config("DELETE_RADARR") }, now);
    expect(actions.map((a) => [a.mediaItemId, a.estimated ?? false])).toEqual([["m1", false], ["m2", true]]);
    expect(actions[1].scheduledFor).toEqual(new Date("2029-12-08T00:00:00Z"));
    expect(actions[1].mediaItem).toEqual({ ratingKey: "b", parentTitle: null, title: "B" });
  });

  it("estimates nothing while the action is off", async () => {
    stubActions([]);
    expect(await editorPendingActions("u1", "rs1", candidates, { armed: false, delayDays: 7, type: "MOVIE", config: config("DELETE_RADARR") })).toEqual([]);
  });

  it("estimates no non-destructive action a settled one of the same config already ran", async () => {
    // m1's settled action has the config being saved; m2's ran with other tags.
    stubActions([], [settled("m1"), settled("m2", { addArrTags: ["old"] })]);
    const actions = await editorPendingActions("u1", "rs1", candidates, { armed: true, delayDays: 0, type: "MOVIE", config: config("UNMONITOR_RADARR") }, now);
    expect(actions.map((a) => a.mediaItemId)).toEqual(["m2"]);
  });

  it("estimates a show only while a matched episode is uncovered", async () => {
    const shows = [
      { id: "s1", libraryId: "lib1", ratingKey: "s1", title: "Covered", parentTitle: null, memberIds: ["e1", "e2"] },
      { id: "s2", libraryId: "lib1", ratingKey: "s2", title: "Half", parentTitle: null, memberIds: ["e3", "e4"] },
    ];
    const series = { ...config("UNMONITOR_SONARR") };
    stubActions([], [
      settled("s1", { ...series, matchedMediaItemIds: ["e1", "e2"] }),
      settled("s2", { ...series, matchedMediaItemIds: ["e3"] }),
    ]);
    const actions = await editorPendingActions("u1", "rs1", shows, { armed: true, delayDays: 0, type: "SERIES", config: series }, now);
    expect(actions.map((a) => a.mediaItemId)).toEqual(["s2"]);
  });

  it("holds a show's estimate to the grouped-action hold", async () => {
    stubActions([]);
    mockPrisma.appSettings.findUnique.mockResolvedValue({ groupedActionsHeldUntil: new Date("2030-06-01T00:00:00Z") });
    const show = [{ id: "s1", libraryId: "lib1", ratingKey: "s1", title: "Show", parentTitle: null }];
    const actions = await editorPendingActions("u1", "rs1", show, { armed: true, delayDays: 1, type: "SERIES", config: config("DELETE_SONARR") }, now);
    expect(actions[0].scheduledFor).toEqual(new Date("2030-06-01T00:00:00Z"));
  });
});

describe("previewCollectionOrder", () => {
  const movies = (keys: string[]) => ({
    ruleSetId: "rs1",
    seriesScope: false,
    items: keys.map((k) => ({ libraryId: "lib1", ratingKey: k, title: k.toUpperCase(), parentTitle: null })),
  });
  const input = (overrides: Record<string, unknown> = {}) => ({
    userId: "u1",
    collection: { name: "C", type: "MOVIE" as const, sort: "PLAY_COUNT", sortDirection: "desc" },
    contributions: [movies(["a", "b"])],
    pendingActions: [],
    ...overrides,
  });

  it("reports a server without a machine id as skipped", async () => {
    mockPrisma.library.findMany.mockResolvedValue([{ ...movieLibrary, mediaServer: { ...server, machineId: null } }]);
    const result = await previewCollectionOrder(input());
    expect(result.libraries).toEqual([expect.objectContaining({ status: "skipped", items: [] })]);
    expect(plex.getCollections).not.toHaveBeenCalled();
  });

  it("reports matches that resolve to no show as left untouched", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLibrary]);
    plex.getLibraryItems.mockResolvedValue([{ title: "Another Show", ratingKey: "show9" }]);
    const result = await previewCollectionOrder(input({
      collection: { name: "C", type: "SERIES", sort: "PLAY_COUNT", sortDirection: "desc" },
      contributions: [{ ruleSetId: "rs1", seriesScope: true, items: [{ libraryId: "lib1", ratingKey: "ep1", title: "Pilot", parentTitle: "Gone Show" }] }],
    }));
    expect(result.libraries).toEqual([expect.objectContaining({ status: "untouched" })]);
  });

  it("reports a show lookup Plex refuses as an error", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLibrary]);
    plex.getLibraryItems.mockRejectedValue(new Error("boom"));
    const result = await previewCollectionOrder(input({
      collection: { name: "C", type: "SERIES", sort: "PLAY_COUNT", sortDirection: "desc" },
      contributions: [{ ruleSetId: "rs1", seriesScope: true, items: [{ libraryId: "lib1", ratingKey: "ep1", title: "Pilot", parentTitle: "Show" }] }],
    }));
    expect(result.libraries).toEqual([expect.objectContaining({ status: "error", message: expect.stringMatching(/shows from Plex/) })]);
  });

  it("names shows by Plex's title and episodes by show and code", async () => {
    mockPrisma.library.findMany.mockResolvedValue([tvLibrary]);
    plex.getLibraryItems.mockResolvedValue([{ title: "The Show", ratingKey: "show1" }]);
    plex.getCollections.mockResolvedValue([]);
    stubQueries([{ key: "ep2", value: 1 }, { key: "the show", value: 9 }], [
      { ratingKey: "ep2", title: "Pilot", parentTitle: "Other Show", type: "SERIES", seasonNumber: 1, episodeNumber: 2 },
    ]);
    const result = await previewCollectionOrder(input({
      collection: { name: "C", type: "SERIES", sort: "PLAY_COUNT", sortDirection: "desc" },
      contributions: [
        { ruleSetId: "rs1", seriesScope: true, items: [{ libraryId: "lib1", ratingKey: "ep1", title: "Pilot", parentTitle: "The Show" }] },
        { ruleSetId: "rs2", seriesScope: false, items: [{ libraryId: "lib1", ratingKey: "ep2", title: "Pilot", parentTitle: "Other Show" }] },
      ],
    }));
    expect(result.libraries[0].items.map((i) => [i.title, i.value])).toEqual([
      ["The Show", 9],
      ["Other Show S01E02", 1],
    ]);
  });

  it("lists every current member as leaving when nothing matches any more", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLibrary]);
    plex.getCollections.mockResolvedValue([{ ratingKey: "col", title: "C" }]);
    plex.getCollectionItems.mockResolvedValue([{ ratingKey: "x", title: "Old", grandparentTitle: "Show" }]);
    stubQueries([]);
    const result = await previewCollectionOrder(input({ contributions: [] }));
    expect(result.libraries[0]).toMatchObject({
      status: "ok",
      items: [],
      removed: [{ ratingKey: "x", title: "Show — Old", previousPosition: 0 }],
      moves: 0,
    });
  });

  it("reads Plex's current order under the stored name of a collection renamed in the editor", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLibrary]);
    plex.getCollections.mockResolvedValue([{ ratingKey: "col", title: "Old Name" }]);
    plex.getCollectionItems.mockResolvedValue([{ ratingKey: "b" }, { ratingKey: "a" }]);
    stubQueries([{ key: "a", value: 2 }, { key: "b", value: 1 }]);
    const result = await previewCollectionOrder(input({
      collection: { name: "New Name", plexName: "Old Name", type: "MOVIE", sort: "PLAY_COUNT", sortDirection: "desc" },
    }));
    expect(result.libraries[0]).toMatchObject({ collectionExists: true, moves: 1 });
    expect(result.libraries[0].items.map((i) => [i.ratingKey, i.previousPosition])).toEqual([["a", 1], ["b", 0]]);
  });

  it("names a track by its artist too", async () => {
    mockPrisma.library.findMany.mockResolvedValue([{ ...movieLibrary, title: "Music" }]);
    plex.getCollections.mockResolvedValue([]);
    stubQueries([{ key: "a", value: 1 }], [
      { ratingKey: "a", title: "Intro", parentTitle: "The Band", type: "MUSIC", seasonNumber: null, episodeNumber: null },
    ]);
    const result = await previewCollectionOrder(input({
      collection: { name: "C", type: "MUSIC", sort: "PLAY_COUNT", sortDirection: "desc" },
      contributions: [movies(["a"])],
    }));
    expect(result.libraries[0].items[0].title).toBe("The Band — Intro");
  });

  it("leaves out a library that neither holds the collection nor gets a member", async () => {
    mockPrisma.library.findMany.mockResolvedValue([movieLibrary, { ...movieLibrary, id: "lib2", key: "2" }]);
    plex.getCollections.mockResolvedValue([]);
    stubQueries([{ key: "a", value: 2 }, { key: "b", value: 1 }]);
    const result = await previewCollectionOrder(input());
    expect(result.libraries.map((l) => l.libraryId)).toEqual(["lib1"]);
    expect(result.libraries[0].items.map((i) => i.ratingKey)).toEqual(["a", "b"]);
    expect(result.libraries[0].collectionExists).toBe(false);
  });
});
