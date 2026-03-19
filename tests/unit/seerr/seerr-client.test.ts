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

import { SeerrClient } from "@/lib/seerr/seerr-client";

describe("SeerrClient", () => {
  let client: SeerrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SeerrClient("http://overseerr:5055", "test-api-key");
  });

  describe("constructor", () => {
    it("strips trailing slashes from baseURL", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new SeerrClient("http://overseerr:5055///", "key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "http://overseerr:5055" })
      );
    });

    it("sets X-Api-Key header", async () => {
      const axios = (await import("axios")).default;
      const createSpy = vi.mocked(axios.create);
      createSpy.mockClear();
      new SeerrClient("http://overseerr:5055", "my-key");
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Api-Key": "my-key" }),
        })
      );
    });
  });

  describe("testConnection", () => {
    it("returns ok on successful connection", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });
      const result = await client.testConnection();
      expect(result).toEqual({ ok: true, appName: "Seerr" });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/settings/main");
    });

    it("returns error on network failure", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
    });

    it("returns generic message for non-Error rejection", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce("string error");
      const result = await client.testConnection();
      expect(result).toEqual({ ok: false, error: "Connection failed" });
    });
  });

  describe("getRequests", () => {
    it("returns requests response", async () => {
      const response = {
        pageInfo: { page: 1, pages: 1, results: 2 },
        results: [
          { id: 1, type: "movie", status: 2 },
          { id: 2, type: "tv", status: 1 },
        ],
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: response });
      const result = await client.getRequests({ take: 10 });
      expect(result).toEqual(response);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/request", {
        params: { take: 10 },
      });
    });

    it("works without params", async () => {
      const response = { pageInfo: { page: 1, pages: 1, results: 0 }, results: [] };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: response });
      const result = await client.getRequests();
      expect(result).toEqual(response);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/request", {
        params: undefined,
      });
    });

    it("passes filter and sort params", async () => {
      const response = { pageInfo: { page: 1, pages: 1, results: 0 }, results: [] };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: response });
      await client.getRequests({ filter: "approved", sort: "added", mediaType: "movie" });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/request", {
        params: { filter: "approved", sort: "added", mediaType: "movie" },
      });
    });
  });

  describe("getRequest", () => {
    it("fetches a single request", async () => {
      const request = { id: 5, type: "movie", status: 2 };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: request });
      const result = await client.getRequest(5);
      expect(result).toEqual(request);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/request/5");
    });
  });

  describe("getMovie", () => {
    it("fetches movie details by tmdb id", async () => {
      const movie = { id: 12345, title: "Test Movie" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: movie });
      const result = await client.getMovie(12345);
      expect(result).toEqual(movie);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/movie/12345");
    });
  });

  describe("getTvShow", () => {
    it("fetches tv show details by tmdb id", async () => {
      const show = { id: 67890, name: "Test Show" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: show });
      const result = await client.getTvShow(67890);
      expect(result).toEqual(show);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/tv/67890");
    });
  });

  describe("getUsers", () => {
    it("returns users response", async () => {
      const response = {
        pageInfo: { page: 1, pages: 1, results: 1 },
        results: [{ id: 1, email: "user@example.com", username: "user1" }],
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: response });
      const result = await client.getUsers({ take: 50 });
      expect(result).toEqual(response);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v1/user", {
        params: { take: 50 },
      });
    });

    it("works without params", async () => {
      const response = { pageInfo: { page: 1, pages: 1, results: 0 }, results: [] };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: response });
      const result = await client.getUsers();
      expect(result).toEqual(response);
    });
  });
});
