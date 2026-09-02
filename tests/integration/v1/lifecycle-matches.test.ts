import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  expectJson,
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
  createTestRuleMatch,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/lifecycle/matches/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Envelope {
  items: any[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

function list(key: string, searchParams?: Record<string, string>) {
  return callV1(GET, { url: "/api/v1/lifecycle/matches", key, searchParams });
}

/** Seed one user with a MOVIE match and a SERIES match. */
async function seedTwoMatches() {
  const user = await createTestUser();
  const { raw } = await createTestApiKey(user.id, { scope: "READ_ONLY" });
  const server = await createTestServer(user.id);

  const movieLib = await createTestLibrary(server.id, { key: "movies", type: "MOVIE" });
  const movie = await createTestMediaItem(movieLib.id, {
    title: "The Matrix",
    year: 1999,
    type: "MOVIE",
  });
  const movieRules = await createTestRuleSet(user.id, { name: "Movie rule", type: "MOVIE" });
  const movieMatch = await createTestRuleMatch(movieRules.id, movie.id);

  const seriesLib = await createTestLibrary(server.id, { key: "shows", type: "SERIES" });
  const episode = await createTestMediaItem(seriesLib.id, {
    title: "Pilot",
    parentTitle: "Some Show",
    year: 2010,
    type: "SERIES",
  });
  const seriesRules = await createTestRuleSet(user.id, { name: "Series rule", type: "SERIES" });
  const seriesMatch = await createTestRuleMatch(seriesRules.id, episode.id);

  // detectedAt defaults to `new Date()` on both rows; pin them so "newest first"
  // is deterministic rather than a same-millisecond coin flip.
  const prisma = getTestPrisma();
  await prisma.ruleMatch.update({
    where: { id: movieMatch.id },
    data: { detectedAt: new Date("2024-01-01T00:00:00Z") },
  });
  await prisma.ruleMatch.update({
    where: { id: seriesMatch.id },
    data: { detectedAt: new Date("2024-02-01T00:00:00Z") },
  });

  return { user, raw, movie, movieRules, movieMatch, seriesRules, seriesMatch };
}

describe("GET /api/v1/lifecycle/matches", () => {
  it("returns an empty envelope when nothing matched", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({ page: 1, limit: 50, hasMore: false });
  });

  it("returns the match shape, newest first", async () => {
    const { raw, movie, movieRules, movieMatch, seriesMatch } = await seedTwoMatches();

    const body = await expectJson<Envelope>(await list(raw));
    expect(body.items.map((m) => m.id)).toEqual([seriesMatch.id, movieMatch.id]);

    const match = body.items[1];
    expect(match.id).toBe(movieMatch.id);
    expect(typeof match.detectedAt).toBe("string");
    expect(match.ruleSet).toEqual({
      id: movieRules.id,
      name: "Movie rule",
      libraryType: "MOVIE",
    });
    expect(match.mediaItem).toEqual({
      id: movie.id,
      title: "The Matrix",
      parentTitle: null,
      year: 1999,
      type: "MOVIE",
    });
  });

  it("filters by ruleSetId", async () => {
    const { raw, movieRules, movieMatch } = await seedTwoMatches();
    const body = await expectJson<Envelope>(
      await list(raw, { ruleSetId: movieRules.id }),
    );
    expect(body.items.map((m) => m.id)).toEqual([movieMatch.id]);
  });

  it("filters by the rule set's library type", async () => {
    const { raw, seriesMatch } = await seedTwoMatches();
    const body = await expectJson<Envelope>(await list(raw, { type: "SERIES" }));
    expect(body.items.map((m) => m.id)).toEqual([seriesMatch.id]);

    const music = await expectJson<Envelope>(await list(raw, { type: "MUSIC" }));
    expect(music.items).toEqual([]);
  });

  it("rejects an unknown type rather than passing it to the enum column", async () => {
    const { raw } = await seedTwoMatches();
    const body = await expectJson<{ error: string }>(
      await list(raw, { type: "BOOKS" }),
      400,
    );
    expect(body.error).toBe("Invalid type. Expected one of: MOVIE, SERIES, MUSIC");
  });

  it("paginates with hasMore on all but the last page", async () => {
    const { raw } = await seedTwoMatches();

    const first = await expectJson<Envelope>(await list(raw, { limit: "1" }));
    expect(first.items).toHaveLength(1);
    expect(first.pagination).toEqual({ page: 1, limit: 1, hasMore: true });

    const second = await expectJson<Envelope>(await list(raw, { limit: "1", page: "2" }));
    expect(second.items).toHaveLength(1);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("clamps limit to 200", async () => {
    const { raw } = await seedTwoMatches();
    const body = await expectJson<Envelope>(await list(raw, { limit: "5000" }));
    expect(body.pagination.limit).toBe(200);
  });

  it("never returns another user's matches, even by their rule set id", async () => {
    const { raw } = await seedTwoMatches();

    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const strangerServer = await createTestServer(stranger.id, { name: "Theirs" });
    const strangerLib = await createTestLibrary(strangerServer.id, { key: "theirs" });
    const strangerItem = await createTestMediaItem(strangerLib.id, { title: "Private" });
    const strangerRules = await createTestRuleSet(stranger.id, { name: "Theirs" });
    await createTestRuleMatch(strangerRules.id, strangerItem.id);

    const all = await expectJson<Envelope>(await list(raw, { limit: "200" }));
    expect(all.items.map((m) => m.mediaItem.title)).not.toContain("Private");

    // Naming their rule set explicitly must not lift the ownership filter.
    const targeted = await expectJson<Envelope>(
      await list(raw, { ruleSetId: strangerRules.id }),
    );
    expect(targeted.items).toEqual([]);
  });
});
