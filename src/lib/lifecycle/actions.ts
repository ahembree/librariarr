import axios from "axios";
import { prisma } from "@/lib/db";
import { RadarrClient, type RadarrMovie } from "@/lib/arr/radarr-client";
import { SonarrClient, type SonarrEpisode, type SonarrSeries } from "@/lib/arr/sonarr-client";
import { LidarrClient, type LidarrArtist, type LidarrTrack } from "@/lib/arr/lidarr-client";
import type { ArrClientBase, ArrTag } from "@/lib/arr/arr-client-base";
import { familyOfArrInstance, findArrInstance, type ArrFamily } from "@/lib/arr/instances";
import { logger } from "@/lib/logger";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { actionHonorsMemberIds, deletesArrRecord, formatActionLabel, supportsSearchAfter } from "@/lib/lifecycle/action-types";
import { seriesTitleOf } from "@/lib/media/display-title";

/**
 * Extract a meaningful error message from Arr API failures, including the
 * response body — SANITIZED: this is what gets persisted on the
 * `LifecycleAction` row and returned by the execute/retry routes (and, through
 * them, the public API), and an Arr error body routinely names the file it
 * could not delete or the host it could not reach. `describeActionError` is
 * the unsanitized text, for log lines only.
 */
export function extractActionError(error: unknown): string {
  return sanitizeErrorDetail(describeActionError(error)) ?? "Unknown error";
}

