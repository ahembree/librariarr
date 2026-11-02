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
        data: { appName: "Sonarr", instanceName: "Sonarr", version: "4.0.11.2680" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Sonarr", version: "4.0.11.2680" });
      // The connection test opts out of transport retries (NO_RETRY).
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/system/status", { __noRetry: true });
    });

    it("returns error when appName is wrong", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Radarr", instanceName: "Radarr", version: "5.14.0.9383" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({
        ok: false,
        error: "Expected Sonarr but connected to Radarr",
        appName: "Radarr",
        version: "5.14.0.9383",
      });
    });

    it("returns error on network failure", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
    });
  });

  describe("getSeries", () => {
    it("returns array of series", async () => {
      const series = [{ id: 1, title: "Breaking Bad", tvdbId: 81189 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: series });
      const result = await client.getSeries();
      expect(result).toEqual(series);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series");
    });
  });

  describe("getSeriesById", () => {
    it("fetches a single series", async () => {
      const series = { id: 10, title: "Breaking Bad", tvdbId: 81189 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: series });
      const result = await client.getSeriesById(10);
      expect(result).toEqual(series);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series/10");
    });
  });

  describe("getSeriesByTvdbId", () => {
    it("returns series when found, asking Sonarr to filter by the id", async () => {
      const series = { id: 1, title: "Breaking Bad", tvdbId: 81189 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [series] });
      const result = await client.getSeriesByTvdbId(81189);
      expect(result).toEqual(series);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series", { params: { tvdbId: 81189 } });
    });

    it("returns null when not found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      const result = await client.getSeriesByTvdbId(999);
      expect(result).toBeNull();
    });

    it("never returns a series with a different TVDB id (filter ignored)", async () => {
      const library = [{ id: 1, tvdbId: 81189 }, { id: 2, tvdbId: 371980 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: library });
      expect(await client.getSeriesByTvdbId(73739)).toBeNull();
      mockAxiosInstance.get.mockResolvedValueOnce({ data: library });
      expect(await client.getSeriesByTvdbId(371980)).toEqual({ id: 2, tvdbId: 371980 });
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
      const current = { id: 5, title: "Breaking Bad", tvdbId: 81189, monitored: true, tags: [2] };
      const updated = { ...current, monitored: false };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: current });
      mockAxiosInstance.put.mockResolvedValueOnce({ data: updated });

      const result = await client.updateSeries(5, { monitored: false });
      expect(result).toEqual(updated);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/series/5");
      expect(mockAxiosInstance.put).toHaveBeenCalledWith(
        "/api/v3/series/5",
        { ...current, monitored: false }
      );
    });

    it("puts over a record the caller already holds without re-reading it", async () => {
      const current = { id: 5, title: "Breaking Bad", tvdbId: 81189, monitored: true, tags: [2] };
      mockAxiosInstance.put.mockResolvedValueOnce({ data: current });
      await client.updateSeries(5, { monitored: false }, current as never);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/series/5", { ...current, monitored: false });
    });
  });

  describe("removeTagsFromSeries", () => {
    it("removes the tags through the series bulk editor", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.removeTagsFromSeries([4, 5], [2, 3]);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/series/editor", {
        seriesIds: [4, 5],
        tags: [2, 3],
        applyTags: "remove",
      });
    });
  });

  describe("getEpisodes", () => {
    it("fetches episodes for series", async () => {
      const episodes = [
        { id: 1, seriesId: 5, seasonNumber: 1, episodeNumber: 1, episodeFileId: 10, hasFile: true, title: "Pilot", airDate: "2008-01-20" },
      ];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: episodes });
      const result = await client.getEpisodes(5);
      expect(result).toEqual(episodes);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/episode", { params: { seriesId: 5 } });
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
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/qualityprofile");
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

  describe("getTags", () => {
    it("returns tags", async () => {
      const tags = [{ id: 1, label: "test" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: tags });
      const result = await client.getTags();
      expect(result).toEqual(tags);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/tag");
    });
  });

  describe("createTag", () => {
    it("creates and returns a tag", async () => {
      const tag = { id: 2, label: "new" };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: tag });
      const result = await client.createTag("new");
      expect(result).toEqual(tag);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/tag", { label: "new" });
    });
  });

  describe("deleteTag", () => {
    it("deletes a tag by id", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteTag(3);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v3/tag/3");
    });
  });

  describe("getSeriesIdsWithUpcomingEpisodes", () => {
    it("asks the calendar for unmonitored episodes too and ignores specials", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [
          { id: 901, seriesId: 1, seasonNumber: 3, episodeNumber: 1, monitored: false, airDateUtc: "2026-02-01T02:00:00Z" },
          { id: 902, seriesId: 2, seasonNumber: 0, episodeNumber: 4, monitored: true, airDateUtc: "2026-03-01T02:00:00Z" },
          { id: 903, seriesId: 1, seasonNumber: 3, episodeNumber: 2, monitored: false, airDateUtc: "2026-02-08T02:00:00Z" },
        ],
      });
      const now = new Date("2026-01-01T00:00:00Z");
      const ids = await client.getSeriesIdsWithUpcomingEpisodes(now);
      expect([...ids]).toEqual([1]);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/calendar", {
        params: { start: "2026-01-01T00:00:00.000Z", end: "2046-01-01T00:00:00.000Z", unmonitored: true },
      });
    });
  });

  describe("episode monitor and search", () => {
    it("monitors episodes by id and searches them with EpisodeSearch", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.setEpisodesMonitored([5, 6], true);
      await client.triggerEpisodeSearch([5, 6]);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/episode/monitor", { episodeIds: [5, 6], monitored: true });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/command", { name: "EpisodeSearch", episodeIds: [5, 6] });
    });

    it("sends nothing for an empty id list", async () => {
      await client.setEpisodesMonitored([], true);
      await client.triggerEpisodeSearch([]);
      expect(mockAxiosInstance.put).not.toHaveBeenCalled();
      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });

  describe("getLanguages", () => {
    it("returns languages", async () => {
      const langs = [{ id: 0, name: "Unknown" }, { id: 1, name: "English" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: langs });
      const result = await client.getLanguages();
      expect(result).toEqual(langs);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/language");
    });
  });

  describe("getMediaManagementConfig", () => {
    it("reads the recycle bin settings without transport retries", async () => {
      const config = { recycleBin: "/tv/.recycle", recycleBinCleanupDays: 7 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: config });
      expect(await client.getMediaManagementConfig()).toEqual(config);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/config/mediamanagement", { __noRetry: true });
    });
  });
});
