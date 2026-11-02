/**
 * Phase-agreement regression for the field families the property audit in
 * `engine-phase-agreement.property.test.ts` does not seed: the stream-relation
 * fields and the JSONB-array fields.
 *
 * The invariant is the same one that file protects — `evaluateLifecycleRules`
 * (Phase 1 WHERE, plus Phase 2 when the engine decides it needs it) must return
 * EXACTLY what `evaluateAllRulesInMemory` accepts. Phase 2 only runs when
 * something in the rule set demands it, so a disagreement means the same rule
 * matches a DIFFERENT set depending on an unrelated rule beside it — and on a
 * DELETE rule set, a different set of files.
 *
 * Three disagreements are pinned here, each found by fuzzing these families:
 *
 *  1. Language fields under `negate` — Phase 1 wrapped the clause in `NOT`
 *     without the "has a known language of this type" conjunct, so
 *     `NOT (audioLanguage equals German)` matched every item with no audio
 *     track or only an `Unknown` one, which Phase 2 refuses under every
 *     operator. All four value operators were affected; a group-level NOT
 *     produces exactly this shape via `pushDownGroupNegation`.
 *  2. JSON-array fields and case — `array_contains` is case-sensitive and
 *     `matchArrayField` is not, so `genre equals "action"` found nothing in SQL
 *     and four items in memory, and `notContains` matched EVERYTHING in SQL.
 *  3. JSON-array fields and a stored empty array — Phase 1 tested only
 *     `Prisma.DbNull`, so `[]` read as "not empty" in SQL and "empty" in memory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { evaluateLifecycleRules, evaluateAllRulesInMemory } = await import(
  "@/lib/rules/lifecycle-engine"
);

let serverId: string;
let allItems: Array<Record<string, unknown> & { id: string; title: string }>;

const group = (rules: unknown[]): LifecycleRuleGroup[] => [
  { id: "g1", condition: "AND", rules, groups: [] } as unknown as LifecycleRuleGroup,
];

const rule = (
  field: string,
  operator: string,
  value = "",
  negate?: boolean,
) => ({ id: "r1", field, operator, value, condition: "AND", negate });

/** Phase-1-or-engine result vs the pure Phase-2 reference, as sorted titles. */
async function bothPhases(groups: LifecycleRuleGroup[]) {
  const engine = (
    (await evaluateLifecycleRules(groups, "MOVIE", [serverId])) as Array<{ title: string }>
  )
    .map((i) => i.title)
    .sort();
  const memory = allItems
    .filter((i) =>
      evaluateAllRulesInMemory(groups, {
        ...i,
        fileSize: null,
        lastPlayedAt: null,
        addedAt: null,
        originallyAvailableAt: null,
      }),
    )
    .map((i) => i.title)
    .sort();
  return { engine, memory };
}

async function expectAgreement(groups: LifecycleRuleGroup[]) {
  const { engine, memory } = await bothPhases(groups);
  expect(engine).toEqual(memory);
  return engine;
}

const LANG_FIELDS = ["audioLanguage", "subtitleLanguage"] as const;
const VALUE_OPS = ["equals", "contains", "notEquals", "notContains"] as const;
const ARRAY_FIELDS = ["genre", "labels", "country"] as const;

