import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import { buildTracearrJoinIndex } from "@/lib/sync/tracearr-join";
import {
  importTracearrRecords,
  resolveInstanceForServer,
} from "@/lib/sync/sync-tracearr-history";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { IntegrationError } from "@/lib/integration-error";
import { isHostLevelFailure } from "@/lib/lifecycle/unreachable-instances";
import { formatMediaItemTitle } from "@/lib/media/display-title";
import { TracearrMappingChangedError } from "@/lib/sync/tracearr-mapping-changed";

/**
 * Recover the watch history of an item that left the library and came back.
 *
 * `WatchHistory.mediaItem` is a required FK with `onDelete: Cascade`, so
 * deleting a `MediaItem` — a full sync's stale purge, the incremental sync's
 * removal path, a manual purge — takes every play of it with it. When the file
 * returns (a re-download, a library moved between servers, a rename that made
 * the sync see a delete plus an add) the sync creates a *fresh* row with
 * `playCount 0` and `lastPlayedAt null`.
 *
 * That is not a cosmetic gap. Those are the two columns
 * `watch-reconcile.ts` maintains and the two the lifecycle engine reads, so a
 * re-added item reads as **never watched** — exactly the state a "not played in
 * N months" or `playCount = 0` DELETE rule is written to act on. The household
 * finished the series last month; the rule deletes it this month.
 *
 * The archive backfill cannot fix this. Once `tracearrBackfillComplete` is set,
 * only the forward pass runs (one hour of overlap), and the plays being
 * recovered here are old by definition — they are exactly the ones the backfill
 * already walked past, while the item they belonged to was absent and its
 * records were skipped as `unresolved`. Tracearr still holds them; they just
 * need asking for again, by name.
 *
 * **Why this is bounded rather than a sweep.** `/api/v2/public/history` takes
 * `rating_key` as a single value, not a list, so a targeted lookup costs one
 * request per item against an API that rate-limits per key on a rolling
 * 1-minute window. An unbounded pass over a large library would be thousands of
 * requests, every run, forever. Both bounds below are what keep it honest.
 */

/**
 * How recently an item must have been added to be worth a targeted lookup.
 *
 * This is the bound that makes the pass self-limiting **without any new state
 * to keep**. An item that existed while the archive walk ran was already
 * considered by it: if Tracearr had plays for it, they were imported, and if it
 * has none it genuinely has none. Only an item that arrived *after* that walk
 * can be holding recoverable history, and one that arrived long ago has had
 * every run since to be recovered.
 *
 * Without this window the candidate set is "every item with no Tracearr plays",
 * which for a real library is most of it — the untouched back catalogue — and
 * every one of those items would be re-queried on every single run, forever,
 * to learn the same "no plays" answer each time.
 */
export const RECENT_ADDITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many items one pass may ask about, and therefore how many requests it may
 * issue: `rating_key` takes one value per request, so this cap IS the request
 * budget. 200 is a large re-add (a re-imported season, a library moved between
 * servers) while staying well inside a slice.
 *
 * Anything above the cap is not lost, only deferred: the candidate query orders
 * newest-first, skips the items an earlier pass already got an answer for (see
 * `answeredItems`), and the pass runs every backfill slice, so the remainder is
 * picked up next time — for as long as it stays inside the window above.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200;

/**
 * Items Tracearr has already ANSWERED for — item id → when.
 *
 * Without it the cap starved the window. An item that was never played gets no
 * Tracearr row, so it stays a candidate for its whole seven days, and the
 * candidate query orders newest-first: once more than the cap's worth of
 * recent items had no plays (the normal state after a purge-and-resync, a
 * restore or a library move — exactly when recovery matters), every pass asked
 * about the same newest unplayed items again and never reached the re-added
 * ones further down, which then aged out of the window still reading as never
 * watched.
 *
 * One answer per item is enough. The plays this pass exists to recover are OLD
 * ones; a play that happens after the item was added is imported by the
 * forward pass like any other. Only an answer is recorded — a lookup that
 * failed leaves the item a candidate. In memory on purpose: a restart merely
 * re-asks, and entries expire with the window, so the map holds at most a
 * week's worth of additions. Pinned to `globalThis` like the other registries
 * a job and the rest of the app may both load.
 */
const answeredItems: Map<string, number> = ((
  globalThis as unknown as { __tracearrRecoveryAnswered?: Map<string, number> }
).__tracearrRecoveryAnswered ??= new Map());

