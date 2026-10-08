import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { invalidateMediaCaches } from "@/lib/cache/invalidate";
import { reconcileWatchStateFromHistory } from "@/lib/sync/watch-reconcile";
import { buildTracearrJoinIndex, resolveMediaItemId } from "@/lib/sync/tracearr-join";
import {
  forwardPassBoundary,
  importTracearrRecords,
  resolveInstanceForServer,
  type TracearrMappingGuard,
} from "@/lib/sync/sync-tracearr-history";
import {
  TracearrClient,
  type TracearrHistoryRecord,
} from "@/lib/tracearr/tracearr-client";
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
 * Without it, every item would be re-queried after every restart (the answers
 * registry is in memory). A library created whole — a new install, a purge, a
 * restore — is bounded by `findCandidates` dropping items that already hold an
 * old Tracearr play.
 */
export const RECENT_ADDITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many items one pass may ask about, and therefore how many requests it may
 * issue: `rating_key` takes one value per request, so this cap IS the request
 * budget. 200 is a large re-add (a re-imported season, a library moved between
 * servers) while staying well inside a slice.
 *
 * Anything above the cap is only deferred: never-asked items come first,
 * answered ones are skipped (`recoveryAnswers`), and the pass runs every slice.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200;

/**
 * How long an item whose plays all resolved to ANOTHER row waits before it is
 * asked again: a day covers the usual wait for the old copy's purge.
 */
export const RECOVERY_REASK_MS = 24 * 60 * 60 * 1000;

/**
 * Asks, in all, before a still-deferred answer is final: covers an old copy
 * purged within two days, and caps the cost of one that never is.
 */
export const MAX_RECOVERY_ASKS = 3;

interface RecoveryAnswer {
  /** When Tracearr last answered for the item. */
  at: number;
  /** How many answers it has given — counts toward `MAX_RECOVERY_ASKS`. */
  asks: number;
  /** Final: no plays, or a stored play resolved here with none left to the catch-up. */
  settled: boolean;
}

/**
 * What Tracearr has already ANSWERED for each item — item id → answer. This,
 * not the presence of Tracearr rows, ends an item's candidacy: a re-added item
 * usually gets its first NEW play before this pass reaches it, and excluding
 * items with rows dropped exactly the ones this pass exists for. It also keeps
 * the newest-first cap from asking about the same unplayed items every pass.
 *
 * - SETTLED — no plays, or a play stored here resolved to this item. One answer
 *   is enough: later plays are the forward pass's.
 * - DEFERRED — every play resolved to some OTHER row (or none): often the old
 *   copy not yet purged, whose plays resolve here once it is gone — but as
 *   often a legitimate second copy (a 4K beside a 1080p) that keeps them. So it
 *   is re-asked at most once per `RECOVERY_REASK_MS`, `MAX_RECOVERY_ASKS` times
 *   in all, after every never-asked candidate. An item with a play newer than
 *   the forward boundary is deferred too (see the call site).
 *
 * A failed lookup records nothing. In memory on purpose: a restart only
 * re-asks, within the window and the cap, and a re-delivered play merges.
 * Entries expire with the window. Pinned to `globalThis` like the other
 * registries a job and the rest of the app may both load.
 */
const recoveryAnswers: Map<string, RecoveryAnswer> = ((
  globalThis as unknown as { __tracearrRecoveryAnswers?: Map<string, RecoveryAnswer> }
).__tracearrRecoveryAnswers ??= new Map());

/** Record Tracearr's answer for an item — see `recoveryAnswers`. */
function recordAnswer(itemId: string, settled: boolean, now: number): void {
  const previous = recoveryAnswers.get(itemId);
  const asks = (previous?.asks ?? 0) + 1;
  // A deferred item that has used up its asks is as answered as it will get.
  recoveryAnswers.set(itemId, {
    at: now,
    asks,
    settled: settled || asks >= MAX_RECOVERY_ASKS,
  });
}

/**
 * The ids the candidate query must leave out (settled, or deferred and not due
 * yet) and the deferred ids due a re-ask; drops entries past the window.
 */
