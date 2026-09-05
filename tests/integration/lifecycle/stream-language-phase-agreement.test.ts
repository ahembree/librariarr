/**
 * Regression: negated stream-LANGUAGE operators must mean the same thing in
 * Phase 1 (Prisma WHERE) and Phase 2 (in-memory), and in both engines.
 *
 * Phase 2 has always refused to match an item with no KNOWN language of the
 * requested type under any operator — "Unknown" != "English" must not read as
 * true (pinned by the "unknown language filtering" tests in
 * tests/unit/rules/stream-evaluation.test.ts). Phase 1 did not: `notEquals`
 * built a bare `NOT { streams: { some: … } }`, which a row with no such stream
 * (or only an Unknown one) satisfies.
 *
 * Phase 2 only runs when something else in the rule set demands it, so the same
 * `subtitleLanguage notEquals English` rule matched a DIFFERENT set of items
 * depending on an unrelated rule sitting beside it — on a rule set with a
 * DELETE action, a different set of files. Adding a semantically harmless
 * `title matchesWildcard *` was enough to change the outcome.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { evaluateLifecycleRules } = await import("@/lib/rules/lifecycle-engine");
const { executeQuery } = await import("@/lib/query/query-engine");
const { appCache } = await import("@/lib/cache/memory-cache");

const prisma = getTestPrisma();

/** A rule that matches every seeded title — a no-op that forces Phase 2. */
const FORCES_PHASE_2 = {
  id: "r2", field: "title", operator: "matchesWildcard", value: "*", condition: "AND",
};

const group = (rules: unknown[]) => [{ id: "g", condition: "AND", rules, groups: [] }] as never;

let serverId: string;
let userId: string;

beforeAll(async () => {
  await cleanDatabase();
  appCache.clear();
  const user = await prisma.user.create({ data: { username: "stream-phase", passwordHash: "x" } });
  userId = user.id;
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "S", type: "PLEX", url: "http://s:32400", accessToken: "x", machineId: "stream-phase" },
  });
  serverId = server.id;
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });

  const seed = async (ratingKey: string, title: string, subs: Array<string | null>) => {
    const item = await prisma.mediaItem.create({
      data: { libraryId: library.id, ratingKey, type: "MOVIE", title },
    });
    // Every item gets an audio stream, so only the subtitle side varies.
    await prisma.mediaStream.create({
      data: { mediaItemId: item.id, streamType: 2, language: "English", codec: "eac3" },
    });
    for (const language of subs) {
      await prisma.mediaStream.create({
        data: { mediaItemId: item.id, streamType: 3, language, codec: "srt" },
      });
    }
  };

  await seed("eng", "Has English Subs", ["English"]);
  await seed("fre", "Has French Subs", ["French"]);
  await seed("unk", "Only Unknown Subs", ["Unknown"]);
  await seed("null", "Null Subtitle Language", [null]);
  await seed("none", "No Subs At All", []);
  appCache.clear();
}, 60_000);

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

const NEGATED: Array<{ operator: string; value: string }> = [
  { operator: "notEquals", value: "English" },
  { operator: "notContains", value: "English" },
  { operator: "notMatchesWildcard", value: "eng*" },
];

describe("stream language phase agreement", () => {
  for (const { operator, value } of NEGATED) {
    it(`subtitleLanguage ${operator} matches the same items with and without Phase 2`, async () => {
      const streamRule = { id: "r1", field: "subtitleLanguage", operator, value, condition: "AND" };

      const phase1Only = await evaluateLifecycleRules(group([streamRule]), "MOVIE", [serverId]);
      const withPhase2 = await evaluateLifecycleRules(group([streamRule, FORCES_PHASE_2]), "MOVIE", [serverId]);

      const titles = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.title as string).sort();

      // Only the item with a KNOWN, non-English subtitle language qualifies.
      // No subtitles / Unknown / NULL all have no subtitle language to compare.
      expect(titles(phase1Only)).toEqual(["Has French Subs"]);
      expect(titles(withPhase2)).toEqual(titles(phase1Only));
    });

    it(`subtitleLanguage ${operator} agrees between the rule and query engines`, async () => {
      const streamRule = { id: "r1", field: "subtitleLanguage", operator, value, condition: "AND" };

      const lifecycle = await evaluateLifecycleRules(group([streamRule]), "MOVIE", [serverId]);
      const query = await executeQuery(
        { mediaTypes: ["MOVIE"], serverIds: [serverId], groups: group([streamRule]), sortBy: "title", sortOrder: "asc" },
        userId, 1, 0,
      );

      expect(query.items.map((i) => i.title as string).sort())
        .toEqual(lifecycle.map((i) => i.title as string).sort());
    });
  }

  it("keeps the positive operators unchanged", async () => {
    const rule = { id: "r1", field: "subtitleLanguage", operator: "equals", value: "English", condition: "AND" };
    const rows = await evaluateLifecycleRules(group([rule]), "MOVIE", [serverId]);
    expect(rows.map((r) => r.title as string)).toEqual(["Has English Subs"]);
  });

  it("keeps isNull/isNotNull as the questions about emptiness", async () => {
    const isNull = { id: "r1", field: "subtitleLanguage", operator: "isNull", value: "", condition: "AND" };
    const isNotNull = { id: "r1", field: "subtitleLanguage", operator: "isNotNull", value: "", condition: "AND" };

    const empty = await evaluateLifecycleRules(group([isNull]), "MOVIE", [serverId]);
    expect(empty.map((r) => r.title as string).sort())
      .toEqual(["No Subs At All", "Null Subtitle Language", "Only Unknown Subs"]);

    const populated = await evaluateLifecycleRules(group([isNotNull]), "MOVIE", [serverId]);
    expect(populated.map((r) => r.title as string).sort())
      .toEqual(["Has English Subs", "Has French Subs"]);
  });

  it("leaves codec fields on the plain semantics (no placeholder set)", async () => {
    // streamAudioCodec is not a language field: "no audio stream" genuinely has
    // no codec equal to X, so the negated operator matches. Every seeded item
    // has an eac3 audio stream, so none match "notEquals eac3".
    const rule = { id: "r1", field: "streamAudioCodec", operator: "notEquals", value: "eac3", condition: "AND" };
    const phase1Only = await evaluateLifecycleRules(group([rule]), "MOVIE", [serverId]);
    const withPhase2 = await evaluateLifecycleRules(group([rule, FORCES_PHASE_2]), "MOVIE", [serverId]);
    expect(phase1Only).toHaveLength(0);
    expect(withPhase2).toHaveLength(0);
  });
});
