import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestMediaStream,
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

import { applyStreamCountFilters } from "@/lib/filters/stream-count";
import type { Prisma } from "@/generated/prisma/client";
import { getTestPrisma } from "../../setup/test-db";

describe("applyStreamCountFilters", () => {
  const db = getTestPrisma();

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function setupMediaWithStreams() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id);

    // Item A: 3 audio streams, 2 subtitle streams
    const itemA = await createTestMediaItem(lib.id, {
      title: "Movie A",
    });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 0, codec: "aac" });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 1, codec: "ac3" });
    await createTestMediaStream(itemA.id, { streamType: 2, index: 2, codec: "dts" });
    await createTestMediaStream(itemA.id, { streamType: 3, index: 3, codec: "srt" });
    await createTestMediaStream(itemA.id, { streamType: 3, index: 4, codec: "srt" });

    // Item B: 1 audio stream, 0 subtitle streams
    const itemB = await createTestMediaItem(lib.id, {
      title: "Movie B",
    });
    await createTestMediaStream(itemB.id, { streamType: 2, index: 0, codec: "aac" });

    // Item C: 2 audio streams, 5 subtitle streams
    const itemC = await createTestMediaItem(lib.id, {
      title: "Movie C",
    });
    await createTestMediaStream(itemC.id, { streamType: 2, index: 0, codec: "aac" });
    await createTestMediaStream(itemC.id, { streamType: 2, index: 1, codec: "ac3" });
    await createTestMediaStream(itemC.id, { streamType: 3, index: 2, codec: "srt" });
    await createTestMediaStream(itemC.id, { streamType: 3, index: 3, codec: "ass" });
    await createTestMediaStream(itemC.id, { streamType: 3, index: 4, codec: "srt" });
    await createTestMediaStream(itemC.id, { streamType: 3, index: 5, codec: "srt" });
    await createTestMediaStream(itemC.id, { streamType: 3, index: 6, codec: "srt" });

    // Item D: 0 audio streams, 0 subtitle streams (only video stream)
    const itemD = await createTestMediaItem(lib.id, {
      title: "Movie D",
    });
    await createTestMediaStream(itemD.id, { streamType: 1, index: 0, codec: "h264" });

    return { itemA, itemB, itemC, itemD };
  }

  it("does nothing when no stream count params are present", async () => {
    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams();

    await applyStreamCountFilters(where, params, db);

    // where should remain empty — no AND clause added
    expect(where.AND).toBeUndefined();
  });

  it("filters by audio stream count with eq operator", async () => {
    const { itemA } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "eq:3",
    });

    await applyStreamCountFilters(where, params, db);

    expect(where.AND).toBeDefined();
    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemA.id);
    expect(idFilter.in).toHaveLength(1);
  });

  it("filters by audio stream count with gte operator", async () => {
    const { itemA, itemC } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "gte:2",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemA.id);
    expect(idFilter.in).toContain(itemC.id);
    expect(idFilter.in).toHaveLength(2);
  });

  it("filters by audio stream count with lte operator", async () => {
    const { itemB, itemD } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "lte:1",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    // itemB has 1 audio stream (1 <= 1), itemD has 0 audio streams (0 <= 1)
    expect(idFilter.in).toContain(itemB.id);
    expect(idFilter.in).toContain(itemD.id);
    expect(idFilter.in).toHaveLength(2);
  });

  it("filters by subtitle stream count with eq operator", async () => {
    const { itemC } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      subtitleStreamCountConditions: "eq:5",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemC.id);
    expect(idFilter.in).toHaveLength(1);
  });

  it("filters by subtitle stream count with gt operator", async () => {
    const { itemC } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      subtitleStreamCountConditions: "gt:3",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemC.id);
    expect(idFilter.in).toHaveLength(1);
  });

  it("filters by subtitle stream count with lt operator", async () => {
    const { itemA, itemB } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      subtitleStreamCountConditions: "lt:3",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemA.id);
    // itemB has 0 subtitle streams but also 1 audio stream; it's grouped by mediaItemId.
    // The HAVING counts subtitle WHERE streamType=3, which would be 0 for itemB.
    // lt:3 means count < 3, so 0 < 3 is true — itemB should match
    expect(idFilter.in).toContain(itemB.id);
  });

  it("combines audio and subtitle conditions with AND logic", async () => {
    const { itemA } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "gte:3",
      subtitleStreamCountConditions: "eq:2",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    // Only itemA has >= 3 audio AND exactly 2 subtitles
    expect(idFilter.in).toContain(itemA.id);
    expect(idFilter.in).toHaveLength(1);
  });

  it("returns empty id list when no items match", async () => {
    await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "eq:100",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toHaveLength(0);
  });

  it("handles multiple conditions on the same stream type (pipe-separated)", async () => {
    const { itemA, itemC } = await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "gte:2|lte:3",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    // Items with audio count >= 2 AND <= 3: itemA (3), itemC (2)
    expect(idFilter.in).toContain(itemA.id);
    expect(idFilter.in).toContain(itemC.id);
    expect(idFilter.in).toHaveLength(2);
  });

  it("appends to existing AND clauses in where", async () => {
    const { itemA } = await setupMediaWithStreams();

    const existingClause: Prisma.MediaItemWhereInput = { type: "MOVIE" };
    const where: Prisma.MediaItemWhereInput = {
      AND: [existingClause],
    };
    const params = new URLSearchParams({
      audioStreamCountConditions: "eq:3",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    // Should have original clause + the new id filter
    expect(andClauses).toHaveLength(2);
    expect(andClauses[0]).toEqual({ type: "MOVIE" });
    const idFilter = andClauses[1].id as { in: string[] };
    expect(idFilter.in).toContain(itemA.id);
  });

  it("wraps a single existing AND clause into an array", async () => {
    await setupMediaWithStreams();

    const where: Prisma.MediaItemWhereInput = {
      AND: { type: "MOVIE" } as Prisma.MediaItemWhereInput,
    };
    const params = new URLSearchParams({
      audioStreamCountConditions: "eq:3",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    expect(Array.isArray(andClauses)).toBe(true);
    expect(andClauses).toHaveLength(2);
  });

  it("excludes items with no streams (only video) from audio/subtitle counts", async () => {
    const { itemD } = await setupMediaWithStreams();

    // itemD only has streamType 1 (video) — it will appear in GROUP BY
    // but audio count = 0, so eq:0 should match it
    const where: Prisma.MediaItemWhereInput = {};
    const params = new URLSearchParams({
      audioStreamCountConditions: "eq:0",
    });

    await applyStreamCountFilters(where, params, db);

    const andClauses = where.AND as Prisma.MediaItemWhereInput[];
    const idFilter = andClauses[0].id as { in: string[] };
    expect(idFilter.in).toContain(itemD.id);
  });
});
