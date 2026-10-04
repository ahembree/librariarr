import axios from "axios";
import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient, type LidarrTrack } from "@/lib/arr/lidarr-client";
import { logger } from "@/lib/logger";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { actionHonorsMemberIds, formatActionLabel, supportsSearchAfter } from "@/lib/lifecycle/action-types";
import { seriesTitleOf } from "@/lib/media/display-title";

// Re-export constants so server-side consumers can import from here too
export { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";

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
export type YearMatchMode = "release" | "episodeOfSeries";

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

// --- Arr resolution helpers ---

async function resolveRadarrMovie(action: ActionRecord) {
  if (!action.arrInstanceId) throw new Error("No Arr instance configured");
  const instance = await prisma.radarrInstance.findUnique({
    where: { id: action.arrInstanceId },
  });
  if (!instance) throw new Error("Radarr instance not found");
  if (!instance.enabled) throw new Error("Radarr instance is disabled");

  const client = new RadarrClient(instance.url, instance.apiKey);
  const tmdbId = action.mediaItem.externalIds.find((e) => e.source === "TMDB");
  if (!tmdbId) throw new Error("No TMDB ID found for item");

  const movie = await client.getMovieByTmdbId(parseInt(tmdbId.externalId));
  if (!movie) throw new Error("Movie not found in Radarr");

  if (!action.skipTitleValidation) {
    validateArrItem(action.mediaItem.parentTitle ?? action.mediaItem.title, movie.title, "Radarr movie", tmdbId.externalId, action.mediaItem.year, movie.year);
  }

  return { client, movie };
}

async function resolveSonarrSeries(action: ActionRecord) {
  if (!action.arrInstanceId) throw new Error("No Arr instance configured");
  const instance = await prisma.sonarrInstance.findUnique({
    where: { id: action.arrInstanceId },
  });
  if (!instance) throw new Error("Sonarr instance not found");
  if (!instance.enabled) throw new Error("Sonarr instance is disabled");

  const client = new SonarrClient(instance.url, instance.apiKey);
  const tvdbId = action.mediaItem.externalIds.find((e) => e.source === "TVDB");
  if (!tvdbId) throw new Error("No TVDB ID found for item");

  const series = await client.getSeriesByTvdbId(parseInt(tvdbId.externalId));
  if (!series) throw new Error("Series not found in Sonarr");

  if (!action.skipTitleValidation) {
    // `action.mediaItem.year` is the EPISODE air year (episodes are stored as
    // individual MediaItem rows), but Sonarr returns the SERIES premiere year —
    // so use the one-directional series year guard, not the symmetric one.
    validateArrItem(action.mediaItem.parentTitle ?? action.mediaItem.title, series.title, "Sonarr series", tvdbId.externalId, action.mediaItem.year, series.year, "episodeOfSeries");
  }

  return { client, series };
}

async function resolveLidarrArtist(action: ActionRecord) {
  if (!action.arrInstanceId) throw new Error("No Arr instance configured");
  const instance = await prisma.lidarrInstance.findUnique({
    where: { id: action.arrInstanceId },
  });
  if (!instance) throw new Error("Lidarr instance not found");
  if (!instance.enabled) throw new Error("Lidarr instance is disabled");

  const client = new LidarrClient(instance.url, instance.apiKey);
  const mbId = action.mediaItem.externalIds.find((e) => e.source === "MUSICBRAINZ");
  if (!mbId) throw new Error("No MusicBrainz ID found for item");

  const artist = await client.getArtistByMusicBrainzId(mbId.externalId);
  if (!artist) throw new Error("Artist not found in Lidarr");

  if (!action.skipTitleValidation) {
    validateArrItem(action.mediaItem.parentTitle ?? action.mediaItem.title, artist.artistName, "Lidarr artist", mbId.externalId);
  }

  return { client, artist };
}

// --- Tag operations ---

async function executeTagOperations(action: ActionRecord): Promise<void> {
  if (!action.arrInstanceId) throw new Error("No Arr instance configured for tag operations");

  const actionType = action.actionType;
  const isRadarr = actionType.endsWith("_RADARR") || actionType === "DO_NOTHING";
  const isSonarr = actionType.endsWith("_SONARR");
  const isLidarr = actionType.endsWith("_LIDARR");

  // Determine Arr type from instance if actionType is DO_NOTHING
  if (actionType === "DO_NOTHING") {
    const [radarr, sonarr, lidarr] = await Promise.all([
      prisma.radarrInstance.findUnique({ where: { id: action.arrInstanceId! } }),
      prisma.sonarrInstance.findUnique({ where: { id: action.arrInstanceId! } }),
      prisma.lidarrInstance.findUnique({ where: { id: action.arrInstanceId! } }),
    ]);
    if (radarr) return executeRadarrTagOps(action);
    if (sonarr) return executeSonarrTagOps(action);
    if (lidarr) return executeLidarrTagOps(action);
    throw new Error("Arr instance not found");
  }

  if (isRadarr) return executeRadarrTagOps(action);
  if (isSonarr) return executeSonarrTagOps(action);
  if (isLidarr) return executeLidarrTagOps(action);
  throw new Error(`Unsupported actionType for tag operations: ${actionType}`);
}

async function executeRadarrTagOps(action: ActionRecord): Promise<void> {
  const { client, movie } = await resolveRadarrMovie(action);
  const tags = await client.getTags();
  const tagMap = new Map(tags.map((t) => [t.label.toLowerCase(), t.id]));

  const currentTags = new Set(movie.tags);

  // Add tags (find-or-create)
  for (const label of action.addArrTags) {
    let tagId = tagMap.get(label.toLowerCase());
    if (tagId === undefined) {
      const created = await client.createTag(label);
      tagId = created.id;
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
  if (newTags.length !== movie.tags.length || !newTags.every((t) => movie.tags.includes(t))) {
    await client.updateMovie(movie.id, { tags: newTags });
  }
}

async function executeSonarrTagOps(action: ActionRecord): Promise<void> {
  const { client, series } = await resolveSonarrSeries(action);
  const tags = await client.getTags();
  const tagMap = new Map(tags.map((t) => [t.label.toLowerCase(), t.id]));

  const currentTags = new Set(series.tags);

  for (const label of action.addArrTags) {
    let tagId = tagMap.get(label.toLowerCase());
    if (tagId === undefined) {
      const created = await client.createTag(label);
      tagId = created.id;
    }
    currentTags.add(tagId);
  }

  for (const label of action.removeArrTags) {
    const tagId = tagMap.get(label.toLowerCase());
    if (tagId !== undefined) {
      currentTags.delete(tagId);
    }
  }

  const newTags = [...currentTags];
  if (newTags.length !== series.tags.length || !newTags.every((t) => series.tags.includes(t))) {
    await client.updateSeries(series.id, { tags: newTags });
  }
}

async function executeLidarrTagOps(action: ActionRecord): Promise<void> {
  const { client, artist } = await resolveLidarrArtist(action);
  const tags = await client.getTags();
  const tagMap = new Map(tags.map((t) => [t.label.toLowerCase(), t.id]));

  const currentTags = new Set(artist.tags);

  for (const label of action.addArrTags) {
    let tagId = tagMap.get(label.toLowerCase());
    if (tagId === undefined) {
      const created = await client.createTag(label);
      tagId = created.id;
    }
    currentTags.add(tagId);
  }

  for (const label of action.removeArrTags) {
    const tagId = tagMap.get(label.toLowerCase());
    if (tagId !== undefined) {
      currentTags.delete(tagId);
    }
  }

  const newTags = [...currentTags];
  if (newTags.length !== artist.tags.length || !newTags.every((t) => artist.tags.includes(t))) {
    await client.updateArtist(artist.id, { tags: newTags });
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
  const [radarr, sonarr, lidarr] = await Promise.all([
    prisma.radarrInstance.findUnique({ where: { id: arrInstanceId } }),
    prisma.sonarrInstance.findUnique({ where: { id: arrInstanceId } }),
    prisma.lidarrInstance.findUnique({ where: { id: arrInstanceId } }),
  ]);

  if (radarr) {
    const client = new RadarrClient(radarr.url, radarr.apiKey);
    const tags = await client.getTags();
    const targetTags = tags.filter((t) =>
      tagLabels.some((label) => label.toLowerCase() === t.label.toLowerCase())
    );
    if (targetTags.length === 0) return;

    const targetIds = new Set(targetTags.map((t) => t.id));
    const movies = await client.getMovies();
    for (const movie of movies) {
      const filtered = movie.tags.filter((id) => !targetIds.has(id));
      if (filtered.length !== movie.tags.length) {
        await client.updateMovie(movie.id, { tags: filtered });
      }
    }
    for (const tag of targetTags) {
      await client.deleteTag(tag.id);
    }
  } else if (sonarr) {
    const client = new SonarrClient(sonarr.url, sonarr.apiKey);
    const tags = await client.getTags();
    const targetTags = tags.filter((t) =>
      tagLabels.some((label) => label.toLowerCase() === t.label.toLowerCase())
    );
    if (targetTags.length === 0) return;

    const targetIds = new Set(targetTags.map((t) => t.id));
    const allSeries = await client.getSeries();
    for (const s of allSeries) {
      const filtered = s.tags.filter((id) => !targetIds.has(id));
      if (filtered.length !== s.tags.length) {
        await client.updateSeries(s.id, { tags: filtered });
      }
    }
    for (const tag of targetTags) {
      await client.deleteTag(tag.id);
    }
  } else if (lidarr) {
    const client = new LidarrClient(lidarr.url, lidarr.apiKey);
    const tags = await client.getTags();
    const targetTags = tags.filter((t) =>
      tagLabels.some((label) => label.toLowerCase() === t.label.toLowerCase())
    );
    if (targetTags.length === 0) return;

    const targetIds = new Set(targetTags.map((t) => t.id));
    const artists = await client.getArtists();
    for (const a of artists) {
      const filtered = a.tags.filter((id) => !targetIds.has(id));
      if (filtered.length !== a.tags.length) {
        await client.updateArtist(a.id, { tags: filtered });
      }
    }
    for (const tag of targetTags) {
      await client.deleteTag(tag.id);
    }
  } else {
    throw new Error("Arr instance not found");
  }

  logger.info("Lifecycle", `Cleaned up tags [${tagLabels.join(", ")}] from ${type} items`);
}

// --- Individual action executors ---

async function executeDeleteRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  await client.deleteMovie(movie.id, true, action.addImportExclusion);
}

async function executeDeleteSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  await client.deleteSeries(series.id, true, action.addImportExclusion);
}

async function executeUnmonitorRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  await client.updateMovie(movie.id, { monitored: false });
  if (action.addImportExclusion) {
    await client.addExclusion(movie.tmdbId, movie.title, movie.year ?? action.mediaItem.year ?? 0);
  }
}

async function executeUnmonitorSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  await client.updateSeries(series.id, { monitored: false });
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
}

async function executeUnmonitorDeleteFilesRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  await client.updateMovie(movie.id, { monitored: false });
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.addImportExclusion) {
    await client.addExclusion(movie.tmdbId, movie.title, movie.year ?? action.mediaItem.year ?? 0);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeUnmonitorDeleteFilesSonarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, series } = await resolveSonarrSeries(action);
  await client.updateSeries(series.id, { monitored: false });
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterAction) {
    // A series search skips unmonitored seasons and episodes, and this action
    // just unmonitored the series — search the episodes acted on by id.
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeDeleteLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  await client.deleteArtist(artist.id, true, action.addImportExclusion);
}

async function executeUnmonitorLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  await client.updateArtist(artist.id, { monitored: false });
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
}

async function executeUnmonitorDeleteFilesLidarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, artist } = await resolveLidarrArtist(action);
  await client.updateArtist(artist.id, { monitored: false });
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
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

async function deleteMatchedEpisodeFiles(
  client: SonarrClient,
  seriesId: number,
  matchedMediaItemIds: string[],
): Promise<MemberFileDeletion> {
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

  if (episodes.length > 0 && memberBySonarrId.size === 0) {
    // Recording this as done would report a delete that never happened.
    throw new Error(
      `None of the ${episodes.length} matched episode(s) could be matched to an episode in Sonarr series ${seriesId} — nothing was deleted`,
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
    logger.info("Lifecycle", `Deleting ${fileIds.length} matched episode files (${episodes.length} episodes matched${unresolved > 0 ? `, ${unresolved} not found in Sonarr` : ""}) for Sonarr series ${seriesId}`);
    await client.deleteEpisodeFiles(fileIds);
  } else {
    logger.warn("Lifecycle", `No episode files deleted for Sonarr series ${seriesId} (${episodes.length} episodes matched${unresolved > 0 ? `, ${unresolved} not found in Sonarr` : ""}; none had a file it could delete on its own)`);
  }
  return { deletedMemberIds, arrItemIds };
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

async function executeMonitorDeleteFilesRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  if (!movie.monitored) {
    await client.updateMovie(movie.id, { monitored: true });
  }
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.addImportExclusion) {
    await client.addExclusion(movie.tmdbId, movie.title, movie.year ?? action.mediaItem.year ?? 0);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeMonitorDeleteFilesSonarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, series } = await resolveSonarrSeries(action);
  if (!series.monitored) {
    await client.updateSeries(series.id, { monitored: true });
  }
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  // Monitoring the series alone leaves the episodes as they were — and Sonarr's
  // "Unmonitor Deleted Episodes" setting unmonitors the ones just deleted — so
  // monitor the episodes acted on, after the delete.
  await client.setEpisodesMonitored(deleted.arrItemIds, true);
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterAction) {
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeMonitorDeleteFilesLidarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, artist } = await resolveLidarrArtist(action);
  if (!artist.monitored) {
    await client.updateArtist(artist.id, { monitored: true });
  }
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

