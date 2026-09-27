import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestApiKey,
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

// system/info asks GitHub for the latest release.
vi.mock("@/lib/version/update-checker", () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ updateAvailable: false }),
}));

const { mockGetSessions } = vi.hoisted(() => ({ mockGetSessions: vi.fn() }));
vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return { getSessions: mockGetSessions };
  }),
}));

import * as me from "@/app/api/v1/me/route";
import * as systemInfo from "@/app/api/v1/system/info/route";
import * as servers from "@/app/api/v1/servers/route";
import * as syncStatus from "@/app/api/v1/sync/status/route";
import * as movies from "@/app/api/v1/media/movies/route";
import * as series from "@/app/api/v1/media/series/route";
import * as seriesGrouped from "@/app/api/v1/media/series/grouped/route";
import * as seriesSeasons from "@/app/api/v1/media/series/seasons/route";
import * as music from "@/app/api/v1/media/music/route";
import * as musicGrouped from "@/app/api/v1/media/music/grouped/route";
import * as musicAlbums from "@/app/api/v1/media/music/albums/route";
import * as search from "@/app/api/v1/media/search/route";
import * as recentlyAdded from "@/app/api/v1/media/recently-added/route";
import * as mediaStats from "@/app/api/v1/media/stats/route";
import * as history from "@/app/api/v1/media/history/route";
import * as mediaItem from "@/app/api/v1/media/[id]/route";
import * as mediaPlays from "@/app/api/v1/media/[id]/plays/route";
import * as rules from "@/app/api/v1/lifecycle/rules/route";
import * as ruleMatches from "@/app/api/v1/lifecycle/rules/matches/route";
import * as actions from "@/app/api/v1/lifecycle/actions/route";
import * as exceptions from "@/app/api/v1/lifecycle/exceptions/route";
import * as lifecycleStats from "@/app/api/v1/lifecycle/stats/route";
import * as sessions from "@/app/api/v1/tools/sessions/route";
import * as maintenance from "@/app/api/v1/tools/maintenance/route";
import { READ_ONLY_SCOPES } from "@/lib/api-keys/scopes";

const prisma = getTestPrisma();

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Every stored path lives under this directory, so one substring check finds any of them. */
const STORAGE = "/srv/private-media";

/**
 * A read key sees a media server's library, never its disk. `/media/{id}` was
 * trimmed of `filePath` when the API was added; this pins the same rule on every
 * other read endpoint, including the ones that return a stored snapshot of an
 * item (a rule match) or the server's live view of a stream (a session).
 */
