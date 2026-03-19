import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRadarrInstance,
  createTestSonarrInstance,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockRadarrTriggerMovieSearch = vi.fn();
const mockRadarrGetQueue = vi.fn();

vi.mock("@/lib/arr/radarr-client", () => ({
  RadarrClient: vi.fn().mockImplementation(function () {
    return {
      triggerMovieSearch: mockRadarrTriggerMovieSearch,
      getQueue: mockRadarrGetQueue,
    };
  }),
}));

const mockSonarrTriggerSeriesSearch = vi.fn();
const mockSonarrGetQueue = vi.fn();

vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return {
      triggerSeriesSearch: mockSonarrTriggerSeriesSearch,
      getQueue: mockSonarrGetQueue,
    };
  }),
}));

vi.mock("@/lib/arr/lidarr-client", () => ({
  LidarrClient: vi.fn().mockImplementation(function () {
    return {
      triggerArtistSearch: vi.fn(),
      getQueue: vi.fn(),
    };
  }),
}));

import { POST } from "@/app/api/media/[id]/arr-actions/route";

describe("POST /api/media/[id]/arr-actions", () => {
  let userId: string;
  let libraryId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
    const user = await createTestUser();
    userId = user.id;
    setMockSession({ userId, isLoggedIn: true, plexToken: "token" });
    const server = await createTestServer(userId);
    const library = await createTestLibrary(server.id);
    libraryId = library.id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    clearMockSession();
    const response = await callRouteWithParams(
      POST,
      { id: "any" },
      {
        method: "POST",
        body: { action: "search", instanceId: "x", arrItemId: 1, type: "radarr" },
      }
    );
    expect(response.status).toBe(401);
  });

  it("returns 403 for non-existent item", async () => {
    const response = await callRouteWithParams(
      POST,
      { id: "nonexistent" },
      {
        method: "POST",
        body: { action: "search", instanceId: "x", arrItemId: 1, type: "radarr" },
      }
    );
    expect(response.status).toBe(403);
  });

  it("triggers radarr movie search", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    const radarr = await createTestRadarrInstance(userId);

    mockRadarrTriggerMovieSearch.mockResolvedValue(undefined);

    const response = await callRouteWithParams(
      POST,
      { id: item.id },
      {
        method: "POST",
        body: {
          action: "search",
          instanceId: radarr.id,
          arrItemId: 99,
          type: "radarr",
        },
      }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("checks radarr queue", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    const radarr = await createTestRadarrInstance(userId);

    mockRadarrGetQueue.mockResolvedValue({ totalRecords: 0, records: [] });

    const response = await callRouteWithParams(
      POST,
      { id: item.id },
      {
        method: "POST",
        body: {
          action: "checkQueue",
          instanceId: radarr.id,
          arrItemId: 99,
          type: "radarr",
        },
      }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("triggers sonarr series search", async () => {
    const item = await createTestMediaItem(libraryId, { type: "SERIES" });
    const sonarr = await createTestSonarrInstance(userId);

    mockSonarrTriggerSeriesSearch.mockResolvedValue(undefined);

    const response = await callRouteWithParams(
      POST,
      { id: item.id },
      {
        method: "POST",
        body: {
          action: "search",
          instanceId: sonarr.id,
          arrItemId: 55,
          type: "sonarr",
        },
      }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
  });

  it("returns 404 when instance not found", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });

    const response = await callRouteWithParams(
      POST,
      { id: item.id },
      {
        method: "POST",
        body: {
          action: "search",
          instanceId: "nonexistent-instance",
          arrItemId: 99,
          type: "radarr",
        },
      }
    );
    expect(response.status).toBe(404);
  });

  it("returns error when arr client throws", async () => {
    const item = await createTestMediaItem(libraryId, { type: "MOVIE" });
    const radarr = await createTestRadarrInstance(userId);

    mockRadarrTriggerMovieSearch.mockRejectedValue(new Error("Timeout"));

    const response = await callRouteWithParams(
      POST,
      { id: item.id },
      {
        method: "POST",
        body: {
          action: "search",
          instanceId: radarr.id,
          arrItemId: 99,
          type: "radarr",
        },
      }
    );
    expect(response.status).toBe(500);
  });
});
