/**
 * `importTracearrRecords` — the shared write path the re-added-item recovery
 * pass uses — against the real database: chain-id de-dup within one call,
 * the skip rules (unparseable timestamp, unjoinable record), the inserted vs
 * updated split, the monotonic merge on a re-delivered chain, the int64
 * string encoding, the empty-JSON collapse, and the mapping re-check that
 * refuses to write a stale source's plays.
 *
 * Also the importer's early exits for a server that is gone or disabled.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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
vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: vi.fn() } }));
vi.mock("@/lib/cache/invalidate", () => ({ invalidateMediaCaches: vi.fn() }));

const client = vi.hoisted(() => ({ constructed: 0 }));
vi.mock("@/lib/tracearr/tracearr-client", () => ({
  MAX_PAGE_SIZE: 100,
  // Constructor mock — must be a `function`, not an arrow (Vitest 4).
  TracearrClient: function (this: Record<string, unknown>) {
    client.constructed++;
    this.getServerAccountNames = async () => new Map();
    this.getHistoryPage = async () => ({ records: [], nextCursor: null });
    this.findOldestPlayAt = async () => null;
    this.listServers = async () => [];
  },
}));

import { importTracearrRecords, syncTracearrHistory } from "@/lib/sync/sync-tracearr-history";
import { buildTracearrJoinIndex } from "@/lib/sync/tracearr-join";
import { TracearrMappingChangedError } from "@/lib/sync/tracearr-mapping-changed";
import type { TracearrHistoryRecord } from "@/lib/tracearr/tracearr-client";

const prisma = getTestPrisma();
const T = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function record(id: string, ratingKey: string, overrides: Record<string, unknown> = {}): TracearrHistoryRecord {
  const startedAt = new Date("2026-01-10T20:00:00Z");
  return {
    id,
    reference_id: id,
    server_id: T,
    state: "stopped",
    media_type: "movie",
    rating_key: ratingKey,
    grandparent_rating_key: null,
    parent_rating_key: null,
    tmdb_id: null,
    imdb_id: null,
    tvdb_id: null,
    started_at: startedAt.toISOString(),
    stopped_at: new Date(startedAt.getTime() + 3_600_000).toISOString(),
    // A 40%-watched play of a 100-minute film; the int64 fields arrive as strings.
    duration_ms: 2_400_000,
    progress_ms: "2400000",
    total_duration_ms: "6000000",
    watched: false,
    percent_complete: 40,
    segment_count: 1,
    user: { id: "x", server_user_id: "u1", username: "Nick W" },
    ...overrides,
  } as unknown as TracearrHistoryRecord;
}

async function setup() {
  const user = await createTestUser();
  const server = await createTestServer(user.id, { type: "PLEX", tracearrServerId: T });
  const lib = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
  const a = await createTestMediaItem(lib.id, { ratingKey: "rk-a", title: "A" });
  const b = await createTestMediaItem(lib.id, { ratingKey: "rk-b", title: "B" });
  return { user, server, lib, a, b };
}

beforeEach(async () => {
  await prisma.watchHistory.deleteMany();
  await cleanDatabase();
  client.constructed = 0;
});
afterAll(async () => {
  await prisma.watchHistory.deleteMany();
  await cleanDatabase();
  await disconnectTestDb();
});

describe("buildTracearrJoinIndex", () => {
  it("loads no provider ids for episodes, which are joined on the show's rating key alone", async () => {
    const { server, a } = await setup();
    await prisma.mediaItemExternalId.create({ data: { mediaItemId: a.id, source: "TMDB", externalId: "550" } });
    const tv = await createTestLibrary(server.id, { key: "2", type: "SERIES" });
    const ep = await createTestMediaItem(tv.id, { ratingKey: "ep-1", type: "SERIES", title: "Pilot", seasonNumber: 1, episodeNumber: 1 });
    await prisma.mediaItem.update({ where: { id: ep.id }, data: { grandparentRatingKey: "show-1" } });
    await prisma.mediaItemExternalId.createMany({
      data: [
        { mediaItemId: ep.id, source: "TVDB", externalId: "81189" },
        { mediaItemId: ep.id, source: "TMDB", externalId: "1396" },
      ],
    });

    const index = await buildTracearrJoinIndex(server.id);

    expect(index.itemCount).toBe(3);
    // Only the movie's id: the episode's series-level ids are never read.
    expect(index.externalIdCount).toBe(1);
    expect([...index.byExternalId.keys()]).toEqual(["TMDB:550"]);
    expect(index.byRatingKey.get("ep-1")?.[0].providerIds.size).toBe(0);

    // The episode still resolves, by its rating key and show.
    const episodePlay = record("e1", "ep-1", { media_type: "episode", grandparent_rating_key: "show-1", tvdb_id: 999, tmdb_id: 1396 });
    await expect(
      importTracearrRecords(server.id, [episodePlay], index, new Map([["u1", "weingart"]]), T),
    ).resolves.toMatchObject({ inserted: 1 });
    // And a movie play carrying the show's TMDB number never lands on the episode.
    const moviePlay = record("m1", "unknown-rk", { tmdb_id: 1396 });
    await expect(
      importTracearrRecords(server.id, [moviePlay], index, new Map([["u1", "weingart"]]), T),
    ).resolves.toMatchObject({ inserted: 0, skipped: 1 });
  });
});

describe("importTracearrRecords", () => {
  it("writes nothing and reports zeros for an empty record set", async () => {
    const { server } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    await expect(importTracearrRecords(server.id, [], index, undefined, T)).resolves.toEqual({
      inserted: 0, updated: 0, skipped: 0, mediaItemIds: [],
    });
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("stores each chain once, skips unparseable and unjoinable records, and files plays under the account name", async () => {
    const { server, a, b } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    const result = await importTracearrRecords(
      server.id,
      [
        record("c1", "rk-a"),
        // Same chain twice in one call: one INSERT may not touch a row twice.
        record("c1", "rk-a", { percent_complete: 90 }),
        record("c2", "rk-b", { user: { id: "y", server_user_id: "gone", username: "Departed" } }),
        record("c3", "rk-a", { started_at: "not a date" }),
        record("c4", "rk-unknown"),
      ],
      index,
      new Map([["u1", "weingart"]]),
      T,
    );

    expect(result).toEqual({ inserted: 2, updated: 0, skipped: 2, mediaItemIds: expect.any(Array) });
    // The items a play landed on — what the caller's reconcile is scoped to.
    expect([...result.mediaItemIds].sort()).toEqual([a.id, b.id].sort());
    const rows = await prisma.watchHistory.findMany({ orderBy: { sourceEventId: "asc" } });
    expect(rows.map((r) => [r.sourceEventId, r.mediaItemId, r.serverUsername, r.source])).toEqual([
      ["c1", a.id, "weingart", "TRACEARR"],
      // No account-map entry: Tracearr's identity label is the only name there is.
      ["c2", b.id, "Departed", "TRACEARR"],
    ]);
    // The FIRST sighting of a chain within a call wins.
    expect(rows[0].percentComplete).toBe(40);
  });

  it("counts a re-delivered chain as updated and merges it without regressing play state", async () => {
    const { server } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    const names = new Map([["u1", "weingart"]]);

    await importTracearrRecords(
      server.id,
      [record("c1", "rk-a", { watched: true, percent_complete: 95, segment_count: 3, is_transcode: true })],
      index, names, T,
    );
    // A narrower view of the same chain (truncated by a `since` window).
    const second = await importTracearrRecords(
      server.id,
      [record("c1", "rk-a", { watched: false, percent_complete: 12, segment_count: 1, is_transcode: false })],
      index, names, T,
    );

    expect(second).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });
    expect(second.mediaItemIds).toHaveLength(1);
    const row = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "c1" } });
    expect(row.watched).toBe(true);
    expect(row.percentComplete).toBe(95);
    expect(row.segmentCount).toBe(3);
    expect(row.isTranscode).toBe(true);
    expect(await prisma.watchHistory.count()).toBe(1);
  });

  it("reads int64 fields sent as JSON strings, refuses empty strings, and stores no empty JSON", async () => {
    const { server } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    await importTracearrRecords(
      server.id,
      [
        record("c1", "rk-a", {
          progress_ms: "110500",
          total_duration_ms: "",
          duration_ms: 7.6,
          bitrate: "abc",
          transcode_info: {},
          subtitle_info: { codec: "srt" },
          source_video_width: 1920,
          stream_video_codec_display: "H.264",
        }),
        record("c2", "rk-b", { transcode_info: null }),
      ],
      index, undefined, T,
    );

    const c1 = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "c1" } });
    expect(c1.progressMs).toBe(110500);
    expect(c1.totalDurationMs).toBeNull();
    expect(c1.durationMs).toBe(8);
    expect(c1.bitrate).toBeNull();
    expect(c1.transcodeInfo).toBeNull();
    expect(c1.subtitleInfo).toEqual({ codec: "srt" });
    expect(c1.streamQuality).toEqual({ sourceVideoWidth: 1920, streamVideoCodecDisplay: "H.264" });

    const c2 = await prisma.watchHistory.findFirstOrThrow({ where: { sourceEventId: "c2" } });
    // A record with no stream detail at all reads as "none", not `{}`.
    expect(c2.streamQuality).toBeNull();
    expect(c2.transcodeInfo).toBeNull();
  });

  it("refuses to write once the server is no longer mapped to the Tracearr server the records came from", async () => {
    const { server } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    await prisma.mediaServer.update({
      where: { id: server.id },
      data: { tracearrServerId: "99999999-9999-9999-9999-999999999999" },
    });

    await expect(
      importTracearrRecords(server.id, [record("c1", "rk-a")], index, undefined, T),
    ).rejects.toBeInstanceOf(TracearrMappingChangedError);
    expect(await prisma.watchHistory.count()).toBe(0);
  });

  it("drops a row whose media item was deleted after the join index was built", async () => {
    const { server, a } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    await prisma.mediaItem.delete({ where: { id: a.id } });

    const result = await importTracearrRecords(
      server.id,
      [record("c1", "rk-a"), record("c2", "rk-b")],
      index, undefined, T,
    );
    expect(result).toMatchObject({ inserted: 1, updated: 0, skipped: 0 });
    // The vanished item is not among those reported written.
    expect(result.mediaItemIds).not.toContain(a.id);
    expect(result.mediaItemIds).toHaveLength(1);
    expect((await prisma.watchHistory.findMany()).map((r) => r.sourceEventId)).toEqual(["c2"]);
  });

  it("writes nothing when every row's media item has gone", async () => {
    const { server, a } = await setup();
    const index = await buildTracearrJoinIndex(server.id);
    await prisma.mediaItem.delete({ where: { id: a.id } });

    await expect(
      importTracearrRecords(server.id, [record("c1", "rk-a")], index, undefined, T),
    ).resolves.toEqual({ inserted: 0, updated: 0, skipped: 0, mediaItemIds: [] });
    expect(await prisma.watchHistory.count()).toBe(0);
  });
});

describe("syncTracearrHistory early exits", () => {
  it("does nothing for a server that does not exist", async () => {
    await expect(syncTracearrHistory("no-such-server")).resolves.toEqual({
      count: 0, backfillPending: false,
    });
    expect(client.constructed).toBe(0);
  });

  it("does nothing for a disabled server, even one with a mapping", async () => {
    const { server } = await setup();
    await prisma.mediaServer.update({ where: { id: server.id }, data: { enabled: false } });
    await expect(syncTracearrHistory(server.id)).resolves.toEqual({
      count: 0, backfillPending: false,
    });
    expect(client.constructed).toBe(0);
    expect(await prisma.watchHistory.count()).toBe(0);
  });
});