describe("phase agreement: stream-relation and JSON-array fields", () => {
  beforeAll(async () => {
    await cleanDatabase();
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { username: "field-family-agreement", passwordHash: "x" },
    });
    const server = await prisma.mediaServer.create({
      data: {
        userId: user.id,
        name: "Test",
        type: "PLEX",
        url: "http://test:32400",
        accessToken: "x",
        machineId: "field-family-agreement",
      },
    });
    serverId = server.id;
    const lib = await prisma.library.create({
      data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
    });

    const seed = async (
      title: string,
      tags: string[] | undefined,
      streams: Array<{ streamType: number; language: string | null }>,
    ) => {
      const item = await prisma.mediaItem.create({
        data: {
          libraryId: lib.id,
          ratingKey: `ffa-${title}`,
          type: "MOVIE",
          title,
          // One value drives all three array columns — they share a handler and
          // an evaluator, so any divergence between them is also a bug.
          ...(tags === undefined
            ? {}
            : { genres: tags as never, labels: tags as never, countries: tags as never }),
        },
      });
      for (const s of streams) {
        await prisma.mediaStream.create({
          data: { mediaItemId: item.id, streamType: s.streamType, language: s.language },
        });
      }
    };

    // Stored tags are Title Case; every rule below asks in lower case.
    await seed("English", ["Action"], [{ streamType: 2, language: "English" }]);
    await seed("German", ["Drama"], [{ streamType: 2, language: "German" }]);
    // The three "no known language" shapes Phase 2 refuses to match.
    await seed("NoStream", ["Action"], []);
    await seed("UnknownLang", ["Action"], [{ streamType: 2, language: "Unknown" }]);
    await seed("EmptyLang", ["Action"], [{ streamType: 2, language: "" }]);
    await seed("NullLang", ["Action"], [{ streamType: 2, language: null }]);
    // Array-column edges: a stored empty array vs a genuine NULL.
    await seed("TagsEmptyArray", [], [{ streamType: 2, language: "English" }]);
    await seed("TagsNull", undefined, [{ streamType: 2, language: "English" }]);

    allItems = (await prisma.mediaItem.findMany({
      where: { library: { mediaServerId: server.id } },
      include: {
        streams: true,
        externalIds: true,
        watchHistory: { select: { serverUsername: true } },
      },
    })) as never;
    expect(allItems).toHaveLength(8);
  }, 60_000);

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe("stream language fields", () => {
    for (const field of LANG_FIELDS) {
      for (const operator of VALUE_OPS) {
        for (const negate of [false, true]) {
          it(`${field} ${operator} negate=${negate}`, async () => {
            await expectAgreement(group([rule(field, operator, "German", negate || undefined)]));
          });
        }
      }
      for (const operator of ["isNull", "isNotNull"] as const) {
        for (const negate of [false, true]) {
          it(`${field} ${operator} negate=${negate}`, async () => {
            await expectAgreement(group([rule(field, operator, "", negate || undefined)]));
          });
        }
      }
    }

    it("NOT (audioLanguage equals X) excludes items with no known audio language", async () => {
      // The specific regression: a bare `NOT { streams: { some } }` in SQL is
      // satisfied by a row with no audio stream at all, or only an Unknown one.
      const matched = await expectAgreement(
        group([rule("audioLanguage", "equals", "German", true)]),
      );
      // Only the items with a KNOWN, non-German audio language.
      expect(matched).toEqual(["English", "TagsEmptyArray", "TagsNull"]);
    });

    it("a group-level NOT around a language rule agrees too", async () => {
      // pushDownGroupNegation turns this into the per-rule negate above, which
      // is how a user reaches the broken shape without touching a rule's own
      // NOT toggle.
      const groups = [
        {
          id: "g1",
          condition: "AND",
          negate: true,
          rules: [rule("audioLanguage", "equals", "German")],
          groups: [],
        } as unknown as LifecycleRuleGroup,
      ];
      expect(await expectAgreement(groups)).toEqual(["English", "TagsEmptyArray", "TagsNull"]);
    });

    it("codec fields keep the plain semantics (no placeholder set)", async () => {
      // streamAudioCodec has no Unknown/"" convention, so "no audio stream"
      // genuinely has no codec equal to X — it must NOT gain the guard.
      for (const negate of [false, true]) {
        await expectAgreement(
          group([rule("streamAudioCodec", "equals", "eac3", negate || undefined)]),
        );
      }
    });
  });

  describe("JSON-array fields", () => {
    for (const field of ARRAY_FIELDS) {
      for (const operator of VALUE_OPS) {
        for (const negate of [false, true]) {
          it(`${field} ${operator} negate=${negate} (case-insensitive)`, async () => {
            await expectAgreement(group([rule(field, operator, "action", negate || undefined)]));
          });
        }
      }
      for (const operator of ["isNull", "isNotNull"] as const) {
        it(`${field} ${operator} treats a stored [] as empty`, async () => {
          await expectAgreement(group([rule(field, operator)]));
        });
      }
    }

    it("matches regardless of the value's case", async () => {
      const lower = await expectAgreement(group([rule("genre", "equals", "action")]));
      const exact = await expectAgreement(group([rule("genre", "equals", "Action")]));
      expect(lower).toEqual(exact);
      expect(lower).toEqual(["EmptyLang", "English", "NoStream", "NullLang", "UnknownLang"]);
    });

    it("notContains does not sweep the library", async () => {
      // The dangerous direction: SQL's case-sensitive array_contains made
      // `NOT contains "action"` true for every row, including the Action ones.
      const matched = await expectAgreement(group([rule("genre", "notContains", "action")]));
      expect(matched).toEqual(["German", "TagsEmptyArray", "TagsNull"]);
    });

    it("isNull counts a stored empty array as empty", async () => {
      const matched = await expectAgreement(group([rule("genre", "isNull")]));
      expect(matched).toEqual(["TagsEmptyArray", "TagsNull"]);
    });

    it("isNotNull does not count a stored empty array", async () => {
      const matched = await expectAgreement(group([rule("genre", "isNotNull")]));
      expect(matched).toEqual(["EmptyLang", "English", "German", "NoStream", "NullLang", "UnknownLang"]);
    });
  });
});
