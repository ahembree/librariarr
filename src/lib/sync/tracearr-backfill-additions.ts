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
 * Without this window the candidate set is the whole library — the untouched
 * back catalogue included — and since the answered-items registry lives in
 * memory, every one of those items would be re-queried after every restart, to
 * learn the same answer each time.
 *
 * The window alone does not bound a library that was itself just created — a
 * new install, a purge and resync, a restore — where EVERY item is inside it.
 * The candidate query therefore also drops an item that already holds a
 * Tracearr play from well before its own row was created: that play can only
 * have come from the archive walk or an earlier recovery, so the history this
 * pass exists to bring back is already here (see `findCandidates`).
 */
export const RECENT_ADDITION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many items one pass may ask about, and therefore how many requests it may
 * issue: `rating_key` takes one value per request, so this cap IS the request
 * budget. 200 is a large re-add (a re-imported season, a library moved between
 * servers) while staying well inside a slice.
 *
 * Anything above the cap is not lost, only deferred: the candidate query orders
 * never-asked items first and newest-first among them, skips the items an
 * earlier pass already got an answer for (see `recoveryAnswers`), and the pass
 * runs every backfill slice, so the remainder is picked up next time — for as
 * long as it stays inside the window above.
 */
export const DEFAULT_CANDIDATE_LIMIT = 200;

/**
 * How long an item whose plays all resolved to ANOTHER row waits before it is
 * asked about again — see `recoveryAnswers`. A day covers the usual wait for
 * the old copy's purge (the next scheduled full sync) without spending a
 * request on every slice in between.
 */
export const RECOVERY_REASK_MS = 24 * 60 * 60 * 1000;

/**
 * How many times, in all, an item whose plays keep resolving elsewhere is
 * asked about before its answer is taken as final. The first ask plus two
 * re-asks a day apart: enough for an old copy purged within two days, and a
 * fixed cost per item for a copy that is never purged.
 */
export const MAX_RECOVERY_ASKS = 3;

interface RecoveryAnswer {
  /** When Tracearr last answered for the item. */
  at: number;
  /** How many answers it has given — counts toward `MAX_RECOVERY_ASKS`. */
  asks: number;
  /**
   * Final: the item had no plays, or a play stored by the pass resolved to it
   * and none was left to the catch-up. Otherwise the answer is deferred (every
   * play stored resolved to some other row, or to none — or a play was newer
   * than the forward boundary).
   */
  settled: boolean;
}

/**
 * What Tracearr has already ANSWERED for each item — item id → answer. This
 * registry, not the presence of Tracearr rows, is what ends an item's
 * candidacy.
 *
 * Why not the rows: a re-added item typically gets its first NEW play — under
 * its NEW rating key — before this pass reaches it (that play is often what
 * set off the sync that runs the pass). Excluding every item with a Tracearr
 * row therefore dropped exactly the item this pass exists for, with one
 * ten-minute row recovered and every old play, filed under the rating key the
 * item had before it left, never asked for. The item read as barely watched
 * — which "not played in N months" / `playCount` DELETE rules act on. So an
 * item stays a candidate until a lookup has actually been answered — for a
 * movie or track that includes the provider-id lookup, the only one that can
 * reach the old plays (see the call site).
 *
 * Without the registry the cap would also starve the window: candidates are
 * ordered newest-first, so once more than the cap's worth of recent items had
 * no plays (the normal state after a purge-and-resync, a restore or a library
 * move — exactly when recovery matters), every pass asked about the same
 * newest items again and never reached the re-added ones further down, which
 * then aged out of the window still reading as never watched.
 *
 * Two kinds of answer:
 *
 * - SETTLED — no plays at all, or at least one play resolved to this item.
 *   One answer is enough: the plays this pass exists to recover are OLD ones,
 *   and a play that happens after the item was added is imported by the
 *   forward pass like any other.
 * - DEFERRED — every play resolved to some OTHER row (or to none). Typically
 *   the item's old copy, not yet purged: those plays land on that row and go
 *   with it when its purge cascades, so closing the candidate there would lose
 *   them for good — asked again once the old row is gone, the same plays
 *   resolve to this item. But it is just as often a legitimate second copy (a
 *   new 4K copy beside the 1080p one) whose plays will resolve to the other
 *   copy forever. Re-asked every pass, a few hundred of those filled the
 *   newest-first cap on every run and the re-added items below them were
 *   never asked. So a deferred item is re-asked at most once per
 *   `RECOVERY_REASK_MS`, at most `MAX_RECOVERY_ASKS` times in all, and only
 *   AFTER every never-asked candidate (`findCandidates` orders them last).
 *   Deferred too: an item with a play newer than the forward boundary. The
 *   pass leaves those to the catch-up, which can step over them — see the
 *   call site — and a day on they are old enough to store here.
 *
 * A lookup that FAILED records nothing: the item is simply asked again.
 *
 * In memory on purpose: a restart merely re-asks (one or two requests per
 * item still inside the window, bounded by the cap and by the pre-creation
 * filter in `findCandidates`, and a re-delivered play is a merge, not a new
 * row — see `imported`). It cannot starve the window either: a re-asked item
 * gets its answer recorded again on that pass, so the next pass reaches the
 * items below it. Entries expire with the window, so the map holds at most a
 * week's worth of additions. Pinned to `globalThis` like the other registries
 * a job and the rest of the app may both load (under a new key: the earlier
 * shape held bare timestamps).
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
 * Split the live registry into the ids the candidate query must leave out
 * (settled, or deferred and not due again yet) and the deferred ids that are
 * due a re-ask (offered after every never-asked item). Drops entries older
 * than the candidate window on the way.
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
   * any rate-limit backoff). Stopping early is a normal outcome: every item
   * imported so far is committed, and an item is only taken off the candidate
   * list once Tracearr has answered for it, so the next run simply picks up
   * the ones this pass did not reach.
   */
  signal?: AbortSignal;
  /**
   * Epoch ms past which no further item is asked about. The pass runs inside a
   * backfill slice on the serial MAIN_QUEUE, after the slice's own walk, and
   * must end with that slice rather than hold the queue for up to
   * `MAX_CANDIDATE_LIMIT` × two requests (each with its own retry budget).
   * Checked between items, like `signal` — an item in flight still finishes.
   */
  deadlineMs?: number;
  /**
   * Stop between items when this returns true — the slice's "a requested sync
   * is waiting" check, so a user's sync is not parked behind a recovery pass.
   * Same resumable stop as the deadline: unasked items stay candidates.
   */
  yieldTo?: () => boolean;
}

