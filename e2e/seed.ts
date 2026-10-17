import type { APIRequestContext } from "@playwright/test";
import { Client } from "pg";

/**
 * Direct-to-DB seeding for the data-dependent specs. The production e2e image
 * has no seed endpoint, so we insert a minimal but complete media stack
 * (server → library → item) the same way global-setup talks to Postgres.
 *
 * Single-server listings skip dedup-canonical filtering (see resolveServerFilter),
 * so one server + one library + one item is enough to render a populated view.
 *
 * IDs are fixed and namespaced ("e2e-seed-*") so seeding is idempotent and
 * cleanup is exact. Enum values are inlined as SQL literals (not bound params)
 * because a bound text param will not implicitly cast to a Postgres enum column.
 * Column values are spelled the way the sync stores them (Plex's lower-case
 * codecs and resolution, `computeDedupKey`'s keys, series-level TVDB ids on
 * every episode), and every seeded server points at 127.0.0.1:1, which
 * refuses at once instead of waiting on a DNS lookup.
 */

const SERVER_ID = "e2e-seed-server";
const MOVIE_LIB_ID = "e2e-seed-lib-movie";
export const SEED = {
  serverName: "E2E Seed Server",
  movieId: "e2e-seed-movie-1",
  movieTitle: "E2E Seed Movie",
  movieYear: 2021,
} as const;

function databaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL ??
    "postgresql://librariarr:librariarr@localhost:5432/librariarr_e2e"
  );
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * The seed writes straight to Postgres, past the app's in-memory caches, which
 * a sync would have dropped. A spec reading a cached answer (the filter facets
 * are cached for 5 minutes, and an earlier spec loaded them over the empty
 * database) drops them the way the app itself does: by saving a setting that
 * changes every listing — the dedup toggle, saved unchanged.
 */
export async function dropAppCaches(request: APIRequestContext): Promise<void> {
  const current = await request.get("/api/settings/dedup");
  if (!current.ok()) throw new Error(`GET /api/settings/dedup answered ${current.status()}`);
  const { dedupStats } = (await current.json()) as { dedupStats: boolean };
  const saved = await request.put("/api/settings/dedup", { data: { dedupStats } });
  if (!saved.ok()) throw new Error(`PUT /api/settings/dedup answered ${saved.status()}`);
}

/** Remove any previously seeded rows. Deleting the library cascades its items. */
export async function cleanupSeed(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DELETE FROM "Library" WHERE id = $1`, [MOVIE_LIB_ID]);
    await c.query(`DELETE FROM "MediaServer" WHERE id = $1`, [SERVER_ID]);
  });
}

/** Insert the seed stack owned by the (single) admin user. Idempotent. */
export async function seedMovieLibrary(): Promise<void> {
  await cleanupSeed();
  await withClient(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM "User" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    if (rows.length === 0) throw new Error("No admin user found to own seed data");
    const userId = rows[0].id;

    await c.query(
      `INSERT INTO "MediaServer"
         (id, "userId", type, name, url, "accessToken", enabled, "createdAt", "updatedAt")
       VALUES ($1, $2, 'PLEX', $3, 'http://127.0.0.1:1', 'e2e-seed-token', true, NOW(), NOW())`,
      [SERVER_ID, userId, SEED.serverName],
    );

    await c.query(
      `INSERT INTO "Library"
         (id, "mediaServerId", key, title, type, enabled, "createdAt", "updatedAt")
       VALUES ($1, $2, 'e2e-movies', 'E2E Movies', 'MOVIE', true, NOW(), NOW())`,
      [MOVIE_LIB_ID, SERVER_ID],
    );

    await c.query(
      `INSERT INTO "MediaItem"
         (id, "libraryId", "ratingKey", title, year, type, resolution, "videoCodec",
          "audioCodec", "dynamicRange", "fileSize", duration, summary, "addedAt",
          "dedupKey", "createdAt", "updatedAt")
       VALUES ($1, $2, 'e2e-rk-1', $3, $4, 'MOVIE', '4k', 'hevc', 'aac', 'HDR10',
               2147483648, 7200000, 'A seeded movie for E2E tests.', NOW(),
               'movie:title:e2e seed movie:2021', NOW(), NOW())`,
      [SEED.movieId, MOVIE_LIB_ID, SEED.movieTitle, SEED.movieYear],
    );
  });
}

/**
 * A media server nothing listens for (`127.0.0.1:1` refuses at once), for the
 * specs that need work the job worker or the realtime manager does on a real
 * server row — a sync that fails, a WebSocket that cannot connect.
 */
export const UNREACHABLE_SERVER = {
  id: "e2e-unreachable-server",
  name: "E2E Unreachable Server",
} as const;

interface SeedServer {
  id: string;
  name: string;
}

export async function seedUnreachableServer(server: SeedServer = UNREACHABLE_SERVER): Promise<void> {
  await cleanupUnreachableServer(server);
  await withClient(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM "User" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    if (rows.length === 0) throw new Error("No admin user found to own seed data");
    await c.query(
      `INSERT INTO "MediaServer"
         (id, "userId", type, name, url, "accessToken", enabled, "createdAt", "updatedAt")
       VALUES ($1, $2, 'PLEX', $3, 'http://127.0.0.1:1', 'e2e-unreachable-token', true, NOW(), NOW())`,
      [server.id, rows[0].id, server.name],
    );
  });
}

/** Remove the server and any retry of its sync still queued in the worker. */
export async function cleanupUnreachableServer(server: SeedServer = UNREACHABLE_SERVER): Promise<void> {
  await withClient(async (c) => {
    await c
      .query(`SELECT graphile_worker.remove_job($1)`, [`sync:${server.id}`])
      .catch(() => undefined); // schema absent before the worker's first start
    await c.query(`DELETE FROM "MediaServer" WHERE id = $1`, [server.id]);
  });
}

/**
 * A SERIES library (one show, two episodes in season 1) and a MUSIC library
 * (one artist, one album, two tracks) on their own server, for the detail
 * pages that group rows: show / season / episode and artist / album / track.
 */
const GROUPED_SERVER_ID = "e2e-seed-grouped-server";
const SERIES_LIB_ID = "e2e-seed-lib-series";
const MUSIC_LIB_ID = "e2e-seed-lib-music";
export const GROUPED_SEED = {
  serverName: "E2E Grouped Server",
  showTitle: "E2E Seed Show",
  seriesKey: "tvdb:990001",
  episodes: [
    { id: "e2e-seed-ep-1", title: "Seed Pilot", season: 1, episode: 1 },
    { id: "e2e-seed-ep-2", title: "Seed Second", season: 1, episode: 2 },
  ],
  artistTitle: "E2E Seed Artist",
  albumTitle: "E2E Seed Album",
  tracks: [
    { id: "e2e-seed-track-1", title: "Seed First Track", number: 1 },
    { id: "e2e-seed-track-2", title: "Seed Second Track", number: 2 },
  ],
} as const;

export async function cleanupGroupedSeed(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DELETE FROM "Library" WHERE id = ANY($1)`, [[SERIES_LIB_ID, MUSIC_LIB_ID]]);
    await c.query(`DELETE FROM "MediaServer" WHERE id = $1`, [GROUPED_SERVER_ID]);
  });
}

