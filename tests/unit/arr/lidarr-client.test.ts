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

import { LidarrClient } from "@/lib/arr/lidarr-client";

describe("LidarrClient", () => {
  let client: LidarrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new LidarrClient("http://lidarr:8686", "test-api-key");
  });

  describe("constructor", () => {
    it("strips trailing slashes from baseURL", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new LidarrClient("http://lidarr:8686///", "key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://lidarr:8686" })
      );
    });
  });

  describe("testConnection", () => {
    it("returns ok when Lidarr responds correctly", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Lidarr", version: "2.0.0" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Lidarr", version: "2.0.0" });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/system/status");
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
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("timeout"));
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "timeout" });
    });
  });

  describe("getArtists", () => {
    it("returns array of artists", async () => {
      const artists = [{ id: 1, artistName: "Artist 1" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artists });
      const result = await client.getArtists();
      expect(result).toEqual(artists);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist");
    });
  });

  describe("getArtistById", () => {
    it("fetches a single artist", async () => {
      const artist = { id: 10, artistName: "Test Artist" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artist });
      const result = await client.getArtistById(10);
      expect(result).toEqual(artist);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist/10");
    });
  });

  describe("getArtistByMusicBrainzId", () => {
    it("returns artist when found", async () => {
      const artists = [
        { id: 1, foreignArtistId: "mb-abc", artistName: "A" },
        { id: 2, foreignArtistId: "mb-xyz", artistName: "B" },
      ];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artists });
      const result = await client.getArtistByMusicBrainzId("mb-xyz");
      expect(result?.id).toBe(2);
    });

    it("returns null when not found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      const result = await client.getArtistByMusicBrainzId("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("deleteArtist", () => {
    it("sends delete with default params", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteArtist(5);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v1/artist/5", {
        params: { deleteFiles: true, addImportListExclusion: false },
      });
    });
  });

  describe("updateArtist", () => {
    it("merges current with update and puts", async () => {
      const current = { id: 5, artistName: "Artist", monitored: true };
      const updated = { id: 5, artistName: "Artist", monitored: false };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: current });
      mockAxiosInstance.put.mockResolvedValueOnce({ data: updated });

      const result = await client.updateArtist(5, { monitored: false });
      expect(result).toEqual(updated);
    });
  });

  describe("getTrackFiles", () => {
    it("fetches track files for artist", async () => {
      const files = [{ id: 1, artistId: 5 }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: files });
      const result = await client.getTrackFiles(5);
      expect(result).toEqual(files);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/trackfile", {
        params: { artistId: 5 },
      });
    });
  });

  describe("deleteTrackFiles", () => {
    it("sends bulk delete with file IDs", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteTrackFiles([1, 2]);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v1/trackfile/bulk", {
        data: { trackFileIds: [1, 2] },
      });
    });

    it("skips delete when array is empty", async () => {
      await client.deleteTrackFiles([]);
      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });

  describe("getQualityProfiles", () => {
    it("returns quality profiles", async () => {
      const profiles = [{ id: 1, name: "Lossless" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: profiles });
      const result = await client.getQualityProfiles();
      expect(result).toEqual(profiles);
    });
  });

  describe("triggerArtistSearch", () => {
    it("posts ArtistSearch command", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.triggerArtistSearch(10);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v1/command", {
        name: "ArtistSearch",
        artistId: 10,
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
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v1/tag/3");
    });
  });

  describe("addExclusion", () => {
    it("posts exclusion data", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({});
      await client.addExclusion("foreign-123", "Test Artist");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v1/importlistexclusion", {
        foreignId: "foreign-123",
        artistName: "Test Artist",
      });
    });
  });
});