/** Drop answers older than the candidate window, and return the live ids. */
function liveAnsweredIds(now: number): string[] {
  const ids: string[] = [];
  for (const [id, at] of answeredItems) {
    if (now - at > RECENT_ADDITION_WINDOW_MS) answeredItems.delete(id);
    else ids.push(id);
  }
  return ids;
}

/** Test seam: forget every recorded answer. */
export function resetRecoveryAnswers(): void {
  answeredItems.clear();
}

/** A caller cannot opt out of the request budget, only ask for less of it. */
export const MAX_CANDIDATE_LIMIT = 500;

export interface RecoverNewItemHistoryOptions {
  /** Candidate cap for this pass; clamped to `MAX_CANDIDATE_LIMIT`. */
  limit?: number;
  /**
   * Cancels the pass between items (and interrupts an in-flight request plus
   * any rate-limit backoff). Stopping early is a normal outcome: every item
   * imported so far is committed, and the candidate query re-derives what is
   * left from the rows themselves, so the next run simply picks up the ones
   * that still have no Tracearr plays.
   */
  signal?: AbortSignal;
}

export interface RecoverNewItemHistoryResult {
  /** Items actually asked about — i.e. requests issued. */
  checked: number;
  /** `WatchHistory` rows written (inserted or merged) across those items. */
  imported: number;
}

