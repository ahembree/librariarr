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

import { GET } from "@/app/api/v1/library/series/route";
import { appCache } from "@/lib/cache/memory-cache";

interface V1Series {
  title: string;
  episodeCount: number;
  seasonCount: number;
  totalSize: string;
  year: number | null;
}

interface SeriesList {
  items: V1Series[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

const URL_SERIES = "/api/v1/library/series";

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

async function addEpisode(
  libraryId: string,
  show: string,
  season: number,
  episode: number,
  overrides: { year?: number; fileSize?: bigint } = {},
) {
  return createTestMediaItem(libraryId, {
    title: `${show} S${season}E${episode}`,
    type: "SERIES",
    parentTitle: show,
    seasonNumber: season,
    episodeNumber: episode,
    year: overrides.year ?? 2020,
    fileSize: overrides.fileSize ?? BigInt(1000),
  });
}

describe("GET /api/v1/library/series", () => {
  it("returns an empty list when the user has no servers", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("collapses episodes into one row per show", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Severance", 1, 1);
    await addEpisode(library.id, "Severance", 1, 2);
    await addEpisode(library.id, "Severance", 2, 1);
    await addEpisode(library.id, "Andor", 1, 1);

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items.map((s) => s.title)).toEqual(["Andor", "Severance"]);

    const severance = body.items[1];
    expect(severance.episodeCount).toBe(3);
    expect(severance.seasonCount).toBe(2);
    // Exactly the five aggregate keys — an episode-shaped field leaking in here
    // would make the row ambiguous.
    expect(Object.keys(severance).sort()).toEqual([
      "episodeCount",
      "seasonCount",
      "title",
      "totalSize",
      "year",
    ]);
  });

  it("sums fileSize as a string and reports the earliest year", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 1, 1, { year: 2015, fileSize: BigInt(1500) });
    await addEpisode(library.id, "Show", 1, 2, { year: 2019, fileSize: BigInt(2500) });

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(typeof body.items[0].totalSize).toBe("string");
    expect(body.items[0].totalSize).toBe("4000");
    expect(body.items[0].year).toBe(2015);
  });

  it("reports '0' and a null year when no episode carries them", async () => {
    const { raw, library } = await seedOwner();
    const prisma = getTestPrisma();
    await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        ratingKey: "bare-1",
        title: "Bare S1E1",
        type: "SERIES",
        parentTitle: "Bare",
        seasonNumber: 1,
      },
    });

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items[0].totalSize).toBe("0");
    expect(body.items[0].year).toBeNull();
  });

  it("counts only distinct non-null seasons", async () => {
    const { raw, library } = await seedOwner();
    const prisma = getTestPrisma();
    await addEpisode(library.id, "Show", 1, 1);
    await addEpisode(library.id, "Show", 1, 2);
    await prisma.mediaItem.create({
      data: {
        libraryId: library.id,
        ratingKey: "special",
        title: "Special",
        type: "SERIES",
        parentTitle: "Show",
      },
    });

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items[0].episodeCount).toBe(3);
    expect(body.items[0].seasonCount).toBe(1);
  });

  it("folds titles that differ only in casing into one show", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "The Wire", 1, 1);
    await addEpisode(library.id, "the wire", 1, 2);

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items).toHaveLength(1);
    expect(body.items[0].episodeCount).toBe(2);
  });

  it("ignores rows that are not episodes", async () => {
    const { raw, server, library } = await seedOwner();
    const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    await addEpisode(library.id, "Show", 1, 1);
    await createTestMediaItem(movies.id, { title: "A Movie" });
    await getTestPrisma().mediaItem.create({
      data: {
        libraryId: library.id,
        ratingKey: "orphan",
        title: "Orphan",
        type: "SERIES",
      },
    });

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items.map((s) => s.title)).toEqual(["Show"]);
    expect(body.items[0].episodeCount).toBe(1);
  });

  it("searches on the show title", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Severance", 1, 1);
    await addEpisode(library.id, "Andor", 1, 1);

    const body = await expectJson<SeriesList>(
      await callV1(GET, { url: URL_SERIES, key: raw, searchParams: { search: "sever" } }),
    );
    expect(body.items.map((s) => s.title)).toEqual(["Severance"]);
  });

  it("paginates the folded rows", async () => {
    const { raw, library } = await seedOwner();
    for (const show of ["A Show", "B Show", "C Show"]) {
      await addEpisode(library.id, show, 1, 1);
    }

    const first = await expectJson<SeriesList>(
      await callV1(GET, { url: URL_SERIES, key: raw, searchParams: { limit: "2" } }),
    );
    expect(first.items.map((s) => s.title)).toEqual(["A Show", "B Show"]);
    expect(first.pagination.hasMore).toBe(true);

    const second = await expectJson<SeriesList>(
      await callV1(GET, { url: URL_SERIES, key: raw, searchParams: { limit: "2", page: "2" } }),
    );
    expect(second.items.map((s) => s.title)).toEqual(["C Show"]);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("clamps limit to 200", async () => {
    const { raw } = await seedOwner();
    const body = await expectJson<SeriesList>(
      await callV1(GET, { url: URL_SERIES, key: raw, searchParams: { limit: "1000" } }),
    );
    expect(body.pagination.limit).toBe(200);
  });

  it("returns nothing for an unknown serverId", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Show", 1, 1);

    const body = await expectJson<SeriesList>(
      await callV1(GET, { url: URL_SERIES, key: raw, searchParams: { serverId: "nope" } }),
    );
    expect(body.items).toEqual([]);
  });

  it("never returns another user's shows", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Mine", 1, 1);

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "TV", type: "SERIES" });
    await addEpisode(theirLib.id, "Theirs", 1, 1);

    const body = await expectJson<SeriesList>(await callV1(GET, { url: URL_SERIES, key: raw }));
    expect(body.items.map((s) => s.title)).toEqual(["Mine"]);
  });

  it("cannot be pointed at another user's server", async () => {
    const { raw, library } = await seedOwner();
    await addEpisode(library.id, "Mine", 1, 1);

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "TV", type: "SERIES" });
    await addEpisode(theirLib.id, "Theirs", 1, 1);

    const body = await expectJson<SeriesList>(
      await callV1(GET, {
        url: URL_SERIES,
        key: raw,
        searchParams: { serverId: theirServer.id },
      }),
    );
    expect(body.items).toEqual([]);
  });
});
