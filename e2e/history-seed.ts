import { Client } from "pg";

/**
 * Seed for `history.spec.ts`: two servers, movies and one show's episodes,
 * and enough `WatchHistory` rows to make the History page (100 plays a page)
 * and a movie's per-play card (5 a page) both page.
 *
 * Built so each sort the spec checks gives a different first row:
 *   - every play on "Alpha Server" is by `bob`, every play on "Bravo Server"
 *     by `alice` — so User ascending leads with alice/Bravo while Server
 *     ascending leads with bob/Alpha (a Server header that sorted by user
 *     would show alice first);
 *   - the show's episode titles run AGAINST its episode numbers (Zulu is
 *     S01E01, Whiskey S02E01), and every movie title starts with "Title", so a
 *     title sort by show then SxxExx leads with the episodes in episode order,
 *     where a sort by the raw episode title would reverse them.
 *
 * Same conventions as `seed.ts`: fixed "e2e-hist-*" ids so seeding is
 * idempotent and cleanup exact (deleting the servers' libraries cascades the
 * items and their plays), enum values inlined as SQL literals.
 */

const SERVER_A = "e2e-hist-server-a";
const SERVER_B = "e2e-hist-server-b";
const LIB_A_MOVIE = "e2e-hist-lib-a-movie";
const LIB_A_SERIES = "e2e-hist-lib-a-series";
const LIB_B_MOVIE = "e2e-hist-lib-b-movie";

const PLAYS_PER_MOVIE = 12;

export const HISTORY_SEED = {
  serverA: "Alpha Server",
  serverB: "Bravo Server",
  /** Plays on server A. */
  userA: "bob",
  /** Plays on server B. */
  userB: "alice",
  /** The movie whose detail page the per-play card is checked on (server A). */
  detailMovieId: "e2e-hist-movie-01",
  detailMovieTitle: "Title 01",
  playsPerMovie: PLAYS_PER_MOVIE,
  show: "Show Alpha",
  /** The show's series identity: it has no external ids, so the title key. */
  seriesKey: "title:show alpha",
  /** S01E01, whose id opens the show, season and episode detail pages. */
  episodeId: "e2e-hist-ep-s01e01",
  /** The episodes' displayed titles in show-then-SxxExx order. */
  episodesInOrder: [
    "Show Alpha - S01E01 - Zulu",
    "Show Alpha - S01E02 - Yankee",
    "Show Alpha - S01E10 - Xray",
    "Show Alpha - S02E01 - Whiskey",
  ],
  /** 10 movies × 12 plays + 4 episode plays. */
  totalPlays: 10 * PLAYS_PER_MOVIE + 4,
} as const;

const EPISODES: Array<{ id: string; season: number; episode: number; title: string }> = [
  // Inserted out of order on purpose, so row order on screen comes from the
  // sort and not from insertion order.
  { id: "e2e-hist-ep-s02e01", season: 2, episode: 1, title: "Whiskey" },
  { id: "e2e-hist-ep-s01e10", season: 1, episode: 10, title: "Xray" },
  { id: "e2e-hist-ep-s01e01", season: 1, episode: 1, title: "Zulu" },
  { id: "e2e-hist-ep-s01e02", season: 1, episode: 2, title: "Yankee" },
];

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

export async function cleanupHistorySeed(): Promise<void> {
  await withClient(async (c) => {
    // Libraries first: the Library → MediaServer FK is SET NULL, so deleting
    // the servers alone would orphan the libraries rather than remove them.
    await c.query(`DELETE FROM "Library" WHERE id = ANY($1)`, [[LIB_A_MOVIE, LIB_A_SERIES, LIB_B_MOVIE]]);
    await c.query(`DELETE FROM "MediaServer" WHERE id = ANY($1)`, [[SERVER_A, SERVER_B]]);
  });
}

export async function seedHistory(): Promise<void> {
  await cleanupHistorySeed();
  await withClient(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM "User" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    if (rows.length === 0) throw new Error("No admin user found to own seed data");
    const userId = rows[0].id;

    for (const [id, name] of [[SERVER_A, HISTORY_SEED.serverA], [SERVER_B, HISTORY_SEED.serverB]]) {
      await c.query(
        `INSERT INTO "MediaServer"
           (id, "userId", type, name, url, "accessToken", enabled, "watchHistorySyncedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 'PLEX', $3, 'http://seed.local:32400', 'e2e-seed-token', true, NOW(), NOW(), NOW())`,
        [id, userId, name],
      );
    }
    for (const [id, serverId, key, type] of [
      [LIB_A_MOVIE, SERVER_A, "hist-a-movies", "MOVIE"],
      [LIB_A_SERIES, SERVER_A, "hist-a-series", "SERIES"],
      [LIB_B_MOVIE, SERVER_B, "hist-b-movies", "MOVIE"],
    ]) {
      await c.query(
        `INSERT INTO "Library" (id, "mediaServerId", key, title, type, enabled, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $3, '${type}', true, NOW(), NOW())`,
        [id, serverId, key],
      );
    }

    // Play timestamps step back an hour per play from a fixed base, so every
    // row has a distinct watchedAt and the default (Watched At, newest first)
    // order is deterministic.
    let playIndex = 0;
    const nextPlay = async (mediaItemId: string, serverId: string, username: string) => {
      playIndex += 1;
      await c.query(
        `INSERT INTO "WatchHistory"
           (id, "mediaItemId", "mediaServerId", "serverUsername", "watchedAt", "deviceName", platform, "createdAt")
         VALUES ($1, $2, $3, $4, TIMESTAMP '2024-06-01 12:00:00' - ($5 * INTERVAL '1 hour'), $6, 'Chrome', NOW())`,
        [`e2e-hist-play-${String(playIndex).padStart(3, "0")}`, mediaItemId, serverId, username, playIndex, `Device ${playIndex}`],
      );
    };

    // Ten movies: Title 01–05 on Alpha (bob), Title 06–10 on Bravo (alice).
    for (let n = 1; n <= 10; n++) {
      const onA = n <= 5;
      const id = `e2e-hist-movie-${String(n).padStart(2, "0")}`;
      const title = `Title ${String(n).padStart(2, "0")}`;
      await c.query(
        `INSERT INTO "MediaItem"
           (id, "libraryId", "ratingKey", title, year, type, "addedAt", "dedupKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 2020, 'MOVIE', NOW(), $5, NOW(), NOW())`,
        [id, onA ? LIB_A_MOVIE : LIB_B_MOVIE, `hist-rk-${n}`, title, `movie:title:${title.toLowerCase()}:2020`],
      );
      for (let p = 0; p < PLAYS_PER_MOVIE; p++) {
        await nextPlay(id, onA ? SERVER_A : SERVER_B, onA ? HISTORY_SEED.userA : HISTORY_SEED.userB);
      }
    }

    for (const ep of EPISODES) {
      await c.query(
        `INSERT INTO "MediaItem"
           (id, "libraryId", "ratingKey", title, "parentTitle", "seasonNumber", "episodeNumber",
            type, "seriesKey", "addedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'SERIES', $8, NOW(), NOW(), NOW())`,
        [ep.id, LIB_A_SERIES, `hist-${ep.id}`, ep.title, HISTORY_SEED.show, ep.season, ep.episode, HISTORY_SEED.seriesKey],
      );
      await nextPlay(ep.id, SERVER_A, HISTORY_SEED.userA);
    }
  });
}
