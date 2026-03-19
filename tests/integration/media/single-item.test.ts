import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestExternalId,
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

// Import route handler AFTER mocks
import { GET } from "@/app/api/media/[id]/route";

describe("GET /api/media/[id]", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("returns 401 without auth", async () => {
    const response = await callRouteWithParams(
      GET,
      { id: "nonexistent" },
      { url: "/api/media/nonexistent" }
    );
    const body = await expectJson<{ error: string }>(response, 401);
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 404 when item does not exist", async () => {
    const user = await createTestUser();
    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      GET,
      { id: "00000000-0000-0000-0000-000000000000" },
      { url: "/api/media/00000000-0000-0000-0000-000000000000" }
    );
    const body = await expectJson<{ error: string }>(response, 404);
    expect(body.error).toBe("Not found");
  });

  it("returns the media item with full details", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id, { name: "My Plex" });
    const lib = await createTestLibrary(server.id, { title: "Movies" });
    const item = await createTestMediaItem(lib.id, {
      title: "The Matrix",
      year: 1999,
      type: "MOVIE",
      resolution: "1080p",
      videoCodec: "h264",
      audioCodec: "aac",
      dynamicRange: "SDR",
      fileSize: BigInt("4294967296"),
      genres: ["Action", "Sci-Fi"],
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      GET,
      { id: item.id },
      { url: `/api/media/${item.id}` }
    );
    const body = await expectJson<{
      item: {
        id: string;
        title: string;
        year: number;
        type: string;
        resolution: string;
        fileSize: string;
        library: {
          title: string;
          mediaServer: { name: string; url: string };
        };
        streams: unknown[];
        externalIds: unknown[];
      };
    }>(response, 200);

    expect(body.item.id).toBe(item.id);
    expect(body.item.title).toBe("The Matrix");
    expect(body.item.year).toBe(1999);
    expect(body.item.type).toBe("MOVIE");
    expect(body.item.resolution).toBe("1080p");
    expect(body.item.library.title).toBe("Movies");
    expect(body.item.library.mediaServer.name).toBe("My Plex");
    expect(body.item.streams).toEqual([]);
    expect(body.item.externalIds).toEqual([]);
  });

  it("serializes BigInt fileSize to string", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    const item = await createTestMediaItem(lib.id, {
      title: "Big Movie",
      type: "MOVIE",
      fileSize: BigInt("10737418240"), // 10 GB
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      GET,
      { id: item.id },
      { url: `/api/media/${item.id}` }
    );
    const body = await expectJson<{
      item: { fileSize: string };
    }>(response, 200);

    expect(body.item.fileSize).toBe("10737418240");
    expect(typeof body.item.fileSize).toBe("string");
  });

  it("returns null fileSize when not set", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    // Create item with explicit null fileSize by using the test prisma directly
    const { getTestPrisma } = await import("../../setup/test-db");
    const prisma = getTestPrisma();
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: lib.id,
        ratingKey: "rk-null-size",
        title: "No Size Movie",
        year: 2024,
        type: "MOVIE",
        addedAt: new Date(),
        fileSize: null,
      },
    });

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      GET,
      { id: item.id },
      { url: `/api/media/${item.id}` }
    );
    const body = await expectJson<{
      item: { fileSize: string | null };
    }>(response, 200);

    expect(body.item.fileSize).toBeNull();
  });

  it("includes external IDs in response", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);
    const item = await createTestMediaItem(lib.id, {
      title: "The Matrix",
      type: "MOVIE",
    });

    await createTestExternalId(item.id, "tmdb", "603");
    await createTestExternalId(item.id, "imdb", "tt0133093");

    setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

    const response = await callRouteWithParams(
      GET,
      { id: item.id },
      { url: `/api/media/${item.id}` }
    );
    const body = await expectJson<{
      item: {
        externalIds: { source: string; externalId: string }[];
      };
    }>(response, 200);

    expect(body.item.externalIds).toHaveLength(2);
    expect(body.item.externalIds).toEqual(
      expect.arrayContaining([
        { source: "tmdb", externalId: "603" },
        { source: "imdb", externalId: "tt0133093" },
      ])
    );
  });
});
