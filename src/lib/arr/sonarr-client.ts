import { ArrClientBase } from "@/lib/arr/arr-client-base";

export interface SonarrSeries {
  id: number;
  title: string;
  year?: number;
  titleSlug?: string;
  tvdbId: number;
  imdbId?: string;
  qualityProfileId: number;
  monitored: boolean;
  path: string;
  tags: number[];
  // Sonarr's SeriesResource.ratings is a single flat aggregate ({ votes, value }),
  // NOT broken down by source like Radarr's. There is no per-source imdb/tmdb/
  // rottenTomatoes rating for a series.
  ratings?: {
    votes?: number;
    value?: number;
  };
  statistics?: {
    /** Seasons, specials excluded. */
    seasonCount: number;
    /** Episodes that are (monitored AND aired) OR have a file — NOT the total. */
    episodeCount: number;
    /** Every episode Sonarr knows of, specials included. */
    totalEpisodeCount?: number;
    episodeFileCount: number;
    sizeOnDisk: number;
  };
  added?: string;
  firstAired?: string;
  status?: string;
  ended?: boolean;
  seriesType?: string;
  originalLanguage?: { id: number; name: string };
  nextAiring?: string;
  seasons?: Array<{
    seasonNumber: number;
    monitored: boolean;
    statistics?: { episodeCount: number; episodeFileCount: number; totalEpisodeCount?: number };
  }>;
}

interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId: number;
  hasFile: boolean;
  title?: string;
  /** Local air date, `YYYY-MM-DD`; absent for an unaired or TBA episode. */
  airDate?: string;
}

export class SonarrClient extends ArrClientBase {
  constructor(baseURL: string, apiKey: string) {
    super("Sonarr", "v3", baseURL, apiKey);
  }

  async getSeries(): Promise<SonarrSeries[]> {
    const { data } = await this.client.get<SonarrSeries[]>("/api/v3/series");
    return data;
  }

  async getSeriesById(id: number): Promise<SonarrSeries> {
    const { data } = await this.client.get<SonarrSeries>(
      `/api/v3/series/${id}`
    );
    return data;
  }

  async getSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
    const { data } = await this.client.get<SonarrSeries[]>("/api/v3/series", {
      params: { tvdbId },
    });
    // Only a record carrying the requested id (see RadarrClient.getMovieByTmdbId).
    return data.find((s) => s.tvdbId === tvdbId) ?? null;
  }

  async deleteSeries(
    id: number,
    deleteFiles: boolean = true,
    addImportListExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v3/series/${id}`, {
      params: { deleteFiles, addImportListExclusion },
    });
  }

  /**
   * PUTs `series` over the record. Pass `current` — the record just read —
   * to skip re-reading it first; without it the record is fetched by id.
   */
  async updateSeries(id: number, series: Partial<SonarrSeries>, current?: SonarrSeries): Promise<SonarrSeries> {
    const base = current ?? (await this.getSeriesById(id));
    const { data } = await this.client.put<SonarrSeries>(
      `/api/v3/series/${id}`,
      { ...base, ...series }
    );
    return data;
  }

  /** Removes `tagIds` from every series in `seriesIds` in one bulk-editor request. */
  async removeTagsFromSeries(seriesIds: number[], tagIds: number[]): Promise<void> {
    await this.removeTagsWithEditor("series", "seriesIds", seriesIds, tagIds);
  }

  async getEpisodes(seriesId: number): Promise<SonarrEpisode[]> {
    const { data } = await this.client.get("/api/v3/episode", {
      params: { seriesId },
    });
    return data;
  }

  async deleteEpisodeFiles(episodeFileIds: number[]): Promise<void> {
    if (episodeFileIds.length === 0) return;
    await this.client.delete("/api/v3/episodefile/bulk", {
      data: { episodeFileIds },
    });
  }

  /**
   * Ids of the series with at least one regular (non-special) episode airing
   * after now, monitored or not — from the calendar, the one endpoint that
   * answers that for every series in one request. A series resource's
   * `nextAiring` only considers MONITORED episodes, so a continuing show whose
   * upcoming episodes are unmonitored read as having nothing unaired.
   */
  async getSeriesIdsWithUpcomingEpisodes(now = new Date()): Promise<Set<number>> {
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + 20);
    const { data } = await this.client.get<Array<{ seriesId: number; seasonNumber: number }>>(
      "/api/v3/calendar",
      { params: { start: now.toISOString(), end: end.toISOString(), unmonitored: true } },
    );
    return new Set(data.filter((ep) => ep.seasonNumber > 0).map((ep) => ep.seriesId));
  }

  /** Sets the monitored flag on the given episodes (`PUT /api/v3/episode/monitor`). */
  async setEpisodesMonitored(episodeIds: number[], monitored: boolean): Promise<void> {
    if (episodeIds.length === 0) return;
    await this.client.put("/api/v3/episode/monitor", { episodeIds, monitored });
  }

  /**
   * Searches for the given episodes. Sent from the API the command is a manual
   * trigger, so Sonarr searches each episode whether or not it is monitored —
   * unlike `SeriesSearch`, which skips unmonitored seasons and episodes.
   */
  async triggerEpisodeSearch(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) return;
    await this.client.post("/api/v3/command", {
      name: "EpisodeSearch",
      episodeIds,
    });
  }

  async triggerSeriesSearch(seriesId: number): Promise<void> {
    await this.client.post("/api/v3/command", {
      name: "SeriesSearch",
      seriesId,
    });
  }
}
