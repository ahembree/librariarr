import axios from "axios";
import { prisma } from "@/lib/db";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { logger } from "@/lib/logger";

// Re-export constants so server-side consumers can import from here too
export { MOVIE_ACTION_TYPES, SERIES_ACTION_TYPES, MUSIC_ACTION_TYPES } from "@/lib/lifecycle/action-types";

/** Extract a meaningful error message from Arr API failures, including the response body. */
export function extractActionError(error: unknown): string {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status;
    const data = error.response.data;
    // Arr services return errors as { message: "..." } or plain strings
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

// Type for the action record shape used by executors
export interface ActionRecord {
  id: string;
  actionType: string;
  arrInstanceId: string | null;
  addImportExclusion: boolean;
  searchAfterDelete: boolean;
  matchedMediaItemIds: string[];
  addArrTags: string[];
  removeArrTags: string[];
  skipTitleValidation?: boolean;
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
 * Handles common differences: article placement, year suffixes, punctuation, case.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/,\s*(the|a|an)$/i, "")   // "Matrix, The" → "Matrix"
    .replace(/^(the|a|an)\s+/i, "")     // "The Matrix" → "Matrix"
    .replace(/\s*\([^)]*\)\s*/g, " ")   // "Movie (2024)" → "Movie "
    .replace(/&/g, "and")               // "Fish & Chips" → "Fish and Chips"
    .replace(/[^\p{L}\p{N}\s]/gu, "")   // Remove non-alphanumeric (unicode-safe)
    .replace(/\s+/g, " ")               // Collapse whitespace
    .trim();
}

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
): void {
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
    validateArrItem(action.mediaItem.parentTitle ?? action.mediaItem.title, movie.title, "Radarr movie", tmdbId.externalId);
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
    validateArrItem(action.mediaItem.parentTitle ?? action.mediaItem.title, series.title, "Sonarr series", tvdbId.externalId);
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
    await client.addExclusion(movie.tmdbId, movie.title, action.mediaItem.year ?? 0);
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
    await client.addExclusion(movie.tmdbId, movie.title, action.mediaItem.year ?? 0);
  }
  if (action.searchAfterDelete) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeUnmonitorDeleteFilesSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  await client.updateSeries(series.id, { monitored: false });
  if (action.matchedMediaItemIds.length > 0) {
    await deleteMatchedEpisodeFiles(client, series.id, action.matchedMediaItemIds);
  } else {
    const files = await client.getEpisodeFiles(series.id);
    if (files.length > 0) {
      logger.info("Lifecycle", `Deleting ALL ${files.length} episode files for series "${action.mediaItem.title}" (series-scope mode)`);
      await client.deleteEpisodeFiles(files.map((f) => f.id));
    }
  }
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterDelete) {
    await client.triggerSeriesSearch(series.id);
  }
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

async function executeUnmonitorDeleteFilesLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  await client.updateArtist(artist.id, { monitored: false });
  const files = await client.getTrackFiles(artist.id);
  if (files.length > 0) {
    await client.deleteTrackFiles(files.map((f) => f.id));
  }
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
  if (action.searchAfterDelete) {
    await client.triggerArtistSearch(artist.id);
  }
}

// --- Episode-level file deletion helper ---

async function deleteMatchedEpisodeFiles(
  client: SonarrClient,
  seriesId: number,
  matchedMediaItemIds: string[],
): Promise<void> {
  // Look up matched episodes from DB to get season/episode numbers
  const episodes = await prisma.mediaItem.findMany({
    where: { id: { in: matchedMediaItemIds } },
    select: { seasonNumber: true, episodeNumber: true },
  });

  if (episodes.length !== matchedMediaItemIds.length) {
    logger.warn("Lifecycle", `Episode lookup mismatch: requested ${matchedMediaItemIds.length} IDs, found ${episodes.length} in DB`);
  }

  // Get all Sonarr episodes for the series
  const sonarrEpisodes = await client.getEpisodes(seriesId);

  // Find file IDs for matched episodes
  const matchSet = new Set(
    episodes.map((e) => `${e.seasonNumber}:${e.episodeNumber}`)
  );
  const fileIds = [
    ...new Set(
      sonarrEpisodes
        .filter((ep) => matchSet.has(`${ep.seasonNumber}:${ep.episodeNumber}`) && ep.episodeFileId > 0)
        .map((ep) => ep.episodeFileId)
    ),
  ];

  if (fileIds.length > 0) {
    logger.info("Lifecycle", `Deleting ${fileIds.length} matched episode files (${episodes.length} episodes matched) for Sonarr series ${seriesId}`);
    await client.deleteEpisodeFiles(fileIds);
  } else {
    logger.info("Lifecycle", `No episode files to delete for Sonarr series ${seriesId} (${episodes.length} episodes matched but no files found)`);
  }
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
    await client.addExclusion(movie.tmdbId, movie.title, action.mediaItem.year ?? 0);
  }
  if (action.searchAfterDelete) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeMonitorDeleteFilesSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  if (!series.monitored) {
    await client.updateSeries(series.id, { monitored: true });
  }
  if (action.matchedMediaItemIds.length > 0) {
    await deleteMatchedEpisodeFiles(client, series.id, action.matchedMediaItemIds);
  } else {
    const files = await client.getEpisodeFiles(series.id);
    if (files.length > 0) {
      logger.info("Lifecycle", `Deleting ALL ${files.length} episode files for series "${action.mediaItem.title}" (series-scope mode)`);
      await client.deleteEpisodeFiles(files.map((f) => f.id));
    }
  }
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterDelete) {
    await client.triggerSeriesSearch(series.id);
  }
}

async function executeMonitorDeleteFilesLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  if (!artist.monitored) {
    await client.updateArtist(artist.id, { monitored: true });
  }
  const files = await client.getTrackFiles(artist.id);
  if (files.length > 0) {
    await client.deleteTrackFiles(files.map((f) => f.id));
  }
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
  if (action.searchAfterDelete) {
    await client.triggerArtistSearch(artist.id);
  }
}

// --- Delete Files Only executors (no monitor change) ---

async function executeDeleteFilesRadarr(action: ActionRecord) {
  const { client, movie } = await resolveRadarrMovie(action);
  if (movie.hasFile && movie.movieFileId) {
    await client.deleteMovieFile(movie.movieFileId);
  }
  if (action.addImportExclusion) {
    await client.addExclusion(movie.tmdbId, movie.title, action.mediaItem.year ?? 0);
  }
  if (action.searchAfterDelete) {
    await client.triggerMovieSearch(movie.id);
  }
}

async function executeDeleteFilesSonarr(action: ActionRecord) {
  const { client, series } = await resolveSonarrSeries(action);
  if (action.matchedMediaItemIds.length > 0) {
    await deleteMatchedEpisodeFiles(client, series.id, action.matchedMediaItemIds);
  } else {
    const files = await client.getEpisodeFiles(series.id);
    if (files.length > 0) {
      logger.info("Lifecycle", `Deleting ALL ${files.length} episode files for series "${action.mediaItem.title}" (series-scope mode)`);
      await client.deleteEpisodeFiles(files.map((f) => f.id));
    }
  }
  if (action.addImportExclusion) {
    await client.addExclusion(series.tvdbId, series.title);
  }
  if (action.searchAfterDelete) {
    await client.triggerSeriesSearch(series.id);
  }
}

async function executeDeleteFilesLidarr(action: ActionRecord) {
  const { client, artist } = await resolveLidarrArtist(action);
  const files = await client.getTrackFiles(artist.id);
  if (files.length > 0) {
    await client.deleteTrackFiles(files.map((f) => f.id));
  }
  if (action.addImportExclusion) {
    await client.addExclusion(artist.foreignArtistId, artist.artistName);
  }
  if (action.searchAfterDelete) {
    await client.triggerArtistSearch(artist.id);
  }
}

// --- Main dispatch ---

export async function executeAction(action: ActionRecord): Promise<void> {
  logger.info("Lifecycle", `Starting ${action.actionType} for "${action.mediaItem.title}" (item: ${action.mediaItem.id}, arr: ${action.arrInstanceId ?? "none"}${action.matchedMediaItemIds.length > 0 ? `, ${action.matchedMediaItemIds.length} matched episodes` : ""})`);

  // Execute tag operations before the main action
  if (action.addArrTags.length > 0 || action.removeArrTags.length > 0) {
    await executeTagOperations(action);
    const tagOps: string[] = [];
    if (action.addArrTags.length > 0) tagOps.push(`+tags: ${action.addArrTags.join(", ")}`);
    if (action.removeArrTags.length > 0) tagOps.push(`-tags: ${action.removeArrTags.join(", ")}`);
    logger.info("Lifecycle", `Tag operations for "${action.mediaItem.title}": ${tagOps.join("; ")}`);
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
      await executeUnmonitorDeleteFilesSonarr(action);
      break;
    case "DELETE_LIDARR":
      await executeDeleteLidarr(action);
      break;
    case "UNMONITOR_LIDARR":
      await executeUnmonitorLidarr(action);
      break;
    case "UNMONITOR_DELETE_FILES_LIDARR":
      await executeUnmonitorDeleteFilesLidarr(action);
      break;
    case "MONITOR_DELETE_FILES_RADARR":
      await executeMonitorDeleteFilesRadarr(action);
      break;
    case "MONITOR_DELETE_FILES_SONARR":
      await executeMonitorDeleteFilesSonarr(action);
      break;
    case "MONITOR_DELETE_FILES_LIDARR":
      await executeMonitorDeleteFilesLidarr(action);
      break;
    case "DELETE_FILES_RADARR":
      await executeDeleteFilesRadarr(action);
      break;
    case "DELETE_FILES_SONARR":
      await executeDeleteFilesSonarr(action);
      break;
    case "DELETE_FILES_LIDARR":
      await executeDeleteFilesLidarr(action);
      break;
    default:
      throw new Error(`Unknown action type: ${action.actionType}`);
  }

  logger.info(
    "Lifecycle",
    `Executed ${action.actionType} for "${action.mediaItem.title}"${action.addImportExclusion ? " (with import exclusion)" : ""}`
  );
}
