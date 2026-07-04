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

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: (e: unknown) => e instanceof Error && "isAxiosError" in e,
  },
}));

import { GuideArrClient } from "@/lib/trash/arr-guide-client";

describe("GuideArrClient", () => {
  let client: GuideArrClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GuideArrClient("http://radarr:7878///", "key", "RADARR");
  });

  it("strips trailing slashes and sets the API key header", async () => {
    const axios = (await import("axios")).default;
    expect(vi.mocked(axios.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "http://radarr:7878",
        headers: expect.objectContaining({ "X-Api-Key": "key" }),
      }),
    );
  });

  it("gets custom formats", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: [{ id: 1, name: "x", specifications: [] }] });
    const cfs = await client.getCustomFormats();
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/customformat");
    expect(cfs[0].id).toBe(1);
  });

  it("creates a custom format", async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: { id: 5 } });
    const r = await client.createCustomFormat({ name: "x", specifications: [] });
    expect(mockAxiosInstance.post).toHaveBeenCalledWith("/api/v3/customformat", {
      name: "x",
      specifications: [],
    });
    expect(r.id).toBe(5);
  });

  it("updates a custom format, injecting the id into the body", async () => {
    mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });
    await client.updateCustomFormat(7, { name: "x", specifications: [] });
    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/customformat/7", {
      name: "x",
      specifications: [],
      id: 7,
    });
  });

  it("fetches the quality profile schema", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { items: [] } });
    await client.getQualityProfileSchema();
    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/api/v3/qualityprofile/schema");
  });

  it("bulk-updates quality definitions", async () => {
    mockAxiosInstance.put.mockResolvedValueOnce({ data: [] });
    await client.updateQualityDefinitions([{ id: 1 } as never]);
    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/qualitydefinition/update", [
      { id: 1 },
    ]);
  });

  it("updates naming config by id", async () => {
    mockAxiosInstance.put.mockResolvedValueOnce({ data: {} });
    await client.updateNamingConfig({ id: 3, standardMovieFormat: "x" });
    expect(mockAxiosInstance.put).toHaveBeenCalledWith("/api/v3/config/naming/3", {
      id: 3,
      standardMovieFormat: "x",
    });
  });

  it("verifies the service via system status", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({ data: { appName: "Sonarr", version: "4" } });
    const r = await client.testConnection();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Expected Radarr");
  });
});
