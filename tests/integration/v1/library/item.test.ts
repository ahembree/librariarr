import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../../setup/test-db";
import { clearMockSession } from "../../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
  createTestExternalId,
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

import { GET } from "@/app/api/v1/library/items/[id]/route";

interface V1Item {
  id: string;
  libraryId: string;
  title: string;
  summary: string | null;
  type: string;
  fileSize: string | null;
  genres: string[] | null;
  streams: { id: string; streamType: number; index: number | null }[];
  externalIds: { source: string; externalId: string }[];
  library: { id: string; title: string; type: string };
  server: { id: string; name: string; type: string };
}

function itemUrl(id: string) {
  return `/api/v1/library/items/${id}`;
}

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function seedOwner() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id);
  const server = await createTestServer(user.id, { name: "Main" });
  const library = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
  return { user, raw, server, library };
}

describe("GET /api/v1/library/items/[id]", () => {
  it("404s on an unknown id", async () => {
    const { raw } = await seedOwner();

    const body = await expectJson<{ error: string }>(
      await callV1(GET, { url: itemUrl("nope"), key: raw, params: { id: "nope" } }),
      404,
    );
    expect(body.error).toBe("Media item not found");
  });

  it("404s on another user's item rather than returning it", async () => {
    const { raw } = await seedOwner();

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const theirServer = await createTestServer(stranger.id, { name: "Theirs" });
    const theirLib = await createTestLibrary(theirServer.id, { title: "Movies", type: "MOVIE" });
    const theirItem = await createTestMediaItem(theirLib.id, { title: "Not Yours" });

    // The id is real and guessable — the ownership join is the only thing
    // stopping it being handed over.
    const response = await callV1(GET, {
      url: itemUrl(theirItem.id),
      key: raw,
      params: { id: theirItem.id },
    });
    const text = await response.clone().text();
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Media item not found");
    expect(text).not.toContain("Not Yours");
  });

  it("returns the full record with its library and server projection", async () => {
    const { raw, server, library } = await seedOwner();
    const item = await createTestMediaItem(library.id, {
      title: "Heat",
      year: 1995,
      summary: "Two men on opposite sides of the law.",
      genres: ["Crime", "Drama"],
      fileSize: BigInt("21474836480"),
    });

    const body = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(item.id), key: raw, params: { id: item.id } }),
    );
    expect(body.item.id).toBe(item.id);
    expect(body.item.title).toBe("Heat");
    expect(body.item.libraryId).toBe(library.id);
    expect(body.item.library).toEqual({ id: library.id, title: "Movies", type: "MOVIE" });
    expect(body.item.server).toEqual({ id: server.id, name: "Main", type: "PLEX" });
    // Unlike the list routes, the detail view carries the synopsis.
    expect(body.item.summary).toBe("Two men on opposite sides of the law.");
    expect(body.item.genres).toEqual(["Crime", "Drama"]);
  });

  it("serializes fileSize as a string and null when absent", async () => {
    const { raw, library } = await seedOwner();
    const sized = await createTestMediaItem(library.id, {
      title: "Sized",
      fileSize: BigInt("9007199254740993"),
    });
    const bare = await getTestPrisma().mediaItem.create({
      data: { libraryId: library.id, ratingKey: "bare", title: "Bare", type: "MOVIE" },
    });

    const withSize = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(sized.id), key: raw, params: { id: sized.id } }),
    );
    expect(typeof withSize.item.fileSize).toBe("string");
    expect(withSize.item.fileSize).toBe("9007199254740993");

    const without = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(bare.id), key: raw, params: { id: bare.id } }),
    );
    expect(without.item.fileSize).toBeNull();
  });

  it("includes streams ordered by type then index", async () => {
    const { raw, library } = await seedOwner();
    const item = await createTestMediaItem(library.id, { title: "Heat" });
    await createTestMediaStream(item.id, { streamType: 3, index: 0, codec: "srt" });
    await createTestMediaStream(item.id, { streamType: 2, index: 2, codec: "eac3" });
    await createTestMediaStream(item.id, { streamType: 2, index: 1, codec: "truehd" });
    await createTestMediaStream(item.id, { streamType: 1, index: 0, codec: "hevc" });

    const body = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(item.id), key: raw, params: { id: item.id } }),
    );
    expect(body.item.streams.map((s) => [s.streamType, s.index])).toEqual([
      [1, 0],
      [2, 1],
      [2, 2],
      [3, 0],
    ]);
  });

  it("includes external ids as source/externalId pairs", async () => {
    const { raw, library } = await seedOwner();
    const item = await createTestMediaItem(library.id, { title: "Heat" });
    await createTestExternalId(item.id, "TMDB", "949");
    await createTestExternalId(item.id, "IMDB", "tt0113277");

    const body = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(item.id), key: raw, params: { id: item.id } }),
    );
    expect(body.item.externalIds).toHaveLength(2);
    expect(body.item.externalIds).toContainEqual({ source: "TMDB", externalId: "949" });
    expect(body.item.externalIds[0]).not.toHaveProperty("mediaItemId");
  });

  it("never exposes the owning server's access token", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id, { accessToken: "super-secret-plex-token" });
    const library = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { title: "Heat" });

    const text = await (
      await callV1(GET, { url: itemUrl(item.id), key: raw, params: { id: item.id } })
    ).text();
    expect(text).not.toContain("super-secret-plex-token");
    expect(text).not.toContain("accessToken");
    expect(text).not.toContain("keyHash");
  });

  it("resolves an episode and a track through the same endpoint", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    const tv = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
    const music = await createTestLibrary(server.id, { title: "Music", type: "MUSIC" });
    const episode = await createTestMediaItem(tv.id, {
      title: "Pilot",
      type: "SERIES",
      parentTitle: "Show",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const track = await createTestMediaItem(music.id, {
      title: "Angel",
      type: "MUSIC",
      parentTitle: "Massive Attack",
      albumTitle: "Mezzanine",
      episodeNumber: 2,
    });

    const gotEpisode = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(episode.id), key: raw, params: { id: episode.id } }),
    );
    expect(gotEpisode.item.type).toBe("SERIES");
    expect(gotEpisode.item.library.type).toBe("SERIES");

    const gotTrack = await expectJson<{ item: V1Item }>(
      await callV1(GET, { url: itemUrl(track.id), key: raw, params: { id: track.id } }),
    );
    expect(gotTrack.item.type).toBe("MUSIC");
    expect(gotTrack.item.library.type).toBe("MUSIC");
  });
});
