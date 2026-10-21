import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
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

import { GET } from "@/app/api/media/by-rating-key/route";

const url = (params: Record<string, string>) =>
  `/api/media/by-rating-key?${new URLSearchParams(params)}`;

describe("GET /api/media/by-rating-key", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await cleanDatabase();
    await disconnectTestDb();
  });

  it("requires a session", async () => {
    const response = await callRoute(GET, { url: url({ serverId: "s", ratingKey: "1" }) });
    expect(response.status).toBe(401);
  });

  it("requires serverId and ratingKey", async () => {
    const user = await createTestUser();
    setMockSession({ isLoggedIn: true, userId: user.id });
    const response = await callRoute(GET, { url: url({ serverId: "s" }) });
    expect(response.status).toBe(400);
  });

  it("finds the item a session's rating key names on its server", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const item = await createTestMediaItem(library.id, { ratingKey: "100", type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const response = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "100", type: "movie" }) });
    const body = await expectJson<{ id: string; type: string }>(response, 200);
    expect(body).toEqual({ id: item.id, type: "MOVIE" });
  });

  it("narrows a rating key shared by two libraries by the session's type", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const movies = await createTestLibrary(server.id, { key: "1", type: "MOVIE" });
    const shows = await createTestLibrary(server.id, { key: "2", type: "SERIES" });
    await createTestMediaItem(movies.id, { ratingKey: "7", type: "MOVIE" });
    const episode = await createTestMediaItem(shows.id, { ratingKey: "7", type: "SERIES" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const typed = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "7", type: "episode" }) });
    expect((await expectJson<{ id: string }>(typed, 200)).id).toBe(episode.id);

    // A type that names no library type finds nothing rather than ignoring it.
    const clip = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "7", type: "clip" }) });
    expect(clip.status).toBe(404);

    // Without a type the key names two items: no guess.
    const untyped = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "7" }) });
    expect(untyped.status).toBe(404);
  });

  it("answers 404 for an unsynced item and another server's key", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const other = await createTestServer(user.id, { name: "Other" });
    const library = await createTestLibrary(other.id, { type: "MOVIE" });
    await createTestMediaItem(library.id, { ratingKey: "5", type: "MOVIE" });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const missing = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "999" }) });
    expect(missing.status).toBe(404);
    const elsewhere = await callRoute(GET, { url: url({ serverId: server.id, ratingKey: "5" }) });
    expect(elsewhere.status).toBe(404);
  });
});