// --- Delete Files Only executors (no monitor change) ---

async function executeDeleteFilesRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.addImportExclusion) {
    await client.addExclusion(movie.tmdbId, movie.title, movie.year ?? action.mediaItem.year ?? 0);
  }
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeDeleteFilesSonarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, series } = await resolveSonarrSeries(action);
  const deleted = await deleteEpisodeFilesForAction(client, series.id, action);
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterAction) {
    // By id: a series search skips unmonitored seasons and episodes, and
    // Sonarr may have unmonitored the episodes it just deleted.
    await client.triggerEpisodeSearch(deleted.arrItemIds);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

async function executeDeleteFilesLidarr(action: ActionRecord): Promise<ActionOutcome> {
  const { client, artist } = await resolveLidarrArtist(action);
  const deleted = await deleteTrackFilesForAction(client, artist, action);
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
  return { deletedMemberIds: deleted.deletedMemberIds };
}

// --- Change Quality Profile executors ---

async function executeChangeQualityProfileRadarr(action: ActionRecord) {
  if (action.targetQualityProfileId == null) {
    throw new Error("No target quality profile configured");
  }
  const { client, movie } = await resolveRadarrMovie(action);
  if (movie.qualityProfileId === action.targetQualityProfileId) {
    logger.info(
      "Lifecycle",
      `Skipping CHANGE_QUALITY_PROFILE_RADARR for "${movie.title}" — already on profile ${action.targetQualityProfileId}`,
    );
    return;
  }
  await client.updateMovie(movie.id, { qualityProfileId: action.targetQualityProfileId });
  if (action.searchAfterAction) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeChangeQualityProfileSonarr(action: ActionRecord) {
  if (action.targetQualityProfileId == null) {
    throw new Error("No target quality profile configured");
  }
  const { client, series } = await resolveSonarrSeries(action);
  if (series.qualityProfileId === action.targetQualityProfileId) {
    logger.info(
      "Lifecycle",
      `Skipping CHANGE_QUALITY_PROFILE_SONARR for "${series.title}" — already on profile ${action.targetQualityProfileId}`,
    );
    return;
  }
  await client.updateSeries(series.id, { qualityProfileId: action.targetQualityProfileId });
  if (action.searchAfterAction) {
    await client.triggerSeriesSearch(series.id);
  }
}

async function executeChangeQualityProfileLidarr(action: ActionRecord) {
  if (action.targetQualityProfileId == null) {
    throw new Error("No target quality profile configured");
  }
  const { client, artist } = await resolveLidarrArtist(action);
  if (artist.qualityProfileId === action.targetQualityProfileId) {
    logger.info(
      "Lifecycle",
      `Skipping CHANGE_QUALITY_PROFILE_LIDARR for "${artist.artistName}" — already on profile ${action.targetQualityProfileId}`,
    );
    return;
  }
  await client.updateArtist(artist.id, { qualityProfileId: action.targetQualityProfileId });
  if (action.searchAfterAction) {
    await client.triggerArtistSearch(artist.id);
  }
}

// --- Search executors (trigger a fresh search for a new copy, no other change) ---

async function executeSearchRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  await client.triggerMovieSearch(movie.id);
}

async function executeSearchSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  await client.triggerSeriesSearch(series.id);
}