export interface RecoverNewItemHistoryResult {
  /** Items actually asked about — i.e. requests issued. */
  checked: number;
  /**
   * NEW `WatchHistory` rows inserted across those items — what the caller
   * reconciles, invalidates caches and notifies pages for. A record that was
   * already stored (the item's own recent plays, or the whole answer again
   * after a restart cleared `recoveryAnswers`) only merges, and counting those
   * made every such pass look like a change: a server-wide reconcile, every
   * media cache dropped and every open page refetching, for nothing. Rows, not
   * plays: a play of a Jellyfin/Emby item two libraries list adds a row per
   * copy, and a stored play newly reaching a second copy adds that copy's row
   * alone — a change the copy's pages must see. The log line counts plays.
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
  // Only once the archive walk is complete, read here rather than taken from
  // the caller's earlier view: a mapping changed (or the walk restarted) since
  // that view has an archive owed a walk, and plays written for it now would
  // set its resume boundary — the walk's `until` falls back to the oldest
  // stored row when no cursor is recorded — far below everything it has not
  // read yet.
  if (!server.tracearrBackfillComplete) return empty;
  // Every write re-checks the mapping AND its version as read here, so a pass
  // that outlives an unlink and re-link of the same Tracearr server writes
  // nothing — see `TracearrMappingGuard`.
  const guard: TracearrMappingGuard = {
    tracearrServerId,
    mappingVersion: server.tracearrMappingVersion,
  };

  // The candidate query comes FIRST, before instance resolution and before the
  // join index, because the steady state is zero candidates — nothing has been
  // re-added — and that state must cost one indexed query and nothing else.
  const candidates = await findCandidates(serverId, limit);
  if (candidates.length === 0) return empty;
  // Out of time before the first item: skip the instance probe, the join index
  // and the `/users` walk too, all of which would be for nothing.
  if (shouldStop()) return empty;

  // Plays that started after this belong to the forward walk, and this pass
  // leaves them to it. Stored here, a re-added item's newest play would move
  // `MAX(watchedAt)` — where the next forward window starts — up to it, past
  // every other item's play in between that no walk has read yet: the slice
  // that runs this pass is queued straight away when a server or instance is
  // re-enabled, before any catch-up has read what happened while it was off.
  // What this pass exists for are the item's OLD plays, all of them at or
  // below the boundary. Read once, at the start: a forward walk moving it up
  // meanwhile has read what lies between — though one whose join index was
  // built before an item existed could not place that item's plays, which is
  // why an item with such a play is deferred rather than settled (below).
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

      // ALSO by provider id — whatever the rating key returned. Plex mints a
      // new rating key when an item is removed and added back, so a re-added
      // item's old plays live under a key that no longer exists anywhere; the
      // provider id is the identity that survives, and the API filters on it.
      // Finding plays under the new key proves nothing about the old ones: the
      // first play after the re-add is usually the reason this pass runs at
      // all, and stopping there recovered that one play and abandoned the
      // history it exists to bring back.
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

      // The two answers overlap whenever the rating key never changed (the new
      // play is in both), so merge by chain id: the importer drops a repeat
      // within one call too (one INSERT may not touch a row twice), but
      // merging here keeps its `skipped` count from counting a refused record
      // twice. A record seen before is merged by the upsert, never duplicated.
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
      // Plays left to the forward walk keep the item's answer DEFERRED, never
      // settled: a walk that cannot place them — a History-page Refresh whose
      // join index was built before this item existed — still moves MAX past
      // them, after which no catch-up reads them again. Asked once more a day
      // on, they are at or below the boundary: stored here, or merged if the
      // walk did store them.
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
      // Settled for THIS item only when at least one play resolved to it —
      // the same shared resolver the importer just used, against the same
      // index. Plays that all resolved elsewhere (the item's old copy, still
      // waiting for its purge — or a second copy that will keep them) were
      // imported onto that row; the answer is deferred, so a later pass, once
      // an old row is gone, can file them here — but not every pass, and not
      // ahead of items never asked about. See `recoveryAnswers`.
      // Over the plays stored here only: a new play resolving to the item says
      // nothing about whether its old ones did. A play filed against several
      // library copies of one item resolves to this one too when it is a copy.
      const resolvedHere = old.some((record) => {
        const resolved = resolveMediaItemId(joinIndex, record);
        return (
          "mediaItemId" in resolved &&
          (resolved.mediaItemId === candidate.id || resolved.copies?.includes(candidate.id) === true)
        );
      });
      // Plays that resolved to nothing at all (ambiguous, contradicted) defer
      // it too: an ambiguity between the old and new copy clears once the old
      // one is purged. So does a play left to the catch-up (above).
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
      // The server was re-pointed, unlinked or re-linked mid-pass: nothing more
      // of this source may be written, and every remaining item would fail the
      // same way.
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

  // Inserted rows only. A merge re-delivers a play already stored — one of the
  // item's own recent plays, which the forward pass imported and reconciled
  // itself, or an answer repeated after a restart — so it is not worth a
  // server-wide reconcile and a cache drop on every pass. Any new ROW counts,
  // though: a stored play newly filed against a second library copy adds the
  // copy's row, and that copy reads as unwatched until the reconcile runs.
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
      // Worth its own figure: it counts items with plays only their provider id
      // reached — a rating key that changed, which is the re-add case this pass
      // exists for. Zero here on a Plex server with re-added media means the
      // provider lookup is not firing.
      `${recoveredByProviderId} recovered by provider id`,
  );

  return { checked, imported: rowsInserted };
}

/**
 * Recently added items on this server that Tracearr has not answered for yet
 * and whose old history is not already stored.
 *
 * Deliberately NOT "items with no Tracearr rows": a re-added item usually has
 * one — its first new play, under its new rating key — while every older play
 * is still unrecovered (see `recoveryAnswers`). What it does not have is a play
 * from WELL before its row was created: that can only arrive by the archive
 * walk or by this pass, so its presence means the old history is here. That is
 * what keeps a freshly created library — a new install, a purge and resync, a
 * restore, where the whole library sits inside the window — from being offered
 * item by item: every item that was ever played already holds its old plays
 * from the walk. It survives a restart, unlike `recoveryAnswers`.
 *
 * "Well before" is `RECENT_ADDITION_WINDOW_MS` before `createdAt`, not
 * `createdAt` itself. `createdAt` is when OUR sync created the row, which lags
 * the item's return to the media server by however long the next sync took —
 * and a re-added item played in that gap (the play is often what set the sync
 * off) holds a Tracearr row dated before its own row. Keyed on `createdAt`
 * alone, that one new play excluded the item, and its pre-delete plays — the
 * case this pass exists for — were never asked for. A walked history is
 * typically far older than a week; a re-added item's new plays are recent.
 * The residual: an item re-added AND first played more than the window before
 * its row was created is excluded — which needs a sync lag longer than the
 * window, after which the item would have aged out of candidacy anyway. An
 * item whose only plays are in that last week (a new install whose library
 * was watched in the days before it) stays a candidate, bounded by the cap,
 * the window and `recoveryAnswers` like an item never played at all.
 *
 * Items never played at all are offered too (nothing distinguishes them from
 * a re-added item whose plays only the provider id reaches), bounded by the
 * cap, the window, the caller's deadline and `recoveryAnswers`. Never-asked
 * items come first, newest first; deferred ones that are due a re-ask come
 * after all of them, so they can never crowd out an item not yet asked.
 */
async function findCandidates(
  serverId: string,
  limit: number,
): Promise<CandidateItem[]> {
  const now = Date.now();
  const addedAfter = new Date(now - RECENT_ADDITION_WINDOW_MS);
  const cap = Math.max(1, Math.min(Math.floor(limit), MAX_CANDIDATE_LIMIT));
  const { excluded, deferredDue } = answeredIds(now);

  // A TRACEARR row of the item dated well before the item was created ends its
  // candidacy — a library copy's row (`fanOutOfItemId` set: a Jellyfin/Emby
  // item two libraries list) as much as a primary one: it is this item's own
  // record of a play the walk read before the item arrived.
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
