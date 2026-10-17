import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
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

const { fetchArr, fetchSeerr } = vi.hoisted(() => ({ fetchArr: vi.fn(), fetchSeerr: vi.fn() }));
vi.mock("@/lib/query/fetch-arr-data", () => ({ fetchArrDataForQuery: fetchArr }));
vi.mock("@/lib/query/fetch-seerr-data", () => ({ fetchSeerrDataForQuery: fetchSeerr }));

import { computeQueryColumnValues } from "@/lib/query/column-values";
import { appCache } from "@/lib/cache/memory-cache";

let userId: string;
let serverId: string;

beforeEach(async () => {
  await cleanDatabase();
  appCache.clear();
  fetchArr.mockReset();
  fetchSeerr.mockReset();
  const user = await createTestUser();
  userId = user.id;
  serverId = (await createTestServer(userId)).id;
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function movie(tmdb?: string) {
  const lib = await createTestLibrary(serverId, { type: "MOVIE" });
  const item = await createTestMediaItem(lib.id, { type: "MOVIE", title: "Heat", studio: "WB" });
  if (tmdb) await createTestExternalId(item.id, "TMDB", tmdb);
  return item;
}

describe("computeQueryColumnValues — Arr and Seerr columns", () => {
  it("returns nothing for no fields, no items, or only unknown fields", async () => {
    const item = await movie();
    expect(await computeQueryColumnValues(userId, { items: [], fields: ["studio"], serverIds: [] })).toEqual({ values: {}, warnings: [] });
    expect(await computeQueryColumnValues(userId, { items: [{ id: item.id }], fields: ["bogus"], serverIds: [] })).toEqual({
      values: {},
      warnings: [],
    });
  });

  it("returns nothing when the user has no enabled server", async () => {
    const item = await movie();
    await getTestPrisma().mediaServer.update({ where: { id: serverId }, data: { enabled: false } });
    expect(await computeQueryColumnValues(userId, { items: [{ id: item.id }], fields: ["studio"], serverIds: [] })).toEqual({
      values: {},
      warnings: [],
    });
  });

  it("reads the selected Arr server's record by the movie's TMDB id", async () => {
    const found = await movie("603");
    const missing = await movie("999");
    fetchArr.mockResolvedValue({ MOVIE: { "603": { monitored: true, tags: ["keep"], qualityProfile: "HD" } } });

    const { values, warnings } = await computeQueryColumnValues(userId, {
      items: [{ id: found.id }, { id: missing.id }],
      fields: ["foundInArr", "arrMonitored", "arrTag", "studio"],
      serverIds: [serverId],
      arrServerIds: { radarr: "r1" },
    });
    expect(warnings).toEqual([]);
    expect(fetchArr).toHaveBeenCalledWith(userId, { radarr: "r1" }, ["MOVIE"]);
    expect(values[found.id]).toEqual({ foundInArr: true, arrMonitored: true, arrTag: ["keep"], studio: "WB" });
    expect(values[missing.id]).toEqual({ foundInArr: false, arrMonitored: null, arrTag: null, studio: "WB" });
  });

  it("warns, and leaves Arr columns empty, when the Arr fetch fails", async () => {
    const item = await movie("603");
    fetchArr.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:7878"));
    const { values, warnings } = await computeQueryColumnValues(userId, {
      items: [{ id: item.id }],
      fields: ["foundInArr", "arrMonitored"],
      serverIds: [],
      arrServerIds: { sonarr: "s1" },
    });
    expect(values[item.id]).toEqual({ foundInArr: null, arrMonitored: null });
    // The private address is scrubbed before the reason reaches the page.
    expect(warnings).toEqual(["Arr columns are empty: connect ECONNREFUSED [internal]:7878"]);
  });

  it("stringifies a non-Error Arr failure", async () => {
    const item = await movie("603");
    fetchArr.mockRejectedValue("plain failure");
    const { warnings } = await computeQueryColumnValues(userId, {
      items: [{ id: item.id }],
      fields: ["arrMonitored"],
      serverIds: [],
      arrServerIds: { lidarr: "l1" },
    });
    expect(warnings).toEqual(["Arr columns are empty: plain failure"]);
  });

  it("reads Seerr data when it loads, and treats a missing request as none", async () => {
    const requested = await movie("603");
    const notRequested = await movie("604");
    fetchSeerr.mockResolvedValue({
      MOVIE: {
        "TMDB:603": {
          requested: true,
          requestCount: 2,
          requestDate: "2024-01-01T00:00:00.000Z",
          requestedBy: ["alice"],
          approvalDate: null,
          declineDate: null,
        },
      },
    });
    const { values, warnings } = await computeQueryColumnValues(userId, {
      items: [{ id: requested.id }, { id: notRequested.id }],
      fields: ["seerrRequested", "seerrRequestCount", "seerrRequestedBy"],
      serverIds: [],
    });
    expect(warnings).toEqual([]);
    expect(fetchSeerr).toHaveBeenCalledWith(userId, ["MOVIE"]);
    expect(values[requested.id]).toEqual({ seerrRequested: true, seerrRequestCount: 2, seerrRequestedBy: ["alice"] });
    expect(values[notRequested.id]).toEqual({ seerrRequested: false, seerrRequestCount: 0, seerrRequestedBy: [] });
  });

  it("warns, and leaves Seerr columns null, when the Seerr fetch fails", async () => {
    const item = await movie("603");
    fetchSeerr.mockRejectedValue(new Error("Seerr timed out"));
    const { values, warnings } = await computeQueryColumnValues(userId, {
      items: [{ id: item.id }],
      fields: ["seerrRequested"],
      serverIds: [],
    });
    expect(values[item.id]).toEqual({ seerrRequested: null });
    expect(warnings).toEqual(["Seerr columns are empty: Seerr timed out"]);

    fetchSeerr.mockRejectedValue(42);
    const again = await computeQueryColumnValues(userId, { items: [{ id: item.id }], fields: ["seerrRequested"], serverIds: [] });
    expect(again.warnings).toEqual(["Seerr columns are empty: 42"]);
  });

  it("answers a grouped row from its show aggregate, with episode-only detail null", async () => {
    const lib = await createTestLibrary(serverId, { type: "SERIES" });
    const ep = await createTestMediaItem(lib.id, {
      type: "SERIES", title: "Pilot", parentTitle: "Show", seasonNumber: 1, episodeNumber: 1, studio: "HBO",
    });
    const { values } = await computeQueryColumnValues(userId, {
      items: [{ id: ep.id, grouped: true }],
      fields: ["availableEpisodeCount", "studio", "audioStreamCount"],
      serverIds: [],
    });
    // Show-level fields come from the aggregate; a per-show stream count would
    // total every episode's tracks, so it is left empty.
    expect(values[ep.id]).toEqual({ availableEpisodeCount: 1, studio: "HBO", audioStreamCount: null });
  });
});