/** One candidate: a recently added item with no Tracearr plays of its own. */
interface CandidateItem {
  id: string;
  ratingKey: string;
  tmdbId: string | null;
  imdbId: string | null;
  // What names it in a log line: an episode by its show and SxxExx.
  title: string;
  type: string;
  parentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export async function recoverHistoryForNewItems(
  serverId: string,
  options: RecoverNewItemHistoryOptions = {},
): Promise<RecoverNewItemHistoryResult> {
  const { limit = DEFAULT_CANDIDATE_LIMIT, signal } = options;
  const empty: RecoverNewItemHistoryResult = { checked: 0, imported: 0 };

  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId },
    select: {
      id: true,
      name: true,
      enabled: true,
      tracearrServerId: true,
      userId: true,
    },
  });

  if (!server || !server.enabled) return empty;
  const tracearrServerId = server.tracearrServerId;
  if (!tracearrServerId) return empty;

  // The candidate query comes FIRST, before instance resolution and before the
  // join index, because the steady state is zero candidates — nothing has been
  // re-added — and that state must cost one indexed query and nothing else.
  const candidates = await findCandidates(serverId, limit);
  if (candidates.length === 0) return empty;

  const instance = await resolveInstanceForServer(
    server.userId,
    tracearrServerId,
    server.name,
  );
  if (!instance) return empty;

  const client = new TracearrClient(instance.url, instance.apiKey);

  // The same index the archive walk builds, and used for the same reason: the
  // records that come back are resolved to a `MediaItem` through the shared
  // resolver rather than attributed to the candidate we asked about. A play may
  // only ever land on a row the resolver is willing to name — a rating key that
  // collides with a second row resolves to `ambiguous` and is dropped, which is
  // the safe direction, because `playCount`/`lastPlayedAt` are monotonic and a
  // play attributed to the wrong item can never be walked back.
  const joinIndex = await buildTracearrJoinIndex(serverId);

  // The recovered rows must use the same username vocabulary as every other
  // row on this server, or a re-added item's plays would be attributed to a
  // different "person" than the item's earlier plays were.
  //
  // This pass REFUSES to run without the map, exactly as the archive walk does,
  // and for the same reason: the rows it writes are old plays that nothing will
  // ever re-deliver. `findCandidates` excludes any item that already has a
  // TRACEARR row, the forward pass reaches back only `OVERLAP_MS`, and
  // `tracearrBackfillComplete` is already true by the time this runs — so a row
  // written under a Tracearr identity label ("Nick W") sits permanently beside
  // rows written under the media server's account name ("weingart"), and a
  // `watchedByUser` rule sees one person as two. The forward pass's
  // self-healing argument does not apply here.
  //
  // An empty map is treated as a failure to load for the same reason it is in
  // the archive walk — `getServerAccountNames` returns one rather than throwing
  // on an unexpected response shape or a cut-short user walk.
  let accountNames: Map<string, string>;
  try {
    accountNames = await client.getServerAccountNames(tracearrServerId, { signal });
  } catch (error) {
    logger.warn(
      "WatchHistory",
      `Skipping Tracearr play recovery for newly added items on "${server.name}" — ` +
        `the account-name map could not be loaded, and these rows are never ` +
        `re-delivered, so importing them now would permanently attribute them to ` +
        `a different username than the rest of the server's history.`,
      { error: String(error) },
    );
    return empty;
  }
  if (accountNames.size === 0) {
    logger.warn(
      "WatchHistory",
      `Skipping Tracearr play recovery for newly added items on "${server.name}" — ` +
        `the account-name map came back empty, which cannot be right for a server ` +
        `that has plays; importing without it would permanently store them under ` +
        `Tracearr's identity names.`,
    );
    return empty;
  }

  let checked = 0;
  let imported = 0;
  let withoutPlays = 0;
  let failed = 0;
  let skipped = 0;
  let recoveredByProviderId = 0;
  /** Provider identities already asked about this run — see the fallback below. */
  const queriedProviders = new Set<string>();

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    checked++;

    try {
      let records = await client.getHistoryForItem(
        tracearrServerId,
        { ratingKey: candidate.ratingKey },
        { signal },
      );

      // Nothing under the rating key. That is the NORMAL answer for the case
      // this pass exists to serve: Plex mints a new rating key when an item is
      // removed and added back, so a re-added item's old plays live under a key
      // that no longer exists anywhere. The provider id is the identity that
      // survives, and the API filters on it.
      //
      // Only TMDB and IMDB, and never for an episode — the same rule as the
      // resolver's own fallback (`resolveMediaItemId`), which these records go
      // through: an episode row stores SERIES-level ids while Tracearr files
      // plays under EPISODE-level ones, so asking by the show's id can only
      // return plays of whatever else happens to carry that number, and the
      // two catalogues disagree about a film's TVDB id. Deduped per run so two
      // copies of one film cost one request.
      if (records.length === 0) {
        const providerKey = providerIdentityKey(candidate);
        if (providerKey && !queriedProviders.has(providerKey)) {
          queriedProviders.add(providerKey);
          records = await client.getHistoryForItem(
            tracearrServerId,
            { tmdbId: candidate.tmdbId, imdbId: candidate.imdbId },
            { signal },
          );
          if (records.length > 0) recoveredByProviderId++;
        }
      }

      // One Tracearr instance aggregates many media servers, and a rating key
      // is only unique within one of them — a record from another server would
      // attach a stranger's play to this server's item.
      const own = records.filter((record) => record.server_id === tracearrServerId);
      if (own.length === 0) {
        // The overwhelmingly common answer, and not a failure: most newly added
        // items have simply never been played.
        withoutPlays++;
        answeredItems.set(candidate.id, Date.now());
        continue;
      }

      const written = await importTracearrRecords(
        serverId,
        own,
        joinIndex,
        accountNames,
        tracearrServerId,
      );
      imported += written.inserted + written.updated;
      skipped += written.skipped;
      answeredItems.set(candidate.id, Date.now());
    } catch (error) {
      // One item's lookup failing must not cost the rest of the pass. It can be
      // transient (a 429 that outlasted the retry budget, a timeout) or
      // permanent for this item (the row was deleted between the candidate
      // query and the write, so the required media FK rejects it) — either way
      // the item is still a candidate on the next run, because the query that
      // found it derives candidacy from the rows, not from a cursor.
      // Cancelled: not this item's failure, and not the host's either.
      if (signal?.aborted) break;
      // The server was re-pointed or unlinked mid-pass: nothing more of this
      // source may be written, and every remaining item would fail the same way.
      if (error instanceof TracearrMappingChangedError) {
        logger.info(
          "WatchHistory",
          `Stopping Tracearr play recovery on "${server.name}" — its watch-history ` +
            `source changed while the pass ran`,
        );
        break;
      }
      failed++;
      // A failure of the HOST, not the item, will fail every remaining
      // candidate the same way, and each of those would pay the client's whole
      // retry budget (four 20s timeouts plus backoff) on the serial MAIN_QUEUE.
      // Stop; the next run re-derives the same candidates from the rows. Host
      // level is the shared `isHostLevelFailure` (refused connection, or a
      // read unanswered / 502-504 after its retries) plus a 429 that outlasted
      // the client's own retry — an item-specific 500 is not one of them.
      if (isHostLevelFailure(error) || (error instanceof IntegrationError && error.status === 429)) {
        logger.warn(
          "WatchHistory",
          `Stopping Tracearr play recovery on "${server.name}" after ${checked} of ` +
            `${candidates.length} candidate(s) — Tracearr is not answering; the rest are retried next run`,
          { error: String(error) },
        );
        break;
      }
      logger.warn(
        "WatchHistory",
        `Could not recover Tracearr history for "${formatMediaItemTitle(candidate)}" on ` +
          `"${server.name}" — continuing with the remaining candidates`,
        { error: String(error) },
      );
    }
  }

  if (imported > 0) {
    // The whole point of the pass: `playCount`/`lastPlayedAt` are what the
    // lifecycle rules read, and until the reconcile runs the recovered item
    // still looks never watched. Non-fatal, exactly like the importer's own
    // tail — the history rows are committed, so a failure here is corrected by
    // the next run rather than worth failing the pass over.
    try {
      await reconcileWatchStateFromHistory(serverId);
    } catch (error) {
      logger.warn(
        "WatchHistory",
        `Failed to reconcile play state after recovering Tracearr history for ` +
          `"${server.name}"`,
        { error: String(error) },
      );
    }

    invalidateMediaCaches();
  }

  logger.info(
    "WatchHistory",
    `Tracearr recovery for recently added items on "${server.name}": checked ` +
      `${checked} of ${candidates.length} candidate(s), imported ${imported} play(s) — ` +
      `${withoutPlays} with no plays, ${skipped} unjoinable, ${failed} failed, ` +
      // Worth its own figure: it is the count of items whose rating key had
      // changed, which is the re-add case this pass exists for. Zero here on a
      // Plex server with re-added media means the fallback is not firing.
      `${recoveredByProviderId} recovered by provider id`,
  );

  return { checked, imported };
}