/** The full Arr error text, paths and addresses included. Log it; never store or return it. */
export function describeActionError(error: unknown): string {
  // Clients now wrap axios errors in IntegrationError, which exposes the
  // status / detail directly and keeps the original AxiosError as `cause`.
  if (error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "IntegrationError") {
    const ie = error as unknown as { status: number | null; detail: string | null; message: string };
    if (ie.status !== null) {
      return ie.detail
        ? `HTTP ${ie.status}: ${ie.detail}`
        : `HTTP ${ie.status}: ${ie.message}`;
    }
    return ie.message;
  }
  // Backward-compat: raw AxiosError (in case some path bypasses the wrapper)
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    const data = error.response.data;
    const detail =
      typeof data === "string"
        ? data
        : data && typeof data === "object" && "message" in data
          ? String((data as Record<string, unknown>).message)
          : null;
    return detail
      ? `HTTP ${status}: ${detail}`
      : `HTTP ${status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * What an executed action reports back. `deletedMemberIds` is set by the
 * member-scoped file deletes (Sonarr episodes, Lidarr tracks) to the members
 * whose files were actually deleted — a member whose file was shared with an
 * unmatched one, or that could not be found in the Arr app, is left out — so
 * `deletedBytes` counts what went, not what was asked for.
 */
export interface ActionOutcome {
  deletedMemberIds?: string[];
}

// Type for the action record shape used by executors
export interface ActionRecord {
  id: string;
  actionType: string;
  arrInstanceId: string | null;
  targetQualityProfileId: number | null;
  addImportExclusion: boolean;
  searchAfterAction: boolean;
  matchedMediaItemIds: string[];
  addArrTags: string[];
  removeArrTags: string[];
  skipTitleValidation?: boolean;
  /**
   * Unmonitor and Search act on the episodes in `matchedMediaItemIds` rather
   * than the whole series (Sonarr only). Set by the Query page's episode view,
   * where the user picked individual episodes; rule-based actions leave it off
   * and keep acting on the series.
   */
  episodeScope?: boolean;
  /**
   * What the log lines call the item: `actionTargetTitle` of this action — a
   * series action by its show, or "<Show> SxxExx" on one episode, never by the
   * episode it is stored against.
   */
  targetTitle: string;
  mediaItem: {
    id: string;
    title: string;
    parentTitle: string | null;
    year: number | null;
    externalIds: { source: string; externalId: string }[];
  };
}

// --- Arr item validation ---

/**
 * Normalize a title for fuzzy comparison between Plex/Jellyfin/Emby and Arr systems.
 * Handles common differences: article placement, year suffixes, punctuation, case,
 * and Unicode diacritics (e.g. "Abramović" ↔ "Abramovic").
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")                   // decompose accented chars (ć → c + combining ́)
    .replace(/[̀-ͯ]/g, "")    // strip combining diacritical marks
    .replace(/,\s*(the|a|an)$/i, "")   // "Matrix, The" → "Matrix"
    .replace(/^(the|a|an)\s+/i, "")     // "The Matrix" → "Matrix"
    .replace(/\s*\([^)]*\)\s*/g, " ")   // "Movie (2024)" → "Movie "
    .replace(/&/g, "and")               // "Fish & Chips" → "Fish and Chips"
    .replace(/[^\p{L}\p{N}\s]/gu, "")   // Remove non-alphanumeric (unicode-safe)
    .replace(/\s+/g, " ")               // Collapse whitespace
    .trim();
}

/**
 * How `expectedYear` relates to `arrYear` for the year guard:
 *  - "release" (movies): both years describe the SAME work's release, so they
 *    must match within ±1. Catches remake collisions ("Dune" 1984 vs 2021).
 *  - "episodeOfSeries" (Sonarr): `expectedYear` is an EPISODE air year while
 *    `arrYear` is the SERIES premiere year. A correct match has the episode
 *    airing on (or after) the premiere, so an episode legitimately airs years
 *    later — comparing them symmetrically would falsely flag every late-season
 *    episode of a long-running show. Only the reverse is impossible: a correct
 *    series can't have premiered well AFTER our episode aired, so flag only when
 *    `arrYear - expectedYear > 1` (the external id points at a newer same-named
 *    series).
 */
type YearMatchMode = "release" | "episodeOfSeries";

/**
 * Validate that the item resolved from the Arr API matches what we expect.
 * Called by each resolve helper after the API lookup succeeds.
 * Throws if titles don't match — prevents acting on the wrong item.
 */
export function validateArrItem(
  expectedTitle: string,
  arrTitle: string,
  arrType: string,
  externalId: string,
  expectedYear?: number | null,
  arrYear?: number | null,
  yearMode: YearMatchMode = "release",
): void {
  // Year guard FIRST: title normalization strips the very disambiguators
  // that separate remakes ("Dune (1984)" vs "(2021)" both normalize to
  // "dune"), so a wrong external id pointing at the other remake would pass
  // the title check. When both years are known and the mismatch is impossible
  // for the same work, the records are different works — refuse regardless of
  // title. See YearMatchMode for why series use a one-directional check.
  if (
    expectedYear != null && arrYear != null &&
    expectedYear > 0 && arrYear > 0
  ) {
    const yearMismatch =
      yearMode === "episodeOfSeries"
        ? arrYear - expectedYear > 1
        : Math.abs(expectedYear - arrYear) > 1;
    if (yearMismatch) {
      throw new Error(
        `${arrType} year mismatch: expected "${expectedTitle}" (${expectedYear}) but Arr returned "${arrTitle}" (${arrYear}) for external ID ${externalId}. Aborting to prevent acting on the wrong item.`
      );
    }
  }

  const normalizedExpected = normalizeTitle(expectedTitle);
  const normalizedArr = normalizeTitle(arrTitle);

  if (normalizedExpected === normalizedArr) return;

  // Substring match with safety guards to prevent short-title false positives:
  // 1. Both titles must be at least 4 characters after normalization
  // 2. Shorter title must be at least 50% the length of the longer
  // This allows "Agents of SHIELD" ↔ "Marvel's Agents of SHIELD" (ratio 0.67)
  // but blocks "It" ↔ "It Follows" (ratio 0.20) and "Avatar" ↔ "Avatar Way of Water" (ratio 0.32)
  const minLen = Math.min(normalizedExpected.length, normalizedArr.length);
  const maxLen = Math.max(normalizedExpected.length, normalizedArr.length);

  if (minLen >= 4 && maxLen > 0 && minLen / maxLen >= 0.5) {
    if (normalizedExpected.includes(normalizedArr) || normalizedArr.includes(normalizedExpected)) {
      logger.warn("Lifecycle", `Partial title match for ${arrType} (external ID: ${externalId}): expected "${expectedTitle}", Arr has "${arrTitle}" — proceeding`);
      return;
    }
  }

  // Hard stop — titles don't match
  throw new Error(
    `${arrType} title mismatch: expected "${expectedTitle}" but Arr returned "${arrTitle}" (external ID: ${externalId}). Aborting to prevent acting on the wrong item.`
  );
}

// --- Arr adapters ---
//
// What differs between Radarr, Sonarr and Lidarr for the steps every family
// shares — resolving the item's record (with title validation), tags, the
// quality-profile change, a search and the rule-set tag cleanup — so those
// steps are written once. The member-scoped file deletes stay per family:
// episodes and tracks are resolved in genuinely different ways.

interface ArrRecord {
  id: number;
  tags: number[];
  qualityProfileId: number;
  monitored: boolean;
}

interface ArrItemAdapter<C extends ArrClientBase, R extends ArrRecord> {
  label: "Radarr" | "Sonarr" | "Lidarr";
  /** The external id the record is looked up by. */
  idSource: "TMDB" | "TVDB" | "MUSICBRAINZ";
  missingIdError: string;
  notFoundError: string;
  createClient(url: string, apiKey: string): C;
  lookup(client: C, externalId: string): Promise<R | null>;
  /** Throws when the record is not the item's work (see `validateArrItem`). */
  validate(action: ActionRecord, record: R, externalId: string): void;
  name(record: R): string;
  /** PUT `patch` over `record` — already read, so not read again first. */
  update(client: C, record: R, patch: Partial<R>): Promise<R>;
  list(client: C): Promise<R[]>;
  removeTags(client: C, ids: number[], tagIds: number[]): Promise<void>;
  /** The search a Search or Change Quality Profile action triggers. */
  search(client: C, record: R): Promise<void>;
}

const expectedTitle = (action: ActionRecord) => action.mediaItem.parentTitle ?? action.mediaItem.title;

const RADARR: ArrItemAdapter<RadarrClient, RadarrMovie> = {
  label: "Radarr",
  idSource: "TMDB",
  missingIdError: "No TMDB ID found for item",
  notFoundError: "Movie not found in Radarr",
  createClient: (url, apiKey) => new RadarrClient(url, apiKey),
  lookup: (client, id) => client.getMovieByTmdbId(parseInt(id)),
  validate: (action, movie, id) =>
    validateArrItem(expectedTitle(action), movie.title, "Radarr movie", id, action.mediaItem.year, movie.year),
  name: (movie) => movie.title,
  update: (client, movie, patch) => client.updateMovie(movie.id, patch, movie),
  list: (client) => client.getMovies(),
  removeTags: (client, ids, tagIds) => client.removeTagsFromMovies(ids, tagIds),
  search: (client, movie) => client.triggerMovieSearch(movie.id),
};

const SONARR: ArrItemAdapter<SonarrClient, SonarrSeries> = {
  label: "Sonarr",
  idSource: "TVDB",
  missingIdError: "No TVDB ID found for item",
  notFoundError: "Series not found in Sonarr",
  createClient: (url, apiKey) => new SonarrClient(url, apiKey),
  lookup: (client, id) => client.getSeriesByTvdbId(parseInt(id)),
  // `action.mediaItem.year` is the EPISODE air year (episodes are stored as
  // individual MediaItem rows), but Sonarr returns the SERIES premiere year —
  // so use the one-directional series year guard, not the symmetric one.
  validate: (action, series, id) =>
    validateArrItem(expectedTitle(action), series.title, "Sonarr series", id, action.mediaItem.year, series.year, "episodeOfSeries"),
  name: (series) => series.title,
  update: (client, series, patch) => client.updateSeries(series.id, patch, series),
  list: (client) => client.getSeries(),
  removeTags: (client, ids, tagIds) => client.removeTagsFromSeries(ids, tagIds),
  search: (client, series) => client.triggerSeriesSearch(series.id),
};

const LIDARR: ArrItemAdapter<LidarrClient, LidarrArtist> = {
  label: "Lidarr",
  idSource: "MUSICBRAINZ",
  missingIdError: "No MusicBrainz ID found for item",
  notFoundError: "Artist not found in Lidarr",
  createClient: (url, apiKey) => new LidarrClient(url, apiKey),
  lookup: (client, id) => client.getArtistByMusicBrainzId(id),
  validate: (action, artist, id) => validateArrItem(expectedTitle(action), artist.artistName, "Lidarr artist", id),
  name: (artist) => artist.artistName,
  update: (client, artist, patch) => client.updateArtist(artist.id, patch, artist),
  list: (client) => client.getArtists(),
  removeTags: (client, ids, tagIds) => client.removeTagsFromArtists(ids, tagIds),
  search: (client, artist) => client.triggerArtistSearch(artist.id),
};

// The adapters are used by family through this map, which erases the record
// type; each one is only ever handed records its own `lookup` returned.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArrAdapter = ArrItemAdapter<any, any>;
const ADAPTERS: Record<ArrFamily, AnyArrAdapter> = { RADARR, SONARR, LIDARR };

/** The family an action type acts on, from its suffix; null for DO_NOTHING. */
function familyOfActionType(actionType: string): ArrFamily | null {
  if (actionType.endsWith("_RADARR")) return "RADARR";
  if (actionType.endsWith("_SONARR")) return "SONARR";
  if (actionType.endsWith("_LIDARR")) return "LIDARR";
  return null;
}

// --- Execution context ---

/**
 * What one execution run looks up once rather than per action: which Arr
 * family an instance id belongs to (immutable — ids are per table) and each
 * instance's tag list (one GET, where every action used to read it again).
 * The instance row itself is still read per action, so an instance disabled
 * or deleted mid-run stops being acted on at once.
 *
 * Pass one to `executeAction` for every action of a run; without one each
 * call reads for itself, as before.
 */
export class ArrExecutionContext {
  private readonly families = new Map<string, Promise<ArrFamily | null>>();
  private readonly tagLists = new Map<string, Promise<ArrTag[]>>();

  familyOf(instanceId: string): Promise<ArrFamily | null> {
    let pending = this.families.get(instanceId);
    if (!pending) {
      pending = familyOfArrInstance(instanceId).then((found) => found?.family ?? null);
      this.families.set(instanceId, pending);
    }
    return pending;
  }

  /** The instance's tags. A failed read is not kept: the next action asks again. */
  tags(instanceId: string, client: ArrClientBase): Promise<ArrTag[]> {
    let pending = this.tagLists.get(instanceId);
    if (!pending) {
      pending = client.getTags();
      this.tagLists.set(instanceId, pending);
      pending.catch(() => {
        if (this.tagLists.get(instanceId) === pending) this.tagLists.delete(instanceId);
      });
    }
    return pending;
  }

  /** A tag this run created, so the next action finds it instead of creating it again. */
  async rememberTag(instanceId: string, tag: ArrTag): Promise<void> {
    const pending = this.tagLists.get(instanceId);
    if (pending) (await pending).push(tag);
  }
}

/**
 * The record one action resolves to, read once and kept for the action's
 * later steps (tags first, then the main action). A step's PUT replaces it,
 * so a later PUT sends the tags the earlier one wrote rather than the record
 * as first read.
 */
class ActionArrSession {
  private resolved: { family: ArrFamily; client: ArrClientBase; record: ArrRecord } | null = null;

  constructor(
    private readonly action: ActionRecord,
    readonly ctx: ArrExecutionContext,
  ) {}

  async resolve<C extends ArrClientBase, R extends ArrRecord>(
    family: ArrFamily,
  ): Promise<{ client: C; record: R; adapter: ArrItemAdapter<C, R> }> {
    const adapter = ADAPTERS[family] as ArrItemAdapter<C, R>;
    if (this.resolved?.family === family) {
      return { client: this.resolved.client as C, record: this.resolved.record as R, adapter };
    }
    const { action } = this;
    if (!action.arrInstanceId) throw new Error("No Arr instance configured");
    const instance = await findArrInstance(family, { id: action.arrInstanceId });
    if (!instance) throw new Error(`${adapter.label} instance not found`);
    if (!instance.enabled) throw new Error(`${adapter.label} instance is disabled`);

    const client = adapter.createClient(instance.url, instance.apiKey);
    const externalId = action.mediaItem.externalIds.find((e) => e.source === adapter.idSource);
    if (!externalId) throw new Error(adapter.missingIdError);

    const record = await adapter.lookup(client, externalId.externalId);
    if (!record) throw new Error(adapter.notFoundError);

    if (!action.skipTitleValidation) adapter.validate(action, record, externalId.externalId);

    this.resolved = { family, client, record };
    return { client, record, adapter };
  }

  /** PUT `patch` over the resolved record and keep what the app now holds. */
  async update<R extends ArrRecord>(family: ArrFamily, patch: Partial<R>): Promise<R> {
    const { client, record, adapter } = await this.resolve<ArrClientBase, R>(family);
    const answer = await adapter.update(client, record, patch);
    // The app answers a PUT with the whole record; anything less (a proxy, an
    // older version) still leaves the record as sent.
    const next = answer && typeof answer.id === "number" ? answer : ({ ...record, ...patch } as R);
    this.resolved = { family, client, record: next };
    return next;
  }
}

// --- Tag operations ---

async function executeTagOperations(session: ActionArrSession, action: ActionRecord): Promise<void> {
  if (!action.arrInstanceId) throw new Error("No Arr instance configured for tag operations");

  // A "Do Nothing" action names no family: the instance it points at decides.
  let family = familyOfActionType(action.actionType);
  if (action.actionType === "DO_NOTHING") {
    family = await session.ctx.familyOf(action.arrInstanceId);
    if (!family) throw new Error("Arr instance not found");
  }
  if (!family) throw new Error(`Unsupported actionType for tag operations: ${action.actionType}`);

  const { client, record } = await session.resolve(family);
  const tags = await session.ctx.tags(action.arrInstanceId, client);
  const tagMap = new Map(tags.map((t) => [t.label.toLowerCase(), t.id]));

  const currentTags = new Set(record.tags);

  // Add tags (find-or-create)
  for (const label of action.addArrTags) {
    let tagId = tagMap.get(label.toLowerCase());
    if (tagId === undefined) {
      const created = await client.createTag(label);
      tagId = created.id;
      tagMap.set(label.toLowerCase(), created.id);
      await session.ctx.rememberTag(action.arrInstanceId, created);
    }
    currentTags.add(tagId);
  }

  // Remove tags
  for (const label of action.removeArrTags) {
    const tagId = tagMap.get(label.toLowerCase());
    if (tagId !== undefined) {
      currentTags.delete(tagId);
    }
  }

  // Update only if tags changed
  const newTags = [...currentTags];
  if (newTags.length !== record.tags.length || !newTags.every((t) => record.tags.includes(t))) {
    await session.update(family, { tags: newTags });
  }
}

// --- Tag cleanup (used when deleting a rule set) ---

export async function cleanupArrTags(
  arrInstanceId: string,
  type: string,
  tagLabels: string[]
): Promise<void> {
  if (tagLabels.length === 0) return;

  // Determine which Arr type this instance belongs to
  const found = await familyOfArrInstance(arrInstanceId);
  if (!found) throw new Error("Arr instance not found");

  const adapter = ADAPTERS[found.family];
  const client: ArrClientBase = adapter.createClient(found.instance.url, found.instance.apiKey);
  const tags = await client.getTags();
  const targetTags = tags.filter((t) =>
    tagLabels.some((label) => label.toLowerCase() === t.label.toLowerCase())
  );
  if (targetTags.length === 0) return;

  // One bulk-editor request for every record carrying a tag, where each
  // record used to cost a GET and a PUT of its own.
  const targetIds = new Set(targetTags.map((t) => t.id));
  const records: ArrRecord[] = await adapter.list(client);
  const tagged = records.filter((r) => r.tags.some((id) => targetIds.has(id))).map((r) => r.id);
  await adapter.removeTags(client, tagged, [...targetIds]);
  for (const tag of targetTags) {
    await client.deleteTag(tag.id);
  }

  logger.info("Lifecycle", `Cleaned up tags [${tagLabels.join(", ")}] from ${type} items`);
}

// --- Individual action executors ---

const movieOf = (session: ActionArrSession) => session.resolve<RadarrClient, RadarrMovie>("RADARR");
const seriesOf = (session: ActionArrSession) => session.resolve<SonarrClient, SonarrSeries>("SONARR");
const artistOf = (session: ActionArrSession) => session.resolve<LidarrClient, LidarrArtist>("LIDARR");

async function executeDeleteRadarr(session: ActionArrSession, action: ActionRecord) {
  const { client, record: movie } = await movieOf(session);
  await client.deleteMovie(movie.id, true, action.addImportExclusion);
}

async function executeDeleteSonarr(session: ActionArrSession, action: ActionRecord) {
  const { client, record: series } = await seriesOf(session);
  await client.deleteSeries(series.id, true, action.addImportExclusion);
}

async function executeUnmonitor(session: ActionArrSession, family: ArrFamily) {
  await session.update(family, { monitored: false });
}

async function executeUnmonitorDeleteFilesRadarr(session: ActionArrSession, action: ActionRecord) {
  await session.update<RadarrMovie>("RADARR", { monitored: false });
  const { client, record: movie } = await movieOf(session);
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeUnmonitorDeleteFilesSonarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  await session.update<SonarrSeries>("SONARR", { monitored: false });
  const { client, record: series } = await seriesOf(session);
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  if (action.searchAfterAction) {
    // A series search skips unmonitored seasons and episodes, and this action
    // just unmonitored the series — search the episodes acted on by id.
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeDeleteLidarr(session: ActionArrSession, action: ActionRecord) {
  const { client, record: artist } = await artistOf(session);
  await refuseSplitArtistDelete(client, artist, action);
  await client.deleteArtist(artist.id, true, action.addImportExclusion);
}

/** How many other ids under one artist title are checked; past it the delete is refused. */
const MAX_SPLIT_ID_CHECKS = 10;

/**
 * Refuses a whole-artist delete when the library holds the artist under
 * another MusicBrainz id that Lidarr resolves to the SAME artist.
 *
 * The artist-scope engine splits an artist title into one group per id when
 * the title carries several (`splitArtistGroupByMbid`) — two different bands
 * called "Nirvana". But one artist can carry two ids too: an id MusicBrainz has
 * since merged (Lidarr answers the old id with the merged artist), or Jellyfin
 * falling back to a track artist's id. Then each group holds part of the
 * artist, its play counts read only that part, and a "not played" rule
 * matching one part would delete the whole artist, the played part included.
 * Nothing in the library can tell the two cases apart; Lidarr can.
 */
async function refuseSplitArtistDelete(
  client: LidarrClient,
  artist: { id: number; artistName: string },
  action: ActionRecord,
): Promise<void> {
  const mbid = action.mediaItem.externalIds.find((e) => e.source === "MUSICBRAINZ")?.externalId;
  const row = await prisma.mediaItem.findUnique({
    where: { id: action.mediaItem.id },
    select: { libraryId: true, parentTitle: true },
  });
  if (!mbid || !row?.parentTitle) return;
  const others = await prisma.mediaItemExternalId.findMany({
    where: {
      source: "MUSICBRAINZ",
      externalId: { not: mbid },
      mediaItem: { libraryId: row.libraryId, type: "MUSIC", parentTitle: row.parentTitle },
    },
    select: { externalId: true },
    distinct: ["externalId"],
    take: MAX_SPLIT_ID_CHECKS + 1,
  });
  if (others.length > MAX_SPLIT_ID_CHECKS) {
    throw new Error(
      `"${row.parentTitle}" is held under more than ${MAX_SPLIT_ID_CHECKS} MusicBrainz artist ids in this library; refusing to delete the artist`,
    );
  }
  for (const { externalId } of others) {
    const other = await client.getArtistByMusicBrainzId(externalId);
    if (other?.id === artist.id) {
      throw new Error(
        `Lidarr resolves MusicBrainz ids ${mbid} and ${externalId} to the same artist ("${artist.artistName}"), ` +
          "but the library holds its tracks under both, so they were evaluated as two artists; refusing to delete it",
      );
    }
  }
}

async function executeUnmonitorDeleteFilesLidarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  await session.update<LidarrArtist>("LIDARR", { monitored: false });
  const { client, record: artist } = await artistOf(session);
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

// --- Episode-level file deletion helper ---

/**
 * Resolve which Sonarr episode files an action should delete.
 *
 * Sonarr file-delete action types are member-scoped (see
 * MEMBER_SCOPED_ACTION_TYPES): they act only on the episodes named by
 * `matchedMediaItemIds`. When that list is empty there is no explicit
 * whole-series signal on the action record to distinguish a genuine
 * whole-series intent from member ids that were lost between scheduling and
 * execution — so we refuse to delete the WHOLE series and skip instead. A
 * stale "delete all episode files" fallback here could wipe an entire series
 * because a few member ids went missing.
 */
/** What a member-scoped file delete actually removed. */
interface MemberFileDeletion {
  /** Our member ids whose files were deleted — what `deletedBytes` counts. */
  deletedMemberIds: string[];
  /** The Arr-side ids of the same members, for a follow-up monitor/search. */
  arrItemIds: number[];
}

const NOTHING_DELETED: MemberFileDeletion = { deletedMemberIds: [], arrItemIds: [] };

async function deleteEpisodeFilesForAction(
  client: SonarrClient,
  seriesId: number,
  action: ActionRecord,
): Promise<MemberFileDeletion> {
  if (action.matchedMediaItemIds.length > 0) {
    return deleteMatchedEpisodeFiles(client, seriesId, action.matchedMediaItemIds);
  }
  // Member-scoped action with no targeted episodes — skip rather than delete
  // the entire series' files. Conservative by design (media deletion pipeline).
  if (actionHonorsMemberIds(action.actionType)) {
    logger.warn(
      "Lifecycle",
      `Skipping ${action.actionType} file deletion for series "${seriesTitleOf(action.mediaItem)}" — no matched episodes resolved (refusing to delete all episode files without a whole-series signal)`,
    );
    return NOTHING_DELETED;
  }
  // Non-member-scoped action types should never reach here, but if they do,
  // there is nothing scoped to act on — skip.
  logger.warn(
    "Lifecycle",
    `Skipping ${action.actionType} file deletion for series "${seriesTitleOf(action.mediaItem)}" — no episodes to act on`,
  );
  return NOTHING_DELETED;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether our episode's air date rules out the Sonarr episode sharing its
 * season/episode numbers. The numbers alone are not an identity: a show the
 * media server orders differently from Sonarr (absolute or DVD order, common
 * for anime) puts a different episode at the same S/E. Two days of slack covers
 * a local date against a UTC one. Silence on either side proves nothing.
 */
function airDatesContradict(ours: Date | null, sonarrAirDate: string | undefined): boolean {
  if (!ours || !sonarrAirDate) return false;
  const theirs = Date.parse(`${sonarrAirDate}T00:00:00Z`);
  if (Number.isNaN(theirs)) return false;
  return Math.abs(ours.getTime() - theirs) > 2 * DAY_MS;
}

const formatSE = (season: number, episode: number) =>
  `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

/** Our episodes resolved to Sonarr's, by season/episode number checked against air date. */
interface ResolvedSonarrEpisodes {
  sonarrEpisodes: SonarrEpisode[];
  /** Sonarr episode id → our member id. */
  memberBySonarrId: Map<number, string>;
  /** How many of our episodes were found in the database. */
  found: number;
  unresolved: number;
}

async function resolveSonarrEpisodes(
  client: SonarrClient,
  seriesId: number,
  matchedMediaItemIds: string[],
): Promise<ResolvedSonarrEpisodes> {
  // Look up matched episodes from DB to get season/episode numbers
  const episodes = await prisma.mediaItem.findMany({
    where: { id: { in: matchedMediaItemIds } },
    select: { id: true, seasonNumber: true, episodeNumber: true, originallyAvailableAt: true },
  });

  if (episodes.length !== matchedMediaItemIds.length) {
    // Some matched IDs no longer exist in the DB (likely removed by a sync between
    // scheduling and execution). Proceed with what's still there — the missing
    // items can't be deleted via Sonarr because we can't resolve their season/episode.
    logger.warn(
      "Lifecycle",
      `Episode lookup mismatch: requested ${matchedMediaItemIds.length} IDs, found ${episodes.length} in DB`
    );
  }

  const sonarrEpisodes = await client.getEpisodes(seriesId);
  const sonarrBySE = new Map(sonarrEpisodes.map((ep) => [`${ep.seasonNumber}:${ep.episodeNumber}`, ep]));

  // Our member for each Sonarr episode it resolved to. Only episodes with both
  // numbers are keyed: a null season/episode would produce "null:null" and
  // either match nothing or match unrelated Sonarr episodes — skip and warn
  // rather than guess.
  const memberBySonarrId = new Map<number, string>();
  let unresolved = 0;
  for (const e of episodes) {
    if (e.seasonNumber === null || e.episodeNumber === null) {
      logger.warn(
        "Lifecycle",
        `Skipping episode with null seasonNumber or episodeNumber in matched set for Sonarr series ${seriesId}`
      );
      unresolved++;
      continue;
    }
    const sonarrEp = sonarrBySE.get(`${e.seasonNumber}:${e.episodeNumber}`);
    if (!sonarrEp) {
      unresolved++;
      continue;
    }
    if (airDatesContradict(e.originallyAvailableAt, sonarrEp.airDate)) {
      logger.warn(
        "Lifecycle",
        `Skipping ${formatSE(e.seasonNumber, e.episodeNumber)} of Sonarr series ${seriesId}: the media server's air date (${e.originallyAvailableAt!.toISOString().slice(0, 10)}) does not match Sonarr's (${sonarrEp.airDate}) — the two number the show differently`,
      );
      unresolved++;
      continue;
    }
    memberBySonarrId.set(sonarrEp.id, e.id);
  }

  return { sonarrEpisodes, memberBySonarrId, found: episodes.length, unresolved };
}

async function deleteMatchedEpisodeFiles(
  client: SonarrClient,
  seriesId: number,
  matchedMediaItemIds: string[],
): Promise<MemberFileDeletion> {
  const { sonarrEpisodes, memberBySonarrId, found, unresolved } =
    await resolveSonarrEpisodes(client, seriesId, matchedMediaItemIds);

  if (found > 0 && memberBySonarrId.size === 0) {
    // Recording this as done would report a delete that never happened.
    throw new Error(
      `None of the ${found} matched episode(s) could be matched to an episode in Sonarr series ${seriesId} — nothing was deleted`,
    );
  }

  // One Sonarr file can hold several episodes (S01E01-E02). Delete a file only
  // when EVERY episode it holds is one we matched: deleting it for one member
  // deletes the others too, including an episode that did not match the rule
  // or is protected by an exception (excepted members never reach here).
  const episodesByFile = new Map<number, typeof sonarrEpisodes>();
  for (const ep of sonarrEpisodes) {
    if (!(ep.episodeFileId > 0)) continue;
    const list = episodesByFile.get(ep.episodeFileId) ?? [];
    list.push(ep);
    episodesByFile.set(ep.episodeFileId, list);
  }
  const fileIds: number[] = [];
  const deletedMemberIds: string[] = [];
  const arrItemIds: number[] = [];
  for (const [fileId, holders] of episodesByFile) {
    if (!holders.some((ep) => memberBySonarrId.has(ep.id))) continue;
    const unmatched = holders.filter((ep) => !memberBySonarrId.has(ep.id));
    if (unmatched.length > 0) {
      logger.warn(
        "Lifecycle",
        `Skipping episode file ${fileId} of Sonarr series ${seriesId}: it also holds ${unmatched.map((ep) => formatSE(ep.seasonNumber, ep.episodeNumber)).join(", ")}, which did not match`,
      );
      continue;
    }
    fileIds.push(fileId);
    for (const ep of holders) {
      deletedMemberIds.push(memberBySonarrId.get(ep.id)!);
      arrItemIds.push(ep.id);
    }
  }
  // Matched episodes whose file is already gone are re-searched like the rest.
  for (const [sonarrId] of memberBySonarrId) {
    const ep = sonarrEpisodes.find((x) => x.id === sonarrId)!;
    if (!(ep.episodeFileId > 0)) arrItemIds.push(sonarrId);
  }

  if (fileIds.length > 0) {
    logger.info("Lifecycle", `Deleting ${fileIds.length} matched episode files (${found} episodes matched${unresolved > 0 ? `, ${unresolved} not found in Sonarr` : ""}) for Sonarr series ${seriesId}`);
    await client.deleteEpisodeFiles(fileIds);
  } else {
    logger.warn("Lifecycle", `No episode files deleted for Sonarr series ${seriesId} (${found} episodes matched${unresolved > 0 ? `, ${unresolved} not found in Sonarr` : ""}; none had a file it could delete on its own)`);
  }
  return { deletedMemberIds, arrItemIds };
}

/**
 * The Sonarr episode ids of an episode-scoped action's members. Throws when
 * none resolve: recording the action as done would report a change that never
 * happened, and falling back to the series would act on episodes nobody picked.
 */
async function episodeScopeIds(session: ActionArrSession, action: ActionRecord): Promise<number[]> {
  if (action.matchedMediaItemIds.length === 0) {
    throw new Error("No episodes to act on");
  }
  const { client, record: series } = await seriesOf(session);
  const { memberBySonarrId, found } = await resolveSonarrEpisodes(client, series.id, action.matchedMediaItemIds);
  if (memberBySonarrId.size === 0) {
    throw new Error(
      `None of the ${found} selected episode(s) could be matched to an episode in Sonarr series ${series.id} — nothing was changed`,
    );
  }
  return [...memberBySonarrId.keys()];
}

async function executeUnmonitorSonarr(session: ActionArrSession, action: ActionRecord) {
  if (!action.episodeScope) return executeUnmonitor(session, "SONARR");
  const ids = await episodeScopeIds(session, action);
  const { client } = await seriesOf(session);
  await client.setEpisodesMonitored(ids, false);
}

async function executeSearchSonarr(session: ActionArrSession, action: ActionRecord) {
  if (!action.episodeScope) return executeSearch(session, "SONARR");
  const ids = await episodeScopeIds(session, action);
  const { client } = await seriesOf(session);
  await client.triggerEpisodeSearch(ids);
}

// --- Track-level file deletion helper (Lidarr) ---

/**
 * A track title compared as written: lower-cased, accents and punctuation
 * dropped, but nothing removed. `normalizeTitle` drops anything in brackets,
 * which is right for matching a movie or show to its Arr record and wrong for
 * telling tracks apart — "Song" and "Song (Demo)" on one deluxe album are two
 * files.
 */
function trackTitleKey(title: string | null | undefined): string {
  return (title ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Our track's own MusicBrainz id (recording or release-track), if the sync stored one. */
const TRACK_MBID_SOURCES = new Set(["MBID", "MUSICBRAINZ_TRACK"]);

/**
 * Resolve and delete only the Lidarr track files for the matched tracks.
 *
 * Mirrors the Sonarr `deleteEpisodeFilesForAction` philosophy: Lidarr
 * file-delete actions are member-scoped (see MEMBER_SCOPED_ACTION_TYPES), so
 * they must NOT delete the entire artist. The matched member set is
 * `matchedMediaItemIds` (artist-scope rules), or the action's own
 * `mediaItem.id` when empty (track-scope rules schedule one action per track).
 *
 * Each track resolves to exactly one Lidarr track or to none, by, in order:
 * its MusicBrainz track/recording id; its disc and track number on the one
 * Lidarr album its album title names (with a title that agrees); its exact
 * title on that album. Any ambiguity — two Lidarr albums under one title, two
 * tracks under one key — leaves the track unresolved. There is no title-only
 * fallback across albums: the same song on a live album or a compilation is a
 * different file. Under-deletion is the safe direction for a deletion path.
 */
async function deleteTrackFilesForAction(
  client: LidarrClient,
  artist: { id: number; artistName: string },
  action: ActionRecord,
): Promise<MemberFileDeletion> {
  const memberIds =
    action.matchedMediaItemIds.length > 0
      ? action.matchedMediaItemIds
      : [action.mediaItem.id];

  const tracks = await prisma.mediaItem.findMany({
    where: { id: { in: memberIds }, type: "MUSIC" },
    select: {
      id: true,
      albumTitle: true,
      title: true,
      seasonNumber: true,
      episodeNumber: true,
      externalIds: { select: { source: true, externalId: true } },
    },
  });

  if (tracks.length === 0) {
    logger.warn(
      "Lifecycle",
      `Skipping ${action.actionType} for artist "${artist.artistName}" — no matched tracks resolved (refusing to delete the whole artist)`,
    );
    return NOTHING_DELETED;
  }

  const [lidarrTracks, lidarrAlbums] = await Promise.all([
    client.getTracks(artist.id),
    client.getAlbums(artist.id),
  ]);
  const albumsByTitle = new Map<string, number[]>();
  for (const album of lidarrAlbums) {
    const key = normalizeTitle(album.title);
    albumsByTitle.set(key, [...(albumsByTitle.get(key) ?? []), album.id]);
  }
  const tracksByAlbum = new Map<number, LidarrTrack[]>();
  for (const t of lidarrTracks) {
    tracksByAlbum.set(t.albumId, [...(tracksByAlbum.get(t.albumId) ?? []), t]);
  }
  const only = <T,>(list: T[]): T | null => (list.length === 1 ? list[0] : null);

  const resolve = (track: (typeof tracks)[number]): LidarrTrack | null => {
    const mbids = track.externalIds
      .filter((e) => TRACK_MBID_SOURCES.has(e.source))
      .map((e) => e.externalId.toLowerCase());
    if (mbids.length > 0) {
      const byMbid = lidarrTracks.filter((t) =>
        [t.foreignTrackId, t.foreignRecordingId].some((id) => id && mbids.includes(id.toLowerCase())),
      );
      if (byMbid.length > 0) return only(byMbid);
    }
    const albumId = only(albumsByTitle.get(normalizeTitle(track.albumTitle ?? "")) ?? []);
    if (albumId === null) return null;
    const onAlbum = tracksByAlbum.get(albumId) ?? [];
    const title = trackTitleKey(track.title);
    if (track.episodeNumber !== null) {
      const atPosition = onAlbum.filter(
        (t) =>
          Number.parseInt(t.trackNumber ?? "", 10) === track.episodeNumber &&
          (track.seasonNumber === null || t.mediumNumber === undefined || t.mediumNumber === track.seasonNumber),
      );
      const hit = only(atPosition);
      // The position must not contradict the title: a re-ordered edition puts
      // another song at the same number.
      if (hit && normalizeTitle(hit.title) === normalizeTitle(track.title ?? "")) return hit;
    }
    return only(onAlbum.filter((t) => trackTitleKey(t.title) === title));
  };

  const memberByLidarrId = new Map<number, string>();
  for (const track of tracks) {
    const hit = resolve(track);
    if (hit) memberByLidarrId.set(hit.id, track.id);
  }

  // One file per track is the norm, but never delete a file that also backs a
  // track we did not match.
  const holdersByFile = new Map<number, LidarrTrack[]>();
  for (const t of lidarrTracks) {
    if (!t.hasFile || !(t.trackFileId > 0)) continue;
    holdersByFile.set(t.trackFileId, [...(holdersByFile.get(t.trackFileId) ?? []), t]);
  }
  const fileIds: number[] = [];
  const deletedMemberIds: string[] = [];
  const arrItemIds: number[] = [];
  for (const [fileId, holders] of holdersByFile) {
    if (!holders.some((t) => memberByLidarrId.has(t.id))) continue;
    if (holders.some((t) => !memberByLidarrId.has(t.id))) continue;
    fileIds.push(fileId);
    for (const t of holders) {
      deletedMemberIds.push(memberByLidarrId.get(t.id)!);
      arrItemIds.push(t.id);
    }
  }

  if (fileIds.length === 0) {
    logger.warn(
      "Lifecycle",
      `Skipping ${action.actionType} for artist "${artist.artistName}" — could not correlate any matched track to a Lidarr track file (refusing to delete the whole artist)`,
    );
    if (memberByLidarrId.size === 0) {
      throw new Error(
        `None of the ${tracks.length} matched track(s) could be matched to a track of Lidarr artist "${artist.artistName}" — nothing was deleted`,
      );
    }
    return NOTHING_DELETED;
  }

  logger.info(
    "Lifecycle",
    `Deleting ${fileIds.length} matched track file(s) (${tracks.length} tracks matched, ${tracks.length - memberByLidarrId.size} not found in Lidarr) for Lidarr artist "${artist.artistName}"`,
  );
  await client.deleteTrackFiles(fileIds);
  return { deletedMemberIds, arrItemIds };
}

// --- Monitor & Delete Files executors ---

async function executeMonitorDeleteFilesRadarr(session: ActionArrSession, action: ActionRecord) {
  if (!(await movieOf(session)).record.monitored) {
    await session.update<RadarrMovie>("RADARR", { monitored: true });
  }
  const { client, record: movie } = await movieOf(session);
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeMonitorDeleteFilesSonarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  if (!(await seriesOf(session)).record.monitored) {
    await session.update<SonarrSeries>("SONARR", { monitored: true });
  }
  const { client, record: series } = await seriesOf(session);
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  // Monitoring the series alone leaves the episodes as they were — and Sonarr's
  // "Unmonitor Deleted Episodes" setting unmonitors the ones just deleted — so
  // monitor the episodes acted on, after the delete.
  await client.setEpisodesMonitored(deleted.arrItemIds, true);
  if (action.searchAfterAction) {
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeMonitorDeleteFilesLidarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  if (!(await artistOf(session)).record.monitored) {
    await session.update<LidarrArtist>("LIDARR", { monitored: true });
  }
  const { client, record: artist } = await artistOf(session);
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

// --- Delete Files Only executors (no monitor change) ---

async function executeDeleteFilesRadarr(session: ActionArrSession, action: ActionRecord) {
  const { client, record: movie } = await movieOf(session);
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeDeleteFilesSonarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  const { client, record: series } = await seriesOf(session);
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  if (action.searchAfterAction) {
    // By id: a series search skips unmonitored seasons and episodes, and
    // Sonarr may have unmonitored the episodes it just deleted.
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeDeleteFilesLidarr(session: ActionArrSession, action: ActionRecord): Promise<ActionOutcome> {
  const { client, record: artist } = await artistOf(session);
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

// --- Change Quality Profile / Search executors (every family alike) ---

async function executeChangeQualityProfile(session: ActionArrSession, action: ActionRecord, family: ArrFamily) {
  if (action.targetQualityProfileId == null) {
    throw new Error("No target quality profile configured");
  }
  const { record, adapter } = await session.resolve(family);
  if (record.qualityProfileId === action.targetQualityProfileId) {
    logger.info(
      "Lifecycle",
      `Skipping ${action.actionType} for "${adapter.name(record)}" — already on profile ${action.targetQualityProfileId}`,
    );
    return;
  }
  const updated = await session.update(family, { qualityProfileId: action.targetQualityProfileId });
  if (action.searchAfterAction) {
    const { client } = await session.resolve(family);
    await adapter.search(client, updated);
  }
}

/** Trigger a fresh search for a new copy, no other change. */
async function executeSearch(session: ActionArrSession, family: ArrFamily) {
  const { client, record, adapter } = await session.resolve(family);
  await adapter.search(client, record);
}

// --- Main dispatch ---

export async function executeAction(
  action: ActionRecord,
  /**
   * Optional reporter for the sub-step currently running within this single
   * item (tags → main action). Lets a streaming caller surface the multi-step
   * nature of an action (e.g. "Updating tags" then "Change Quality Profile").
   */
  onStep?: (label: string) => void,
  /**
   * Shared by every action of one run (`ArrExecutionContext`), so the run
   * reads each instance's family and tags once. Omitted, the call reads for
   * itself.
   */
  ctx: ArrExecutionContext = new ArrExecutionContext(),
): Promise<ActionOutcome> {
  let outcome: ActionOutcome = {};
  const session = new ActionArrSession(action, ctx);
  logger.info("Lifecycle", `Starting ${action.actionType} for "${action.targetTitle}" (item: ${action.mediaItem.id}, arr: ${action.arrInstanceId ?? "none"}${action.matchedMediaItemIds.length > 0 ? `, ${action.matchedMediaItemIds.length} matched episodes` : ""})`);

  // Execute tag operations before the main action
  if (action.addArrTags.length > 0 || action.removeArrTags.length > 0) {
    onStep?.("Updating tags");
    await executeTagOperations(session, action);
    const tagOps: string[] = [];
    if (action.addArrTags.length > 0) tagOps.push(`+tags: ${action.addArrTags.join(", ")}`);
    if (action.removeArrTags.length > 0) tagOps.push(`-tags: ${action.removeArrTags.join(", ")}`);
    logger.info("Lifecycle", `Tag operations for "${action.targetTitle}": ${tagOps.join("; ")}`);
  }

  // Report the main step. DELETE_FILES / quality-profile actions also trigger a
  // follow-up search inside their executor when searchAfterAction is set, so
  // note that here rather than instrumenting every executor.
  if (action.actionType !== "DO_NOTHING") {
    const willSearchAfter = action.searchAfterAction && supportsSearchAfter(action.actionType);
    onStep?.(formatActionLabel(action.actionType) + (willSearchAfter ? " → search" : ""));
  }

  switch (action.actionType) {
    case "DO_NOTHING":
      // No-op: record exists for monitoring/reporting purposes
      break;
    case "DELETE_RADARR":
      await executeDeleteRadarr(session, action);
      break;
    case "DELETE_SONARR":
      await executeDeleteSonarr(session, action);
      break;
    case "UNMONITOR_RADARR":
      await executeUnmonitor(session, "RADARR");
      break;
    case "UNMONITOR_SONARR":
      await executeUnmonitorSonarr(session, action);
      break;
    case "UNMONITOR_DELETE_FILES_RADARR":
      await executeUnmonitorDeleteFilesRadarr(session, action);
      break;
    case "UNMONITOR_DELETE_FILES_SONARR":
      outcome = await executeUnmonitorDeleteFilesSonarr(session, action);
      break;
    case "DELETE_LIDARR":
      await executeDeleteLidarr(session, action);
      break;
    case "UNMONITOR_LIDARR":
      await executeUnmonitor(session, "LIDARR");
      break;
    case "UNMONITOR_DELETE_FILES_LIDARR":
      outcome = await executeUnmonitorDeleteFilesLidarr(session, action);
      break;
    case "MONITOR_DELETE_FILES_RADARR":
      await executeMonitorDeleteFilesRadarr(session, action);
      break;
    case "MONITOR_DELETE_FILES_SONARR":
      outcome = await executeMonitorDeleteFilesSonarr(session, action);
      break;
    case "MONITOR_DELETE_FILES_LIDARR":
      outcome = await executeMonitorDeleteFilesLidarr(session, action);
      break;
    case "DELETE_FILES_RADARR":
      await executeDeleteFilesRadarr(session, action);
      break;
    case "DELETE_FILES_SONARR":
      outcome = await executeDeleteFilesSonarr(session, action);
      break;
    case "DELETE_FILES_LIDARR":
      outcome = await executeDeleteFilesLidarr(session, action);
      break;
    case "CHANGE_QUALITY_PROFILE_RADARR":
      await executeChangeQualityProfile(session, action, "RADARR");
      break;
    case "CHANGE_QUALITY_PROFILE_SONARR":
      await executeChangeQualityProfile(session, action, "SONARR");
      break;
    case "CHANGE_QUALITY_PROFILE_LIDARR":
      await executeChangeQualityProfile(session, action, "LIDARR");
      break;
    case "SEARCH_RADARR":
      await executeSearch(session, "RADARR");
      break;
    case "SEARCH_SONARR":
      await executeSearchSonarr(session, action);
      break;
    case "SEARCH_LIDARR":
      await executeSearch(session, "LIDARR");
      break;
    default:
      throw new Error(`Unknown action type: ${action.actionType}`);
  }

  logger.info(
    "Lifecycle",
    `Executed ${action.actionType} for "${action.targetTitle}"${deletesArrRecord(action.actionType) && action.addImportExclusion ? " (with import exclusion)" : ""}`
  );
  return outcome;
}
