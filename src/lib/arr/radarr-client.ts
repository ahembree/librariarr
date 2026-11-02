import { ArrClientBase } from "@/lib/arr/arr-client-base";
import { mapWithConcurrency } from "@/lib/concurrency";

export interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  tmdbId: number;
  imdbId?: string;
  qualityProfileId: number;
  monitored: boolean;
  path: string;
  hasFile: boolean;
  movieFileId: number;
  sizeOnDisk: number;
  tags: number[];
  ratings?: {
    imdb?: { value: number };
    tmdb?: { value: number };
    rottenTomatoes?: { value: number };
  };
  added?: string;
  inCinemas?: string;
  physicalRelease?: string;
  digitalRelease?: string;
  runtime?: number;
  originalLanguage?: { id: number; name: string };
  // `qualityCutoffNotMet` lives on the embedded movieFile (MovieFileResource),
  // not on the movie itself — reading it off the top-level movie always yields
  // undefined (the "Quality Cutoff Met" rule never matching) bug.
  movieFile?: { quality?: { quality?: { name?: string } }; dateAdded?: string; customFormatScore?: number; qualityCutoffNotMet?: boolean };
  // Radarr movie lifecycle status: tba | announced | inCinemas | released | deleted
  status?: string;
}

interface RadarrMovieFile {
  id: number;
  movieId: number;
  relativePath: string;
  size: number;
  // Only the /moviefile endpoint computes this (it passes Radarr's custom
  // format calculation service); the /movie listing always leaves it null.
  customFormatScore?: number;
}

// Movie ids are sent as repeated `movieId=` query params; chunk them so the
// request line stays well under Radarr's ~8 KB Kestrel limit on large libraries.
const MOVIE_FILE_QUERY_CHUNK = 100;
// Chunks in flight at once. 10k movies are 100 chunks, which one at a time
// were the slowest part of every movie-metadata fetch; more than a few at once
// only queue inside Radarr, which computes each file's custom formats.
const MOVIE_FILE_QUERY_CONCURRENCY = 4;

export class RadarrClient extends ArrClientBase {
  constructor(baseURL: string, apiKey: string) {
    super("Radarr", "v3", baseURL, apiKey);
  }

  async getMovies(): Promise<RadarrMovie[]> {
    const { data } = await this.client.get<RadarrMovie[]>("/api/v3/movie");
    return data;
  }

  async getMovieById(id: number): Promise<RadarrMovie> {
    const { data } = await this.client.get<RadarrMovie>(
      `/api/v3/movie/${id}`
    );
    return data;
  }

  async getMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
    const { data } = await this.client.get<RadarrMovie[]>("/api/v3/movie", {
      params: { tmdbId },
    });
    // Only a record carrying the requested id: a Radarr that ignored or
    // dropped the filter answers with its whole library, and `data[0]` would
    // then be an arbitrary movie for every action to resolve against.
    return data.find((m) => m.tmdbId === tmdbId) ?? null;
  }

  async deleteMovie(
    id: number,
    deleteFiles: boolean = true,
    addImportExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v3/movie/${id}`, {
      params: { deleteFiles, addImportExclusion },
    });
  }

  /**
   * PUTs `movie` over the record. Pass `current` — the record just read —
   * to skip re-reading it first; without it the record is fetched by id.
   */
  async updateMovie(id: number, movie: Partial<RadarrMovie>, current?: RadarrMovie): Promise<RadarrMovie> {
    const base = current ?? (await this.getMovieById(id));
    const { data } = await this.client.put<RadarrMovie>(
      `/api/v3/movie/${id}`,
      { ...base, ...movie }
    );
    return data;
  }

  /** Removes `tagIds` from every movie in `movieIds` in one bulk-editor request. */
  async removeTagsFromMovies(movieIds: number[], tagIds: number[]): Promise<void> {
    await this.removeTagsWithEditor("movie", "movieIds", movieIds, tagIds);
  }

  /**
   * Custom format scores keyed by movie id.
   *
   * Radarr only computes `customFormatScore` in the /moviefile endpoint (the
   * /movie list and /movie/{id} endpoints leave the embedded movieFile's score
   * null), so rule/query evaluation must pull the real score from here and merge
   * it back onto each movie. Ids are chunked to keep the query string small,
   * and a few chunks are requested at a time.
   *
   * `onProgress` (optional) reports 0..1 completion as chunks finish so callers
   * can drive a progress bar through what is usually the slowest part of a
   * movie-metadata fetch on large libraries.
   */
  async getCustomFormatScores(
    movieIds: number[],
    onProgress?: (fraction: number) => void,
  ): Promise<Map<number, number>> {
    const scores = new Map<number, number>();
    if (movieIds.length === 0) {
      onProgress?.(1);
      return scores;
    }
    const chunks: number[][] = [];
    for (let i = 0; i < movieIds.length; i += MOVIE_FILE_QUERY_CHUNK) {
      chunks.push(movieIds.slice(i, i + MOVIE_FILE_QUERY_CHUNK));
    }
    let done = 0;
    const pages = await mapWithConcurrency(chunks, MOVIE_FILE_QUERY_CONCURRENCY, async (chunk) => {
      const { data } = await this.client.get<RadarrMovieFile[]>("/api/v3/moviefile", {
        params: { movieId: chunk },
        // Radarr binds `movieId` as an int[] only from repeated plain keys;
        // axios' default `movieId[]=1` is ignored and the filter skipped.
        paramsSerializer: { indexes: null },
      });
      done += chunk.length;
      onProgress?.(Math.min(1, done / movieIds.length));
      return data;
    });
    // Merged in chunk order, so a movie id answered twice keeps the answer
    // the one-at-a-time loop would have kept.
    for (const data of pages) {
      for (const file of data) {
        if (file.customFormatScore != null) {
          scores.set(file.movieId, file.customFormatScore);
        }
      }
    }
    return scores;
  }

  async deleteMovieFile(movieFileId: number): Promise<void> {
    await this.client.delete(`/api/v3/moviefile/${movieFileId}`);
  }

  async triggerMovieSearch(movieId: number): Promise<void> {
    await this.client.post("/api/v3/command", {
      name: "MoviesSearch",
      movieIds: [movieId],
    });
  }
}