function answeredIds(now: number): { excluded: string[]; deferredDue: string[] } {
  const excluded: string[] = [];
  const deferredDue: string[] = [];
  for (const [id, answer] of recoveryAnswers) {
    if (now - answer.at > RECENT_ADDITION_WINDOW_MS) {
      recoveryAnswers.delete(id);
    } else if (answer.settled || now - answer.at < RECOVERY_REASK_MS) {
      excluded.push(id);
    } else {
      deferredDue.push(id);
    }
  }
  return { excluded, deferredDue };
}

/** Test seam: forget every recorded answer. */
export function resetRecoveryAnswers(): void {
  recoveryAnswers.clear();
}

/** A caller cannot opt out of the request budget, only ask for less of it. */
export const MAX_CANDIDATE_LIMIT = 500;

export interface RecoverNewItemHistoryOptions {
  /** Candidate cap for this pass; clamped to `MAX_CANDIDATE_LIMIT`. */
  limit?: number;
  /**
   * Cancels the pass between items (and interrupts an in-flight request plus
   * any rate-limit backoff). Stopping early is a normal outcome: imported items
   * are committed, and an item stays a candidate until Tracearr has answered.
   */
  signal?: AbortSignal;
  /**
   * Epoch ms past which no further item is asked about, so the pass ends with
   * its slice rather than holding the serial MAIN_QUEUE. Checked between items.
   */
  deadlineMs?: number;
  /** Stop between items when true (a requested sync is waiting); resumable. */
  yieldTo?: () => boolean;
}

export interface RecoverNewItemHistoryResult {
  /** Items actually asked about — i.e. requests issued. */
  checked: number;
  /**
   * NEW `WatchHistory` rows inserted, a library copy's included — what the caller
   * reconciles, invalidates and notifies for. A record already stored only
   * merges, and counting it made every pass look like a change. The log line
   * counts plays.
   */
  imported: number;
}