describe("/api/v1 read endpoints never return a media file path", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  async function seed() {
    const user = await createTestUser();
    await prisma.appSettings.create({ data: { userId: user.id } });
    const server = await createTestServer(user.id, { name: "Home" });
    const movieLib = await createTestLibrary(server.id, { type: "MOVIE", key: "1" });
    const showLib = await createTestLibrary(server.id, { type: "SERIES", key: "2" });
    const musicLib = await createTestLibrary(server.id, { type: "MUSIC", key: "3" });

    const movie = await createTestMediaItem(movieLib.id, {
      title: "Arrival",
      year: 2016,
      filePath: `${STORAGE}/movies/Arrival (2016)/Arrival.mkv`,
    });
    const episode = await createTestMediaItem(showLib.id, {
      type: "SERIES",
      title: "Pilot",
      parentTitle: "The Show",
      seriesKey: "title:the show",
      seasonNumber: 1,
      episodeNumber: 1,
      filePath: `${STORAGE}/tv/The Show/Season 01/The Show - S01E01.mkv`,
    });
    const track = await createTestMediaItem(musicLib.id, {
      type: "MUSIC",
      title: "Song",
      parentTitle: "Artist",
      albumTitle: "Album",
      filePath: `${STORAGE}/music/Artist/Album/01 Song.flac`,
    });

    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2025-01-01T00:00:00Z"),
      },
    });

    // Detection stores the item it matched as a snapshot, file path included.
    const ruleSet = await createTestRuleSet(user.id, {
      name: "Unwatched",
      type: "MOVIE",
      actionEnabled: true,
      actionType: "DELETE_RADARR",
    });
    const { fileSize, ...snapshot } = movie;
    await prisma.ruleMatch.create({
      data: {
        ruleSetId: ruleSet.id,
        mediaItemId: movie.id,
        itemData: { ...snapshot, fileSize: fileSize?.toString() ?? null },
      },
    });
    await prisma.lifecycleAction.create({
      data: {
        userId: user.id,
        mediaItemId: movie.id,
        mediaItemTitle: movie.title,
        ruleSetId: ruleSet.id,
        ruleSetName: ruleSet.name,
        ruleSetType: "MOVIE",
        actionType: "DELETE_RADARR",
        scheduledFor: new Date(Date.now() + 86_400_000),
        status: "PENDING",
      },
    });
    await prisma.lifecycleException.create({ data: { userId: user.id, mediaItemId: episode.id, reason: "keep" } });

    mockGetSessions.mockResolvedValue([
      {
        sessionId: "s1",
        ratingKey: movie.ratingKey,
        userId: "u1",
        username: "alice",
        userThumb: "",
        title: "Arrival",
        type: "movie",
        partFile: `${STORAGE}/movies/Arrival (2016)/Arrival.mkv`,
        partSize: 4_000_000_000,
        player: { product: "Plex Web", platform: "Chrome", state: "playing", address: "192.168.1.20", local: true },
        session: { bandwidth: 20000, location: "lan" },
      },
    ]);

    const { key } = await createTestApiKey(user.id, { scopes: [...READ_ONLY_SCOPES] });
    return { key, movie, episode, track };
  }

  it("holds for every read endpoint that returns JSON", async () => {
    const { key, movie } = await seed();

    const cases: Array<{ label: string; handler: unknown; url: string; params?: Record<string, string> }> = [
      { label: "GET /me", handler: me.GET, url: "/api/v1/me" },
      { label: "GET /system/info", handler: systemInfo.GET, url: "/api/v1/system/info" },
      { label: "GET /servers", handler: servers.GET, url: "/api/v1/servers" },
      { label: "GET /sync/status", handler: syncStatus.GET, url: "/api/v1/sync/status" },
      { label: "GET /media/movies", handler: movies.GET, url: "/api/v1/media/movies" },
      { label: "GET /media/series", handler: series.GET, url: "/api/v1/media/series" },
      { label: "GET /media/series/grouped", handler: seriesGrouped.GET, url: "/api/v1/media/series/grouped" },
      {
        label: "GET /media/series/seasons",
        handler: seriesSeasons.GET,
        url: "/api/v1/media/series/seasons?seriesKey=title%3Athe%20show",
      },
      { label: "GET /media/music", handler: music.GET, url: "/api/v1/media/music" },
      { label: "GET /media/music/grouped", handler: musicGrouped.GET, url: "/api/v1/media/music/grouped" },
      { label: "GET /media/music/albums", handler: musicAlbums.GET, url: "/api/v1/media/music/albums?parentTitle=Artist" },
      { label: "GET /media/search (movies)", handler: search.GET, url: "/api/v1/media/search?q=Arrival&type=MOVIE" },
      { label: "GET /media/search (episodes)", handler: search.GET, url: "/api/v1/media/search?q=Pilot&type=SERIES" },
      {
        label: "GET /media/search (shows)",
        handler: search.GET,
        url: "/api/v1/media/search?q=Show&type=SERIES&seriesScope=true",
      },
      { label: "GET /media/search (tracks)", handler: search.GET, url: "/api/v1/media/search?q=Song&type=MUSIC" },
      {
        label: "GET /media/search (artists)",
        handler: search.GET,
        url: "/api/v1/media/search?q=Artist&type=MUSIC&musicScope=true",
      },
      { label: "GET /media/recently-added", handler: recentlyAdded.GET, url: "/api/v1/media/recently-added" },
      { label: "GET /media/stats", handler: mediaStats.GET, url: "/api/v1/media/stats" },
      { label: "GET /media/history", handler: history.GET, url: "/api/v1/media/history" },
      { label: "GET /media/[id]", handler: mediaItem.GET, url: `/api/v1/media/${movie.id}`, params: { id: movie.id } },
      {
        label: "GET /media/[id]/plays",
        handler: mediaPlays.GET,
        url: `/api/v1/media/${movie.id}/plays`,
        params: { id: movie.id },
      },
      { label: "GET /lifecycle/rules", handler: rules.GET, url: "/api/v1/lifecycle/rules" },
      { label: "GET /lifecycle/rules/matches", handler: ruleMatches.GET, url: "/api/v1/lifecycle/rules/matches" },
      { label: "GET /lifecycle/actions", handler: actions.GET, url: "/api/v1/lifecycle/actions" },
      { label: "GET /lifecycle/exceptions", handler: exceptions.GET, url: "/api/v1/lifecycle/exceptions" },
      { label: "GET /lifecycle/stats", handler: lifecycleStats.GET, url: "/api/v1/lifecycle/stats" },
      { label: "GET /tools/sessions", handler: sessions.GET, url: "/api/v1/tools/sessions" },
      { label: "GET /tools/maintenance", handler: maintenance.GET, url: "/api/v1/tools/maintenance" },
    ];

    const leaks: string[] = [];
    const failures: string[] = [];
    for (const { label, handler, url, params } of cases) {
      const res = await callRouteWithParams(handler as Handler, params ?? {}, {
        url,
        headers: { authorization: `Bearer ${key}` },
      });
      const text = await res.text();
      if (res.status !== 200) failures.push(`${label} → ${res.status}`);
      if (text.includes(STORAGE)) leaks.push(label);
    }
    expect(failures).toEqual([]);
    expect(leaks).toEqual([]);
  });

  it("keeps what a stream listing is for: who is watching what, on which player", async () => {
    const { key } = await seed();
    const res = await callRouteWithParams(sessions.GET as unknown as Handler, {}, {
      url: "/api/v1/tools/sessions",
      headers: { authorization: `Bearer ${key}` },
    });
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(1);
    const [stream] = body.sessions;
    expect(stream).not.toHaveProperty("partFile");
    expect(stream).toMatchObject({
      sessionId: "s1",
      username: "alice",
      title: "Arrival",
      partSize: 4_000_000_000,
      player: { product: "Plex Web", address: "192.168.1.20" },
    });
  });

  it("keeps a match's own fields while dropping the stored file path", async () => {
    const { key, movie } = await seed();
    const res = await callRouteWithParams(ruleMatches.GET as unknown as Handler, {}, {
      url: "/api/v1/lifecycle/rules/matches",
      headers: { authorization: `Bearer ${key}` },
    });
    const text = await res.text();
    expect(text).not.toContain(STORAGE);
    expect(text).toContain(movie.id);
    expect(text).toContain("Arrival");
  });
});
