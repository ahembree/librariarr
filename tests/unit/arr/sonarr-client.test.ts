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

import { SonarrClient } from "@/lib/arr/sonarr-client";

describe("SonarrClient", () => {
  let client: SonarrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SonarrClient("http://sonarr:8989", "test-api-key");
  });

  describe("constructor", () => {
    it("strips trailing slashes from baseURL", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new SonarrClient("http://sonarr:8989///", "key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://sonarr:8989" })
      );
    });

    it("sets correct headers", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new SonarrClient("http://sonarr:8989", "my-key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Api-Key": "my-key" }),
          timeout: 15000,
        })
      );
    });
  });

  describe("testConnection", () => {
    it("returns ok when Sonarr responds correctly", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Sonarr", version: "4.0.0" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Sonarr", version: "4.0.0" });
    });

    it("returns error when appName is wrong", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Radarr", version: "5.0.0" },
      });
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Radarr");
    });

    it("returns error on network failure", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
    });
  });

  describe("getSeries", () => {
    it("returns array of series", async () => {
      const series = [{ id: 1, title: "Show 1", tvdbId: 200 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: series });
      const result = await client.getSeries();
      expect(result).toEqual(series);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series");
    });
  });

  describe("getSeriesById", () => {
    it("fetches a single series", async () => {
      const series = { id: 10, title: "Test Show" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: series });
      const result = await client.getSeriesById(10);
      expect(result).toEqual(series);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series/10");
    });
  });

  describe("getSeriesByTvdbId", () => {
    it("returns series when found", async () => {
      const series = { id: 1, tvdbId: 300 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [series] });
      const result = await client.getSeriesByTvdbId(300);
      expect(result).toEqual(series);
    });

    it("returns null when not found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      const result = await client.getSeriesByTvdbId(999);
      expect(result).toBeNull();
    });
  });

  describe("deleteSeries", () => {
    it("sends delete with default params", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteSeries(5);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/series/5", {
        params: { deleteFiles: true, addImportListExclusion: false },
      });
    });

    it("sends delete with custom params", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteSeries(5, false, true);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/series/5", {
        params: { deleteFiles: false, addImportListExclusion: true },
      });
    });
  });

  describe("updateSeries", () => {
    it("merges current with update and puts", async () => {
      const current = { id: 5, title: "Show", monitored: true };
      const updated = { id: 5, title: "Show", monitored: false };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: current });
      mockAxiosInstance.put.mockResolvedValueOnce({ data: updated });

      const result = await client.updateSeries(5, { monitored: false });
      expect(result).toEqual(updated);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        "/api/v3/series/5",
        { ...current, monitored: false }
      );
    });
  });

  describe("getEpisodeFiles", () => {
    it("fetches episode files for series", async () => {
      const files = [{ id: 1, seriesId: 5 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: files });
      const result = await client.getEpisodeFiles(5);
      expect(result).toEqual(files);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/episodefile", {
        params: { seriesId: 5 },
      });
    });
  });

  describe("getEpisodes", () => {
    it("fetches episodes for series", async () => {
      const episodes = [{ id: 1, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10, hasFile: true }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: episodes });
      const result = await client.getEpisodes(5);
      expect(result).toEqual(episodes);
    });
  });

  describe("deleteEpisodeFiles", () => {
    it("sends bulk delete with file IDs", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteEpisodeFiles([1, 2, 3]);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/episodefile/bulk", {
        data: { episodeFileIds: [1, 2, 3] },
      });
    });

    it("skips delete when array is empty", async () => {
      await client.deleteEpisodeFiles([]);
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
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

  describe("triggerSeriesSearch", () => {
    it("posts SeriesSearch command", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.triggerSeriesSearch(10);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/command", {
        name: "SeriesSearch",
        seriesId: 10,
      });
    });
  });

  describe("getQueue", () => {
    it("returns downloading when records exist", async () => {
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

    it("returns not downloading on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("fail"));
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
    it("creates and returns a tag", async () => {
      const tag = { id: 2, label: "new" };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: tag });
      const result = await client.createTag("new");
      expect(result).toEqual(tag);
    });
  });

  describe("deleteTag", () => {
    it("deletes a tag by id", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteTag(3);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/tag/3");
    });
  });

  describe("addExclusion", () => {
    it("posts exclusion data", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.addExclusion(12345, "Test Show");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/importlistexclusion", {
        tvdbId: 12345,
        title: "Test Show",
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
