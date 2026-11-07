/**
 * An episode-scoped Sonarr Unmonitor on criteria that decide per season
 * unmonitors those seasons whole — the season flag and every Sonarr episode
 * of it, the ones the library does not hold included — judged against the
 * library's real rows: the show by `seriesKey` (recomputed for a row that
 * predates it), the season's other episodes, their copies (`dedupKey`) and
 * exceptions. `executeAction` runs for real; the Sonarr client is mocked.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestSonarrInstance,
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
const mockSonarr = vi.hoisted(() => ({
  getSeriesByTvdbId: vi.fn(),
  getEpisodes: vi.fn(),
  setEpisodesMonitored: vi.fn(),
  setSeasonsMonitored: vi.fn(),
  deleteEpisodeFiles: vi.fn(),
  triggerEpisodeSearch: vi.fn(),
  updateSeries: vi.fn(),
  getTags: vi.fn(),
}));
vi.mock("@/lib/arr/sonarr-client", () => ({ SonarrClient: function () { return mockSonarr; } }));

import { executeAction, type ActionRecord } from "@/lib/lifecycle/actions";
import type { SeasonScope } from "@/lib/lifecycle/episode-scope";

const prisma = getTestPrisma();
const KEY = "tvdb:73739";

beforeEach(async () => {
  await cleanDatabase();
  vi.clearAllMocks();
  mockSonarr.getSeriesByTvdbId.mockResolvedValue({
    id: 9, title: "Lost", year: 2004, tvdbId: 73739, tags: [], monitored: true, qualityProfileId: 1,
    seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, monitored: true })),
  });
  // Sonarr knows three episodes per season; the library holds fewer.
  mockSonarr.getEpisodes.mockResolvedValue(
    [1, 2, 3].flatMap((s) => [1, 2, 3].map((e) => ({ id: s * 100 + e, seasonNumber: s, episodeNumber: e, episodeFileId: s * 10 + e }))),
  );
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function library() {
  const user = await createTestUser();
  const server = await createTestServer(user.id);
  const lib = await createTestLibrary(server.id, { type: "SERIES" });
  const sonarr = await createTestSonarrInstance(user.id);
  const episode = async (season: number, ep: number, extra: { seriesKey?: string | null; parentTitle?: string } = {}) => {
    const row = await createTestMediaItem(lib.id, {
      type: "SERIES", title: `E${ep}`, parentTitle: extra.parentTitle ?? "Lost", seasonNumber: season, episodeNumber: ep,
      seriesKey: extra.seriesKey === undefined ? KEY : extra.seriesKey,
    });
    await createTestExternalId(row.id, "TVDB", "73739");
    return row;
  };
  return { user, server, lib, sonarr, episode };
}

function unmonitor(arrInstanceId: string, members: string[], seasonScope: SeasonScope, actionType = "UNMONITOR_SONARR"): ActionRecord {
  return {
    id: "a1", actionType, arrInstanceId, targetQualityProfileId: null, addImportExclusion: false, searchAfterAction: false,
    matchedMediaItemIds: members, addArrTags: [], removeArrTags: [], episodeScope: true, seasonScope,
    targetTitle: "Lost",
    mediaItem: { id: members[0], title: "E1", parentTitle: "Lost", year: 2004, externalIds: [{ source: "TVDB", externalId: "73739" }] },
  };
}

describe("whole seasons", () => {
  it("unmonitors a season every held episode of which was selected, with the episodes the library lacks", async () => {
    const { sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    const s1e2 = await episode(1, 2);
    const s2e1 = await episode(2, 1);
    await episode(2, 2); // held, not selected

    await executeAction(unmonitor(sonarr.id, [s1e1.id, s1e2.id, s2e1.id], "selected"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
    expect([...mockSonarr.setEpisodesMonitored.mock.calls[0][0]].sort()).toEqual([101, 102, 103, 201]);
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
  });

  it("does not let another show's episodes decide", async () => {
    const { lib, sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    // Same title and season numbers, another show (another TVDB id).
    await createTestMediaItem(lib.id, {
      type: "SERIES", title: "Other", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 2, seriesKey: "tvdb:1",
    });

    await executeAction(unmonitor(sonarr.id, [s1e1.id], "selected"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
  });

  it("keeps a season monitored that another server holds an unselected episode of", async () => {
    const { server, sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    const lib2 = await createTestLibrary(server.id, { type: "SERIES" });
    await createTestMediaItem(lib2.id, { type: "SERIES", title: "E2", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 2, seriesKey: KEY });

    await executeAction(unmonitor(sonarr.id, [s1e1.id], "selected"));

    expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([101], false);
  });

  it("matched: another server's copy of a matched episode is covered, its own episode is not", async () => {
    const { server, sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    const s1e2 = await episode(1, 2); // covered by an earlier action: not a member
    const s2e1 = await episode(2, 1);
    const lib2 = await createTestLibrary(server.id, { type: "SERIES" });
    const copy = await createTestMediaItem(lib2.id, { type: "SERIES", title: "E2", parentTitle: "Lost", seasonNumber: 1, episodeNumber: 2, seriesKey: KEY });
    await createTestMediaItem(lib2.id, { type: "SERIES", title: "E2", parentTitle: "Lost", seasonNumber: 2, episodeNumber: 2, seriesKey: KEY });
    await prisma.mediaItem.updateMany({ where: { id: { in: [s1e2.id, copy.id] } }, data: { dedupKey: "lost-s1e2" } });

    await executeAction(unmonitor(sonarr.id, [s1e1.id, s2e1.id], "matched"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
  });

  it("counts a held episode that predates seriesKey as the show's", async () => {
    const { sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    await episode(1, 2, { seriesKey: null }); // keyed from its TVDB id: the same show, not selected

    await executeAction(unmonitor(sonarr.id, [s1e1.id], "selected"));

    expect(mockSonarr.setSeasonsMonitored).not.toHaveBeenCalled();
    expect(mockSonarr.setEpisodesMonitored).toHaveBeenCalledWith([101], false);
  });

  it("selected: counts a selected episode's copy as selected", async () => {
    const { sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    const copy = await episode(1, 1);
    await prisma.mediaItem.updateMany({ where: { id: { in: [s1e1.id, copy.id] } }, data: { dedupKey: "lost-s1e1" } });

    await executeAction(unmonitor(sonarr.id, [s1e1.id], "selected"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
  });

  it("matched: unmonitors the season whatever the members, unless an exception protects an episode of it", async () => {
    const { user, sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    await episode(1, 2); // matched by the season's criteria, covered by an earlier action
    const s2e1 = await episode(2, 1);
    const s2e2 = await episode(2, 2);
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: s2e2.id } });

    await executeAction(unmonitor(sonarr.id, [s1e1.id, s2e1.id], "matched"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
    expect([...mockSonarr.setEpisodesMonitored.mock.calls[0][0]].sort()).toEqual([101, 102, 103, 201]);
  });

  it("Unmonitor & Delete Files unmonitors the season, then deletes only the members' files", async () => {
    const { sonarr, episode } = await library();
    const s1e1 = await episode(1, 1);
    const s1e2 = await episode(1, 2);

    const outcome = await executeAction(unmonitor(sonarr.id, [s1e1.id, s1e2.id], "matched", "UNMONITOR_DELETE_FILES_SONARR"));

    expect(mockSonarr.setSeasonsMonitored).toHaveBeenCalledWith(9, [1], false);
    expect([...mockSonarr.setEpisodesMonitored.mock.calls[0][0]].sort()).toEqual([101, 102, 103]);
    expect([...mockSonarr.deleteEpisodeFiles.mock.calls[0][0]].sort()).toEqual([11, 12]);
    expect([...(outcome.deletedMemberIds ?? [])].sort()).toEqual([s1e1.id, s1e2.id].sort());
    expect(mockSonarr.updateSeries).not.toHaveBeenCalled();
  });
});
