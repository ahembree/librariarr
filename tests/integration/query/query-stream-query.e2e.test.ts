/**
 * E2E regression for query builder stream-query Phase 1/Phase 2 divergences.
 * Parallel to tests/integration/lifecycle/rules-engine-stream-query.e2e.test.ts —
 * the rule engine's buildStreamQueryClause had three NULL/quantifier bugs fixed
 * earlier; the query builder's buildQueryStreamQueryClause had drifted behind:
 *
 * 1. "all" quantifier on 0 streams: Phase 1 emitted only `{ streams: { none: ... } }`
 *    which is vacuously TRUE for items with 0 streams of the matched type.
 *    Phase 2's `matchingStreams.length > 0 && every(...)` correctly required
 *    at least one stream. Phase 1 patched to AND in `streams: { some: { streamType } }`.
 *
 * 2. notEquals / notContains on nullable stream column: Phase 1 emitted
 *    `{ [column]: { not: X } }` which excluded NULL-column streams under 3VL.
 *    Phase 2's `String(streamValue ?? "")` coalesce included them. Phase 1
 *    patched to wrap with `OR { [column]: null }`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { QueryDefinition, QueryGroup } from "@/lib/query/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeQuery } = await import("@/lib/query/query-engine");

const STREAM_AUDIO = 2;

let userId: string;
let serverId: string;
let withAudioId: string;
let noAudioId: string;
let withNullLangId: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({ data: { username: "test-query-stream", passwordHash: "x" } });
  userId = user.id;
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "Test", type: "PLEX", url: "http://test:32400", accessToken: "x", machineId: "query-sq-test" },
  });
  serverId = server.id;
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });

  // 1. Movie WITH an English audio stream
  const withAudio = await prisma.mediaItem.create({
    data: {
      libraryId: library.id, ratingKey: "with-audio", title: "Has Audio", type: "MOVIE", year: 2020,
      streams: { create: [{ streamType: STREAM_AUDIO, codec: "aac", language: "English" }] },
    },
  });
  withAudioId = withAudio.id;

  // 2. Movie with NO audio streams — must NOT match "all audio = English" (vacuous truth)
  const noAudio = await prisma.mediaItem.create({
    data: { libraryId: library.id, ratingKey: "no-audio", title: "Silent Movie", type: "MOVIE", year: 2020 },
  });
  noAudioId = noAudio.id;

  // 3. Movie with one audio stream that has NULL language — for notEquals NULL handling
  const withNull = await prisma.mediaItem.create({
    data: {
      libraryId: library.id, ratingKey: "null-lang", title: "Unknown Lang", type: "MOVIE", year: 2020,
      streams: { create: [{ streamType: STREAM_AUDIO, codec: "aac", language: null }] },
    },
  });
  withNullLangId = withNull.id;
});

afterAll(async () => {
  await disconnectTestDb();
});

async function streamMatchIds(quantifier: "any" | "none" | "all", rules: Array<{ field: string; operator: string; value: string; negate?: boolean }>): Promise<string[]> {
  const group: QueryGroup = {
    id: "g", condition: "AND",
    rules: rules.map((r, i) => ({ id: `r${i}`, field: r.field, operator: r.operator, value: r.value, condition: "AND", negate: r.negate ?? false })),
    groups: [],
    streamQuery: { streamType: "audio", quantifier },
  };
  const definition: QueryDefinition = {
    mediaTypes: ["MOVIE"],
    serverIds: [serverId],
    groups: [group],
    sortBy: "title",
    sortOrder: "asc",
  };
  const result = await executeQuery(definition, userId, 1, 100);
  return result.items.map((i) => i.id as string).sort();
}

describe("Query builder — stream query 'all' quantifier must not vacuously match 0-stream items", () => {
  it("all + language equals English: matches movies WITH such a stream, excludes 0-stream items", async () => {
    const matches = await streamMatchIds("all", [{ field: "sqLanguage", operator: "equals", value: "English" }]);
    expect(matches).toEqual([withAudioId].sort());
  });

  it("all + language equals nonexistent codec: matches nothing (no item has all streams = X)", async () => {
    const matches = await streamMatchIds("all", [{ field: "sqLanguage", operator: "equals", value: "Klingon" }]);
    expect(matches).toEqual([]);
  });

  it("none + language equals English: matches items with NO English stream", async () => {
    const matches = await streamMatchIds("none", [{ field: "sqLanguage", operator: "equals", value: "English" }]);
    expect(matches).toEqual([noAudioId, withNullLangId].sort());
  });

  it("any + language equals English: matches items with at least one English stream", async () => {
    const matches = await streamMatchIds("any", [{ field: "sqLanguage", operator: "equals", value: "English" }]);
    expect(matches).toEqual([withAudioId].sort());
  });
});

describe("Query builder — stream query notEquals on nullable column includes NULL streams", () => {
  it("any + language notEquals 'English': NULL-language streams count as non-English", async () => {
    const matches = await streamMatchIds("any", [{ field: "sqLanguage", operator: "notEquals", value: "English" }]);
    expect(matches).toEqual([withNullLangId].sort());
  });

  it("any + language notContains 'English': same as notEquals for single value", async () => {
    const matches = await streamMatchIds("any", [{ field: "sqLanguage", operator: "notContains", value: "English" }]);
    expect(matches).toEqual([withNullLangId].sort());
  });

  it("all + language notEquals 'English': all streams (incl. NULL-lang ones) must not be English", async () => {
    const matches = await streamMatchIds("all", [{ field: "sqLanguage", operator: "notEquals", value: "English" }]);
    expect(matches).toEqual([withNullLangId].sort());
  });
});
