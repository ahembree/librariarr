import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
} from "../../setup/test-helpers";

// Redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the media server factory
const mockFetchImage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn().mockImplementation(function () {
    return {
      fetchImage: mockFetchImage,
    };
  }),
}));

// Import route handler AFTER mocks
import { GET } from "@/app/api/tools/sessions/image/route";

describe("GET /api/tools/sessions/image", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRoute(GET, {
      url: "/api/tools/sessions/image",
      searchParams: { serverId: "some-id", path: "/photo/:/transcode" },
    });
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 on missing URL params", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/image",
    });
    const body = await expectJson<{ error: string }>(response, 400);
    expect(body.error).toBe("Missing serverId or path");
  });

  it("proxies image when URL is valid", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    mockFetchImage.mockResolvedValue({
      data: imageData,
      contentType: "image/png",
    });

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/image",
      searchParams: { serverId: server.id, path: "/photo/:/transcode" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("returns 502 on failed fetch", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    setMockSession({ userId: user.id, isLoggedIn: true });

    mockFetchImage.mockRejectedValue(new Error("Connection refused"));

    const response = await callRoute(GET, {
      url: "/api/tools/sessions/image",
      searchParams: { serverId: server.id, path: "/photo/:/transcode" },
    });
    const body = await expectJson<{ error: string }>(response, 502);
    expect(body.error).toBe("Failed to fetch image");
  });
});