/** One candidate: a recently added item Tracearr has not yet answered for. */
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
  const { limit = DEFAULT_CANDIDATE_LIMIT, signal, deadlineMs, yieldTo } = options;
  const empty: RecoverNewItemHistoryResult = { checked: 0, imported: 0 };
  const shouldStop = () =>
    signal?.aborted === true ||
    (deadlineMs !== undefined && Date.now() >= deadlineMs) ||
    yieldTo?.() === true;

  const server = await prisma.mediaServer.findFirst({
    where: { id: serverId },
    select: {
      id: true,
      name: true,
      enabled: true,
      tracearrServerId: true,
      tracearrMappingVersion: true,
      tracearrBackfillComplete: true,
      tracearrBackfillCursorAt: true,
      tracearrForwardFloorAt: true,
      tracearrBackfillLastWalkAt: true,
      tracearrForwardWatermarkAt: true,
      userId: true,
    },
  });

  if (!server || !server.enabled) return empty;
  const tracearrServerId = server.tracearrServerId;
  if (!tracearrServerId) return empty;
  // Only once the archive walk is complete, read here rather than from the
  // caller's earlier view: an archive owed a walk would have its resume boundary
  // set far below everything unread by plays written now.
  if (!server.tracearrBackfillComplete) return empty;
  // Every write re-checks this mapping and version (`TracearrMappingGuard`).
  const guard: TracearrMappingGuard = {
    tracearrServerId,
    mappingVersion: server.tracearrMappingVersion,
  };

  // The candidate query comes FIRST, before instance resolution and before the
  // join index, because the steady state is zero candidates — nothing has been
  // re-added — and that state must cost one indexed query and nothing else.
  const candidates = await findCandidates(serverId, limit);
  if (candidates.length === 0) return empty;
  // Out of time already: skip the instance probe, join index and `/users` walk.
  if (shouldStop()) return empty;

  // Plays that started after this belong to the forward walk: stored here, a
  // re-added item's newest play would move `MAX(watchedAt)` past every other
  // item's play no walk has read yet (a re-enable queues this slice before any
  // catch-up). Read once, at the start.
  const boundary = await forwardPassBoundary(serverId, {
    backfillComplete: server.tracearrBackfillComplete,
    cursorAt: server.tracearrBackfillCursorAt,
    forwardFloorAt: server.tracearrForwardFloorAt,
    lastWalkAt: server.tracearrBackfillLastWalkAt,
    forwardWatermarkAt: server.tracearrForwardWatermarkAt,
  });

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
  // ever re-deliver. An item is asked about a bounded number of times (see
  // `recoveryAnswers`), the forward pass reaches back only `OVERLAP_MS`, and
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
  /** New plays, for the log line. */
  let newPlays = 0;
  let merged = 0;
  /** New rows of any kind, a library copy's included — see `imported`. */
  let rowsInserted = 0;
  let withoutPlays = 0;
  let elsewhere = 0;
  let failed = 0;
  let skipped = 0;
  let recoveredByProviderId = 0;
  /** Plays newer than `boundary`, left to the forward walk. */
  let leftToForward = 0;
  /** Items with a play newer than `boundary` — deferred, see the call site. */
  let awaitingCatchUp = 0;
  /** Provider identities already asked about this run — see the fallback below. */
  const queriedProviders = new Set<string>();

  for (const candidate of candidates) {
    if (shouldStop()) break;
    checked++;

    try {
      const byRatingKey = await client.getHistoryForItem(
        tracearrServerId,
        { ratingKey: candidate.ratingKey },
        { signal },
      );

      // ALSO by provider id, whatever the rating key returned: Plex mints a new
      // rating key on a re-add, so the old plays live under a key that no longer
      // exists, and plays under the new key prove nothing about them.
      //
      // Only TMDB and IMDB, and never for an episode — the same rule as the
      // resolver's own fallback (`resolveMediaItemId`), which these records go
      // through: an episode row stores SERIES-level ids while Tracearr files
      // plays under EPISODE-level ones, so asking by the show's id can only
      // return plays of whatever else happens to carry that number, and the
      // two catalogues disagree about a film's TVDB id. Deduped per run so two
      // copies of one film cost one request.
      let byProviderId: TracearrHistoryRecord[] = [];
      const providerKey = providerIdentityKey(candidate);
      if (providerKey && !queriedProviders.has(providerKey)) {
        queriedProviders.add(providerKey);
        byProviderId = await client.getHistoryForItem(
          tracearrServerId,
          { tmdbId: candidate.tmdbId, imdbId: candidate.imdbId },
          { signal },
        );
      }

      // Merge the two answers by chain id (they overlap whenever the rating key
      // never changed), so the importer's `skipped` does not count a record twice.
      const seen = new Set(byRatingKey.map((record) => record.id));
      const onlyByProvider = byProviderId.filter((record) => !seen.has(record.id));
      const records = [...byRatingKey, ...onlyByProvider];
      if (
        onlyByProvider.some((record) => record.server_id === tracearrServerId)
      ) {
        recoveredByProviderId++;
      }

      // One Tracearr instance aggregates many media servers, and a rating key
      // is only unique within one of them — a record from another server would
      // attach a stranger's play to this server's item.
      const own = records.filter((record) => record.server_id === tracearrServerId);
      if (own.length === 0) {
        // The overwhelmingly common answer, and not a failure: most newly added
        // items have simply never been played.
        withoutPlays++;
        recordAnswer(candidate.id, true, Date.now());
        continue;
      }
      // Only plays at or below the forward boundary — see `boundary`. A record
      // whose start cannot be read is left in: the importer refuses it anyway.
      const old = own.filter((record) => !(Date.parse(record.started_at) > boundary.getTime()));
      // Plays left to the forward walk keep the answer DEFERRED: a walk whose join
      // index predates this item moves MAX past them unread, and a day on they are
      // old enough to store here.
      const leftHere = own.length - old.length;
      leftToForward += leftHere;
      if (leftHere > 0) awaitingCatchUp++;
      if (old.length === 0) {
        // Every play is newer than the boundary: nothing OLD to store now.
        recordAnswer(candidate.id, false, Date.now());
        continue;
      }

      const written = await importTracearrRecords(
        serverId,
        old,
        joinIndex,
        accountNames,
        guard,
      );
      newPlays += written.inserted;
      merged += written.updated;
      rowsInserted += written.rowsInserted;
      skipped += written.skipped;
      // Settled only when a play stored here resolved to this item (directly or as
      // a library copy). Plays that resolved elsewhere — the old copy awaiting its
      // purge, or a second copy keeping them — or to nothing defer the answer, as
      // does a play left to the catch-up. See `recoveryAnswers`.
      const resolvedHere = old.some((record) => {
        const resolved = resolveMediaItemId(joinIndex, record);
        return (
          "mediaItemId" in resolved &&
          (resolved.mediaItemId === candidate.id || resolved.copies?.includes(candidate.id) === true)
        );
      });
      recordAnswer(candidate.id, resolvedHere && leftHere === 0, Date.now());
      if (!resolvedHere) elsewhere++;
    } catch (error) {
      // One item's lookup failing must not cost the rest of the pass. It can be
      // transient (a 429 that outlasted the retry budget, a timeout) or
      // permanent for this item (the row was deleted between the candidate
      // query and the write, so the required media FK rejects it) — either way
      // the item is still a candidate on the next run, because only an answer
      // is recorded in `recoveryAnswers`.
      // Cancelled: not this item's failure, and not the host's either.
      if (signal?.aborted) break;
      // The mapping moved mid-pass: every remaining item would fail the same way.
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

  // New ROWS only: a merge re-delivers a stored play (not worth a reconcile and
  // cache drop every pass), but a play newly filed against a second library copy
  // adds that copy's row, which reads unwatched until the reconcile runs.
  if (rowsInserted > 0) {
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
      `${checked} of ${candidates.length} candidate(s), imported ${newPlays} new play(s) ` +
      `(${merged} already stored) — ` +
      `${withoutPlays} with no plays, ${elsewhere} deferred (no play resolved to the item itself), ` +
      `${skipped} unjoinable, ${failed} failed, ` +
      `${leftToForward} play(s) newer than the catch-up's boundary left to it ` +
      `(their ${awaitingCatchUp} item(s) asked again later), ` +
      // Zero on a Plex server with re-added media means the provider lookup is not firing.
      `${recoveredByProviderId} recovered by provider id`,
  );

  return { checked, imported: rowsInserted };
}

/**
 * Recently added items on this server that Tracearr has not answered for yet
 * and whose old history is not already stored.
 *
 * Not "items with no Tracearr rows": a re-added item usually has one (its
 * first new play) while its old plays are unrecovered. What it lacks is a play
 * from WELL before its row was created — only the archive walk or this pass
 * stores one — so such a play ends candidacy, which keeps a freshly created
 * library (new install, purge, restore) from being offered item by item, and
 * survives a restart. "Well before" is a window before `createdAt`, because our
 * sync lags the item's return and a play in that gap predates the row.
 *
 * Never-asked items come first, newest first; deferred ones due a re-ask after
 * all of them, so they can never crowd out an item not yet asked.
 */
async function findCandidates(
  serverId: string,
  limit: number,
): Promise<CandidateItem[]> {
  const now = Date.now();
  const addedAfter = new Date(now - RECENT_ADDITION_WINDOW_MS);
  const cap = Math.max(1, Math.min(Math.floor(limit), MAX_CANDIDATE_LIMIT));
  const { excluded, deferredDue } = answeredIds(now);

  // A library copy's row (`fanOutOfItemId` set) ends candidacy as much as a
  // primary one: it is this item's own record of a play the walk read.
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
        AND NOT (mi."id" = ANY($4::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM "WatchHistory" wh
           WHERE wh."mediaItemId" = mi."id"
             AND wh."source" = 'TRACEARR'
             AND wh."watchedAt" < mi."createdAt" - ($6::integer * interval '1 second')
        )
      -- Never-asked before deferred (false sorts first), then newest first:
      -- when there are more candidates than the cap allows, the most recent
      -- arrivals are the ones a user is waiting on, and the rest stay
      -- candidates for the next run. The id makes the order total.
      GROUP BY mi."id"
      ORDER BY (mi."id" = ANY($5::text[])) ASC, mi."createdAt" DESC, mi."id" ASC
      LIMIT $3`,
    serverId,
    addedAfter,
    cap,
    excluded,
    deferredDue,
    Math.round(RECENT_ADDITION_WINDOW_MS / 1000),
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