export async function seedGroupedLibraries(): Promise<void> {
  await cleanupGroupedSeed();
  await withClient(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM "User" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    if (rows.length === 0) throw new Error("No admin user found to own seed data");

    await c.query(
      `INSERT INTO "MediaServer"
         (id, "userId", type, name, url, "accessToken", enabled, "createdAt", "updatedAt")
       VALUES ($1, $2, 'PLEX', $3, 'http://127.0.0.1:1', 'e2e-seed-token', true, NOW(), NOW())`,
      [GROUPED_SERVER_ID, rows[0].id, GROUPED_SEED.serverName],
    );
    await c.query(
      `INSERT INTO "Library" (id, "mediaServerId", key, title, type, enabled, "createdAt", "updatedAt")
       VALUES ($1, $3, 'e2e-series', 'E2E Series', 'SERIES', true, NOW(), NOW()),
              ($2, $3, 'e2e-music', 'E2E Music', 'MUSIC', true, NOW(), NOW())`,
      [SERIES_LIB_ID, MUSIC_LIB_ID, GROUPED_SERVER_ID],
    );

    for (const ep of GROUPED_SEED.episodes) {
      await c.query(
        `INSERT INTO "MediaItem"
           (id, "libraryId", "ratingKey", title, "parentTitle", "seriesKey", "seasonNumber",
            "episodeNumber", year, type, resolution, "fileSize", duration, "addedAt",
            "dedupKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 2020, 'SERIES', '1080', 1073741824, 2700000,
                 NOW(), $9, NOW(), NOW())`,
        [
          ep.id, SERIES_LIB_ID, `${ep.id}-rk`, ep.title, GROUPED_SEED.showTitle,
          GROUPED_SEED.seriesKey, ep.season, ep.episode,
          `series:${GROUPED_SEED.seriesKey}:s${ep.season}e${ep.episode}`,
        ],
      );
      // The show's TVDB id, which the sync stores on every episode and
      // derives `seriesKey` from.
      await c.query(
        `INSERT INTO "MediaItemExternalId" (id, "mediaItemId", source, "externalId")
         VALUES ($1, $2, 'TVDB', $3)`,
        [`${ep.id}-tvdb`, ep.id, GROUPED_SEED.seriesKey.replace(/^tvdb:/, "")],
      );
    }

    for (const track of GROUPED_SEED.tracks) {
      await c.query(
        `INSERT INTO "MediaItem"
           (id, "libraryId", "ratingKey", title, "parentTitle", "albumTitle", "episodeNumber",
            year, type, "audioCodec", "fileSize", duration, "addedAt", "dedupKey",
            "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 2019, 'MUSIC', 'flac', 31457280, 240000,
                 NOW(), $8, NOW(), NOW())`,
        [
          track.id, MUSIC_LIB_ID, `${track.id}-rk`, track.title, GROUPED_SEED.artistTitle,
          GROUPED_SEED.albumTitle, track.number,
          `music:${GROUPED_SEED.artistTitle.toLowerCase()}:${track.title.toLowerCase()}`,
        ],
      );
    }
  });
}
