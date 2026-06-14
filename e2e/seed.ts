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
       VALUES ($1, $2, 'PLEX', $3, 'http://seed.local:32400', 'e2e-seed-token', true, NOW(), NOW())`,
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
       VALUES ($1, $2, 'e2e-rk-1', $3, $4, 'MOVIE', '4K', 'HEVC', 'AAC', 'HDR10',
               2147483648, 7200000, 'A seeded movie for E2E tests.', NOW(),
               'movie:title:e2e seed movie:2021', NOW(), NOW())`,
      [SEED.movieId, MOVIE_LIB_ID, SEED.movieTitle, SEED.movieYear],
    );
  });
}
