import { Client } from "pg";

/**
 * Seed for `history.spec.ts`, with enough plays for the History page (100 a page)
 * and a movie's play card (5 a page) to page. Every play on "Alpha Server" is
 * bob's and every one on "Bravo Server" alice's, and the episode titles run
 * AGAINST their numbers, so each sort the spec checks leads with a different row.
 * Fixed "e2e-hist-*" ids, as in `seed.ts`: seeding is idempotent, cleanup exact.
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
  userA: "bob",
  userB: "alice",
  /** The movie whose detail page the per-play card is checked on (server A). */
  detailMovieId: "e2e-hist-movie-01",
  playsPerMovie: PLAYS_PER_MOVIE,
  show: "Show Alpha",
  /** The show has no external ids, so its series key is the title key. */
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

// Out of order on purpose, so the order on screen comes from the sort.
const EPISODES: Array<{ id: string; season: number; episode: number; title: string }> = [
  { id: "e2e-hist-ep-s02e01", season: 2, episode: 1, title: "Whiskey" },
  { id: "e2e-hist-ep-s01e10", season: 1, episode: 10, title: "Xray" },
  { id: "e2e-hist-ep-s01e01", season: 1, episode: 1, title: "Zulu" },
  { id: "e2e-hist-ep-s01e02", season: 1, episode: 2, title: "Yankee" },
];

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString:
      process.env.E2E_DATABASE_URL ?? "postgresql://librariarr:librariarr@localhost:5432/librariarr_e2e",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function cleanupHistorySeed(): Promise<void> {
  await withClient(async (c) => {
    // Libraries first: Library → MediaServer is SET NULL, so deleting the
    // servers alone would orphan them. The libraries cascade to items and plays.
    await c.query(`DELETE FROM "Library" WHERE id = ANY($1)`, [[LIB_A_MOVIE, LIB_A_SERIES, LIB_B_MOVIE]]);
    await c.query(`DELETE FROM "MediaServer" WHERE id = ANY($1)`, [[SERVER_A, SERVER_B]]);
  });
}

export async function seedHistory(): Promise<void> {
  await cleanupHistorySeed();
  await withClient(async (c) => {
    const { rows } = await c.query<{ id: string }>(`SELECT id FROM "User" ORDER BY "createdAt" ASC LIMIT 1`);
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

    // An hour apart, so the default order (Watched At, newest first) is deterministic.
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