/**
 * Recently added items on this server that hold no Tracearr play of their own.
 *
 * `NOT EXISTS` rather than a join so an item with many plays is not multiplied,
 * and scoped to `source = 'TRACEARR'` on purpose: a leftover NATIVE row is not
 * evidence that the Tracearr import has seen this item (the importer deletes
 * that stratum once it writes, and a server's history is single-source by
 * construction), so an item carrying only native rows is still worth asking
 * about. Items Tracearr already answered for are excluded — see `answeredItems`.
 */
async function findCandidates(
  serverId: string,
  limit: number,
): Promise<CandidateItem[]> {
  const now = Date.now();
  const addedAfter = new Date(now - RECENT_ADDITION_WINDOW_MS);
  const cap = Math.max(1, Math.min(Math.floor(limit), MAX_CANDIDATE_LIMIT));
  const answered = liveAnsweredIds(now);

  return prisma.$queryRawUnsafe<CandidateItem[]>(
    `SELECT mi."id", mi."ratingKey", mi."title", mi."type"::text AS "type", mi."parentTitle",
            mi."seasonNumber", mi."episodeNumber",
            MAX(CASE WHEN UPPER(e."source") = 'TMDB' THEN e."externalId" END) AS "tmdbId",
            MAX(CASE WHEN UPPER(e."source") = 'IMDB' THEN e."externalId" END) AS "imdbId"
       FROM "MediaItem" mi
       JOIN "Library" l ON mi."libraryId" = l."id"
       LEFT JOIN "MediaItemExternalId" e ON e."mediaItemId" = mi."id"
      WHERE l."mediaServerId" = $1
        AND mi."createdAt" > $2
        AND NOT EXISTS (
              SELECT 1
                FROM "WatchHistory" wh
               WHERE wh."mediaItemId" = mi."id"
                 AND wh."source" = 'TRACEARR'
            )
        AND NOT (mi."id" = ANY($4::text[]))
      -- Newest first: when there are more candidates than the cap allows, the
      -- most recent arrivals are the ones a user is waiting on, and the rest
      -- stay candidates for the next run.
      GROUP BY mi."id"
      ORDER BY mi."createdAt" DESC
      LIMIT $3`,
    serverId,
    addedAfter,
    cap,
    answered,
  );
}

/**
 * The identity a provider-id lookup would use for this candidate, or null when
 * there is none it may use. TMDB → IMDB, matching the order
 * `getHistoryForItem` picks from the filter it is given; never an episode (see
 * the call site). Doubles as the per-run dedup key.
 */
function providerIdentityKey(candidate: CandidateItem): string | null {
  if (candidate.type === "SERIES") return null;
  if (candidate.tmdbId) return `tmdb:${candidate.tmdbId}`;
  if (candidate.imdbId) return `imdb:${candidate.imdbId}`;
  return null;
}
