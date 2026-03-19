import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

vi.mock("axios", () => {
  const actualAxios = {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: (e: unknown) => e instanceof Error && "isAxiosError" in e,
  };
  return { default: actualAxios };
});

import { RadarrClient } from "@/lib/arr/radarr-client";

describe("RadarrClient", () => {
  let client: RadarrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new RadarrClient("http://radarr:7878", "test-api-key");
  });

  describe("constructor", () => {
    it("strips trailing slashes from baseURL", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new RadarrClient("http://radarr:7878///", "key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://radarr:7878" })
      );
    });

    it("sets X-Api-Key header", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new RadarrClient("http://radarr:7878", "my-key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Api-Key": "my-key" }),
        })
      );
    });
  });

  describe("testConnection", () => {
    it("returns ok when Radarr responds with correct appName", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Radarr", version: "5.0.0" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Radarr", version: "5.0.0" });
    });

    it("returns error when appName is not Radarr", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Sonarr", version: "4.0.0" },
      });
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Sonarr");
    });

    it("returns error on network failure", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toBe("ECONNREFUSED");
    });

    it("returns generic message for non-Error rejection", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce("string error");
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "Connection failed" });
    });
  });

  describe("getMovies", () => {
    it("returns array of movies", async () => {
      const movies = [{ id: 1, title: "Movie 1", tmdbId: 100 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: movies });
      const result = await client.getMovies();
      expect(result).toEqual(movies);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/movie");
    });
  });

  describe("getMovieById", () => {
    it("fetches a single movie", async () => {
      const movie = { id: 42, title: "Test Movie" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: movie });
      const result = await client.getMovieById(42);
      expect(result).toEqual(movie);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/movie/42");
    });
  });

  describe("getMovieByTmdbId", () => {
    it("returns movie when found", async () => {
      const movie = { id: 1, tmdbId: 555 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [movie] });
      const result = await client.getMovieByTmdbId(555);
      expect(result).toEqual(movie);
    });

    it("returns null when no movie found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      const result = await client.getMovieByTmdbId(999);
      expect(result).toBeNull();
    });
  });

  describe("deleteMovie", () => {
    it("sends delete with default params", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteMovie(10);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/movie/10", {
        params: { deleteFiles: true, addImportExclusion: false },
      });
    });

    it("sends delete with custom params", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteMovie(10, false, true);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/movie/10", {
        params: { deleteFiles: false, addImportExclusion: true },
      });
    });
  });

  describe("updateMovie", () => {
    it("fetches current movie then puts merged data", async () => {
      const current = { id: 5, title: "Old Title", monitored: true };
      const updated = { id: 5, title: "Old Title", monitored: false };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: current });
      mockAxiosInstance.put.mockResolvedValueOnce({ data: updated });

      const result = await client.updateMovie(5, { monitored: false });
      expect(result).toEqual(updated);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        "/api/v3/movie/5",
        { ...current, monitored: false }
      );
    });
  });

  describe("getMovieFiles", () => {
    it("fetches movie files with array params", async () => {
      const files = [{ id: 1, movieId: 5 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: files });
      const result = await client.getMovieFiles(5);
      expect(result).toEqual(files);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/moviefile", {
        params: { movieId: [5] },
        paramsSerializer: { indexes: null },
      });
    });
  });

  describe("deleteMovieFile", () => {
    it("sends delete for file id", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteMovieFile(99);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/moviefile/99");
    });
  });

  describe("getQualityProfiles", () => {
    it("returns quality profiles", async () => {
      const profiles = [{ id: 1, name: "HD" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: profiles });
      const result = await client.getQualityProfiles();
      expect(result).toEqual(profiles);
    });
  });

  describe("triggerMovieSearch", () => {
    it("posts MoviesSearch command", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.triggerMovieSearch(42);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/command", {
        name: "MoviesSearch",
        movieIds: [42],
      });
    });
  });

  describe("getQueue", () => {
    it("returns downloading status when records exist", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { records: [{ status: "completed" }] },
      });
      const result = await client.getQueue(1);
      expect(result).toEqual({ downloading: true, status: "completed" });
    });

    it("returns not downloading when no records", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { records: [] } });
      const result = await client.getQueue(1);
      expect(result).toEqual({ downloading: false, status: null });
    });

    it("falls back to trackedDownloadStatus", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { records: [{ trackedDownloadStatus: "warning" }] },
      });
      const result = await client.getQueue(1);
      expect(result).toEqual({ downloading: true, status: "warning" });
    });

    it("defaults to 'downloading' when no status fields", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { records: [{}] },
      });
      const result = await client.getQueue(1);
      expect(result).toEqual({ downloading: true, status: "downloading" });
    });

    it("returns not downloading on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("timeout"));
      const result = await client.getQueue(1);
      expect(result).toEqual({ downloading: false, status: null });
    });
  });

  describe("getTags", () => {
    it("returns tags", async () => {
      const tags = [{ id: 1, label: "test" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: tags });
      const result = await client.getTags();
      expect(result).toEqual(tags);
    });
  });

  describe("createTag", () => {
    it("posts tag and returns result", async () => {
      const tag = { id: 5, label: "new-tag" };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: tag });
      const result = await client.createTag("new-tag");
      expect(result).toEqual(tag);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/tag", { label: "new-tag" });
    });
  });

  describe("deleteTag", () => {
    it("sends delete for tag id", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteTag(3);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/tag/3");
    });
  });

  describe("addExclusion", () => {
    it("posts exclusion data", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.addExclusion(12345, "Test Movie", 2024);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/exclusions", {
        tmdbId: 12345,
        movieTitle: "Test Movie",
        movieYear: 2024,
      });
    });
  });

  describe("getLanguages", () => {
    it("returns languages", async () => {
      const langs = [{ id: 1, name: "English" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: langs });
      const result = await client.getLanguages();
      expect(result).toEqual(langs);
    });
  });
});
