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
import { IntegrationError } from "@/lib/integration-error";

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
        data: { appName: "Lidarr", instanceName: "Lidarr", version: "2.9.6.4552" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Lidarr", version: "2.9.6.4552" });
      // The connection test opts out of transport retries (NO_RETRY).
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/system/status", { __noRetry: true });
    });

    it("returns error when appName is wrong", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { appName: "Radarr", instanceName: "Radarr", version: "5.14.0.9383" },
      });
      const result = await client.testConnection();
      expect(result).toEqual({
        ok: false,
        error: "Expected Lidarr but connected to Radarr",
        appName: "Radarr",
        version: "5.14.0.9383",
      });
    });

    it("returns error on network failure", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("timeout"));
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "timeout" });
    });
  });

  describe("getArtists", () => {
    it("returns array of artists", async () => {
      const artists = [{ id: 1, artistName: "Radiohead", foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artists });
      const result = await client.getArtists();
      expect(result).toEqual(artists);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist");
    });
  });

  describe("getArtistById", () => {
    it("fetches a single artist", async () => {
      const artist = { id: 10, artistName: "Radiohead", foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artist });
      const result = await client.getArtistById(10);
      expect(result).toEqual(artist);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist/10");
    });
  });

  describe("getArtistByMusicBrainzId", () => {
    const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
    const DAFT_PUNK = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

    it("returns the artist carrying the id, asking Lidarr to filter by it", async () => {
      const artists = [
        { id: 1, foreignArtistId: DAFT_PUNK, artistName: "Daft Punk" },
        { id: 2, foreignArtistId: RADIOHEAD, artistName: "Radiohead" },
      ];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: artists });
      const result = await client.getArtistByMusicBrainzId(RADIOHEAD);
      expect(result).toEqual(artists[1]);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist", { params: { mbId: RADIOHEAD } });
    });

    it("returns null when not found", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });
      const result = await client.getArtistByMusicBrainzId("8c538f11-c141-4588-8ecb-931083524186");
      expect(result).toBeNull();
    });

    it("accepts the one artist Lidarr answers for a merged (old) MusicBrainz id", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [{ id: 1, foreignArtistId: RADIOHEAD }] });
      expect((await client.getArtistByMusicBrainzId("0f3f1e5c-8a4e-4b2a-9d6b-3c1e7a2f9b10"))?.id).toBe(1);
    });

    it("never picks an arbitrary artist when the filter was ignored", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [{ id: 1, foreignArtistId: RADIOHEAD }, { id: 2, foreignArtistId: DAFT_PUNK }],
      });
      expect(await client.getArtistByMusicBrainzId("8c538f11-c141-4588-8ecb-931083524186")).toBeNull();
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
      const current = { id: 5, artistName: "Radiohead", monitored: true, qualityProfileId: 1, tags: [3] };
      const updated = { ...current, monitored: false };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: current });
      mockAxiosInstance.put.mockResolvedValueOnce({ data: updated });

      const result = await client.updateArtist(5, { monitored: false });
      expect(result).toEqual(updated);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/artist/5");
      // The whole resource goes back, with only the changed field replaced.
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v1/artist/5", updated);
    });

    it("puts over a record the caller already holds without re-reading it", async () => {
      const current = { id: 5, artistName: "Radiohead", monitored: true, qualityProfileId: 1, tags: [3] };
      mockAxiosInstance.put.mockResolvedValueOnce({ data: current });
      await client.updateArtist(5, { qualityProfileId: 2 }, current as never);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v1/artist/5", { ...current, qualityProfileId: 2 });
    });
  });

  describe("removeTagsFromArtists", () => {
    it("removes the tags through the v1 artist bulk editor", async () => {
      mockAxiosInstance.put.mockResolvedValueOnce({});
      await client.removeTagsFromArtists([9], [3]);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v1/artist/editor", {
        artistIds: [9],
        tags: [3],
        applyTags: "remove",
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
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/qualityprofile");
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

  describe("getTags", () => {
    it("returns tags", async () => {
      const tags = [{ id: 1, label: "test" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: tags });
      const result = await client.getTags();
      expect(result).toEqual(tags);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/tag");
    });
  });

  describe("createTag", () => {
    it("creates and returns a tag", async () => {
      const tag = { id: 2, label: "new" };
      mockAxiosInstance.post.mockResolvedValueOnce({ data: tag });
      const result = await client.createTag("new");
      expect(result).toEqual(tag);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v1/tag", { label: "new" });
    });
  });

  describe("deleteTag", () => {
    it("deletes a tag by id", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({});
      await client.deleteTag(3);
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/api/v1/tag/3");
    });
  });

  describe("getAlbums / getTracks", () => {
    it("scopes both listings to one artist", async () => {
      const albums = [{ id: 3, title: "OK Computer" }];
      const tracks = [{ id: 30, albumId: 3, trackFileId: 300, title: "Airbag", hasFile: true, trackNumber: "1" }];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: albums });
      mockAxiosInstance.get.mockResolvedValueOnce({ data: tracks });

      expect(await client.getAlbums(7)).toEqual(albums);
      expect(await client.getTracks(7)).toEqual(tracks);
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(1, "/api/v1/album", { params: { artistId: 7 } });
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(2, "/api/v1/track", { params: { artistId: 7 } });
    });
  });

  describe("getMediaManagementConfig", () => {
    it("reads the recycle bin settings without transport retries", async () => {
      const config = { recycleBin: "/music/.recycle", recycleBinCleanupDays: 7 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: config });
      expect(await client.getMediaManagementConfig()).toEqual(config);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/config/mediamanagement", { __noRetry: true });
    });
  });
});