async function executeSearchLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  await client.triggerArtistSearch(artist.id);
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
): Promise<ActionOutcome> {
  let outcome: ActionOutcome = {};
  logger.info("Lifecycle", `Starting ${action.actionType} for "${action.targetTitle}" (item: ${action.mediaItem.id}, arr: ${action.arrInstanceId ?? "none"}${action.matchedMediaItemIds.length > 0 ? `, ${action.matchedMediaItemIds.length} matched episodes` : ""})`);

  // Execute tag operations before the main action
  if (action.addArrTags.length > 0 || action.removeArrTags.length > 0) {
    onStep?.("Updating tags");
    await executeTagOperations(action);
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
      await executeDeleteRadarr(action);
      break;
    case "DELETE_SONARR":
      await executeDeleteSonarr(action);
      break;
    case "UNMONITOR_RADARR":
      await executeUnmonitorRadarr(action);
      break;
    case "UNMONITOR_SONARR":
      await executeUnmonitorSonarr(action);
      break;
    case "UNMONITOR_DELETE_FILES_RADARR":
      await executeUnmonitorDeleteFilesRadarr(action);
      break;
    case "UNMONITOR_DELETE_FILES_SONARR":
      outcome = await executeUnmonitorDeleteFilesSonarr(action);
      break;
    case "DELETE_LIDARR":
      await executeDeleteLidarr(action);
      break;
    case "UNMONITOR_LIDARR":
      await executeUnmonitorLidarr(action);
      break;
    case "UNMONITOR_DELETE_FILES_LIDARR":
      outcome = await executeUnmonitorDeleteFilesLidarr(action);
      break;
    case "MONITOR_DELETE_FILES_RADARR":
      await executeMonitorDeleteFilesRadarr(action);
      break;
    case "MONITOR_DELETE_FILES_SONARR":
      outcome = await executeMonitorDeleteFilesSonarr(action);
      break;
    case "MONITOR_DELETE_FILES_LIDARR":
      outcome = await executeMonitorDeleteFilesLidarr(action);
      break;
    case "DELETE_FILES_RADARR":
      await executeDeleteFilesRadarr(action);
      break;
    case "DELETE_FILES_SONARR":
      outcome = await executeDeleteFilesSonarr(action);
      break;
    case "DELETE_FILES_LIDARR":
      outcome = await executeDeleteFilesLidarr(action);
      break;
    case "CHANGE_QUALITY_PROFILE_RADARR":
      await executeChangeQualityProfileRadarr(action);
      break;
    case "CHANGE_QUALITY_PROFILE_SONARR":
      await executeChangeQualityProfileSonarr(action);
      break;
    case "CHANGE_QUALITY_PROFILE_LIDARR":
      await executeChangeQualityProfileLidarr(action);
      break;
    case "SEARCH_RADARR":
      await executeSearchRadarr(action);
      break;
    case "SEARCH_SONARR":
      await executeSearchSonarr(action);
      break;
    case "SEARCH_LIDARR":
      await executeSearchLidarr(action);
      break;
    default:
      throw new Error(`Unknown action type: ${action.actionType}`);
  }

  logger.info(
    "Lifecycle",
    `Executed ${action.actionType} for "${action.targetTitle}"${action.addImportExclusion ? " (with import exclusion)" : ""}`
  );
  return outcome;
}
