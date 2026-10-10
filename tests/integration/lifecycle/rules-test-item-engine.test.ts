import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

/**
 * "Test Media" against the REAL rule engine.
 *
 * `rules-test-item.test.ts` mocks the engine, which is why the route could load
 * an item without its watch history — and answer every `watchedByUser` rule the
 * opposite way to detection — with every test passing. These run the evaluator.
 */

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/lifecycle/rules/test-item/route";

function group(field: string, operator: string, value: unknown) {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: [{ id: "r1", field, operator, value, condition: "AND" }],
      groups: [],
    },
  ];
}

async function testItem(body: Record<string, unknown>): Promise<boolean> {
  const response = await callRoute(POST, {
    url: "/api/lifecycle/rules/test-item",
    method: "POST",
    body,
  });
  const result = await expectJson<{ matches: boolean }>(response, 200);
  return result.matches;
}

describe("POST /api/lifecycle/rules/test-item — real engine", () => {
  const prisma = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it("answers watchedByUser from the item's completed plays", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { title: "Watched Film", type: "MOVIE" });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    const base = { type: "MOVIE", mediaItemId: movie.id, serverIds: [server.id] };
    expect(await testItem({ ...base, rules: group("watchedByUser", "equals", "alice") })).toBe(true);
    expect(await testItem({ ...base, rules: group("watchedByUser", "notEquals", "alice") })).toBe(false);
  });

  it("ignores a partial Tracearr play, as detection does", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const movie = await createTestMediaItem(library.id, { title: "Sampled Film", type: "MOVIE" });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: movie.id,
        mediaServerId: server.id,
        serverUsername: "bob",
        watchedAt: new Date("2026-01-01T00:00:00Z"),
        source: "TRACEARR",
        sourceEventId: "chain-1",
        watched: false,
        percentComplete: 4,
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(
      await testItem({
        type: "MOVIE",
        mediaItemId: movie.id,
        serverIds: [server.id],
        rules: group("watchedByUser", "equals", "bob"),
      }),
    ).toBe(false);
  });

  it("aggregates watchedByUser across a show's episodes in series scope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    const pilot = await createTestMediaItem(library.id, {
      title: "Pilot",
      parentTitle: "Show",
      type: "SERIES",
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const second = await createTestMediaItem(library.id, {
      title: "Second",
      parentTitle: "Show",
      type: "SERIES",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    await prisma.watchHistory.create({
      data: {
        mediaItemId: second.id,
        mediaServerId: server.id,
        serverUsername: "alice",
        watchedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    expect(
      await testItem({
        type: "SERIES",
        seriesScope: true,
        mediaItemId: pilot.id,
        serverIds: [server.id],
        rules: group("watchedByUser", "equals", "alice"),
      }),
    ).toBe(true);
  });

  it("keeps two different shows that share a title apart in series scope", async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "SERIES" });
    // The Office (UK) and The Office (US): one title, two TVDB identities.
    await createTestMediaItem(library.id, {
      title: "Pilot",
      parentTitle: "The Office",
      type: "SERIES",
      seriesKey: "tvdb:78107",
      playCount: 5,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    const unwatched = await createTestMediaItem(library.id, {
      title: "Pilot",
      parentTitle: "The Office",
      type: "SERIES",
      seriesKey: "tvdb:73244",
      playCount: 0,
      seasonNumber: 1,
      episodeNumber: 1,
    });
    setMockSession({ isLoggedIn: true, userId: user.id });

    // Grouped by title, the other show's five plays made this one look watched.
    expect(
      await testItem({
        type: "SERIES",
        seriesScope: true,
        mediaItemId: unwatched.id,
        serverIds: [server.id],
        rules: group("playCount", "equals", 0),
      }),
    ).toBe(true);
  });
});
