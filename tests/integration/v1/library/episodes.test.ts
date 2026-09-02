import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../../setup/test-db";
import { clearMockSession } from "../../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../../setup/test-helpers";
import { callV1 } from "../v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/library/episodes/route";
import { appCache } from "@/lib/cache/memory-cache";

interface V1Episode {
  id: string;
  title: string;
  type: string;
  parentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  fileSize: string | null;
  library: { id: string; title: string };
  server: { id: string; name: string; type: string };
}

interface EpisodeList {
  items: V1Episode[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

const URL_EPISODES = "/api/v1/library/episodes";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  appCache.clear();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedOwner() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id);
  const server = await createTestServer(user.id, { name: "Main" });
  const library = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
  return { user, raw, server, library };
}

function addEpisode(libraryId: string, show: string, season: number, episode: number) {
  return createTestMediaItem(libraryId, {
    title: `${show} S${season}E${episode}`,
    type: "SERIES",
    parentTitle: show,
    seasonNumber: season,
    episodeNumber: episode,
  });
}

describe("GET /api/v1/library/episodes", () => {
  it("returns an empty list when the user has no servers", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns episode rows with the stored SERIES type and a serialized fileSize", async () => {
    const { raw, server, library } = await seedOwner();
    await createTestMediaItem(library.id, {
      title: "Chapter One",
      type: "SERIES",
      parentTitle: "Stranger Things",
      seasonNumber: 1,
      episodeNumber: 1,
      fileSize: BigInt("4294967296"),
    });

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    const [episode] = body.items;
    expect(episode.title).toBe("Chapter One");
    expect(episode.type).toBe("SERIES");
    expect(episode.parentTitle).toBe("Stranger Things");
    expect(episode.seasonNumber).toBe(1);
    expect(episode.episodeNumber).toBe(1);
    expect(typeof episode.fileSize).toBe("string");
    expect(episode.fileSize).toBe("4294967296");
    expect(episode.library).toEqual({ id: library.id, title: "TV" });
    expect(episode.server).toEqual({ id: server.id, name: "Main", type: "PLEX" });
  });

  it("excludes movies and tracks", async () => {
    const { raw, server, library } = await seedOwner();
    const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    const music = await createTestLibrary(server.id, { title: "Music", type: "MUSIC" });
    await addEpisode(library.id, "Show", 1, 1);
    await createTestMediaItem(movies.id, { title: "A Movie" });
    await createTestMediaItem(music.id, {
      title: "A Track",
      type: "MUSIC",
      parentTitle: "Artist",
    });

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual(["Show S1E1"]);
  });

  it("orders by show, then season, then episode", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Zulu", 1, 1);
    await addEpisode(library.id, "Alpha", 2, 1);
    await addEpisode(library.id, "Alpha", 1, 2);
    await addEpisode(library.id, "Alpha", 1, 1);

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    expect(body.items.map((i) => i.title)).toEqual([
      "Alpha S1E1",
      "Alpha S1E2",
      "Alpha S2E1",
      "Zulu S1E1",
    ]);
  });

  it("narrows to one show and one season", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Alpha", 1, 1);
    await addEpisode(library.id, "Alpha", 2, 1);
    await addEpisode(library.id, "Beta", 1, 1);

    const byShow = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { series: "Alpha" } }),
    );
    expect(byShow.items.map((i) => i.title)).toEqual(["Alpha S1E1", "Alpha S2E1"]);

    const bySeason = await expectJson<EpisodeList>(
      await callV1(GET, {
        url: URL_EPISODES,
        key: raw,
        searchParams: { series: "Alpha", season: "2" },
      }),
    );
    expect(bySeason.items.map((i) => i.title)).toEqual(["Alpha S2E1"]);
  });

  it("matches the series filter exactly, not by prefix", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Alpha", 1, 1);
    await addEpisode(library.id, "Alphabet", 1, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { series: "Alpha" } }),
    );
    expect(body.items.map((i) => i.title)).toEqual(["Alpha S1E1"]);
  });

  it("supports season 0 for specials", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 0, 1);
    await addEpisode(library.id, "Show", 1, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { season: "0" } }),
    );
    expect(body.items.map((i) => i.seasonNumber)).toEqual([0]);
  });

  it("rejects a non-integer season with 400 rather than matching everything", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 1, 1);

    const body = await expectJson<{ error: string }>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { season: "latest" } }),
      400,
    );
    expect(body.error).toBe("season must be an integer");
  });

  it("treats an empty season param as unset", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 1, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { season: "" } }),
    );
    expect(body.items).toHaveLength(1);
  });

  it("searches episode titles and show titles", async () => {
    const { raw, library } = await seedOwner();
    await createTestMediaItem(library.id, {
      title: "The Sopranos Pilot",
      type: "SERIES",
      parentTitle: "The Sopranos",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    await createTestMediaItem(library.id, {
      title: "College",
      type: "SERIES",
      parentTitle: "The Sopranos",
      seasonNumber: 1,
      episodeNumber: 5,
    });
    await addEpisode(library.id, "Deadwood", 1, 1);

    const byShow = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { search: "sopranos" } }),
    );
    expect(byShow.items).toHaveLength(2);

    const byEpisode = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { search: "college" } }),
    );
    expect(byEpisode.items.map((i) => i.title)).toEqual(["College"]);
  });

  it("paginates and clamps limit to 200", async () => {
    const { raw, library } = await seedOwner();
    for (let i = 1; i <= 3; i++) await addEpisode(library.id, "Show", 1, i);

    const first = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { limit: "2" } }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.pagination).toEqual({ page: 1, limit: 2, hasMore: true });

    const second = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { limit: "2", page: "2" } }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.pagination.hasMore).toBe(false);

    const capped = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { limit: "9999" } }),
    );
    expect(capped.pagination.limit).toBe(200);
  });

  it("returns nothing for an unknown serverId", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 1, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { serverId: "nope" } }),
    );
    expect(body.items).toEqual([]);
  });

  it("never returns another user's episodes", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Mine", 1, 1);

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "TV", type: "SERIES" });
    await addEpisode(theirLib.id, "Theirs", 1, 1);

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    expect(body.items.map((i) => i.parentTitle)).toEqual(["Mine"]);

    const pointed = await expectJson<EpisodeList>(
      await callV1(GET, {
        url: URL_EPISODES,
        key: raw,
        searchParams: { serverId: theirServer.id },
      }),
    );
    expect(pointed.items).toEqual([]);
  });

  it("lists only the canonical copy once a second server holds episodes", async () => {
    const { user, raw, library } = await seedOwner();
    const second = await createTestServer(user.id, { name: "Second" });
    const secondLib = await createTestLibrary(second.id, { title: "TV", type: "SERIES" });
    const prisma = getTestPrisma();
    await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        ratingKey: "canonical",
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Show",
        seasonNumber: 1,
        episodeNumber: 1,
        dedupKey: "show-s1e1",
        dedupCanonical: true,
      },
    });
    await prisma.mediaItem.create({
      data: {
        libraryId: secondLib.id,
        ratingKey: "duplicate",
        title: "Pilot",
        type: "SERIES",
        parentTitle: "Show",
        seasonNumber: 1,
        episodeNumber: 1,
        dedupKey: "show-s1e1",
        dedupCanonical: false,
      },
    });

    const body = await expectJson<EpisodeList>(await callV1(GET, { url: URL_EPISODES, key: raw }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].server.name).toBe("Main");
  });

  // Regression: /library/series folds shows on a lower-cased, trimmed title, so
  // the title it hands back is one server's raw spelling of a name other rows
  // may spell differently. `?series=` used to match that string exactly, which
  // returned only the rows sharing its casing — so a client paging a show found
  // via /library/series silently got a subset, and episodeCount disagreed with
  // the number of episodes it could actually fetch.
  it("matches ?series= across the same casing/whitespace class the series fold merges", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "The Bear", 1, 1);
    await addEpisode(library.id, "the bear", 1, 2);
    await addEpisode(library.id, "  The Bear  ", 2, 1);
    await addEpisode(library.id, "The Bear Next Door", 1, 1);

    for (const requested of ["The Bear", "the bear", "  THE BEAR  "]) {
      const body = await expectJson<EpisodeList>(
        await callV1(GET, {
          url: URL_EPISODES,
          key: raw,
          searchParams: { series: requested },
        }),
      );
      // All three spellings of the show, and nothing from the similarly-named one.
      expect(body.items).toHaveLength(3);
      expect(body.items.every((i) => i.parentTitle?.toLowerCase().trim() === "the bear")).toBe(true);
    }
  });

  it("combines ?series= with ?season= across spellings", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "The Bear", 1, 1);
    await addEpisode(library.id, "the bear", 1, 2);
    await addEpisode(library.id, "The Bear", 2, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, {
        url: URL_EPISODES,
        key: raw,
        searchParams: { series: "THE BEAR", season: "1" },
      }),
    );
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i) => i.seasonNumber === 1)).toBe(true);
  });

  it("returns nothing for a show that does not exist rather than an unfiltered list", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "The Bear", 1, 1);

    const body = await expectJson<EpisodeList>(
      await callV1(GET, { url: URL_EPISODES, key: raw, searchParams: { series: "No Such Show" } }),
    );
    expect(body.items).toEqual([]);
  });
});
