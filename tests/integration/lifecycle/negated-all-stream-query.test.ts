/**
 * A stream query with the "all" quantifier inside a NOT group.
 *
 * Regression: `pushDownGroupNegation` mapped NOT onto a stream query's
 * quantifier (any ↔ none) and simply DROPPED it for "all", so
 * NOT (resolution = 4K AND all audio Language = English) evaluated as
 * (NOT 4K) OR (all audio English) — it matched exactly the 4K all-English
 * movies a DELETE_RADARR rule set was written to keep, and none of the 4K
 * French ones it was written to delete. NOT all(P) is "some stream of the type
 * fails P"; an item with no stream of the type matches neither.
 *
 * Checked in both engines (end to end, Phase 1 + Phase 2), in Phase 1 alone
 * (the WHERE clause against the database) and in each engine's Phase 2.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRuleGroup } from "@/lib/rules/types";
import type { QueryDefinition, QueryGroup } from "@/lib/query/types";
import type { ConditionGroup } from "@/lib/conditions/types";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { evaluateLifecycleRules, evaluateAllRulesInMemory } from "@/lib/rules/lifecycle-engine";
import { executeQuery, evaluateAllQueryRulesInMemory } from "@/lib/query/query-engine";
import { buildGroupConditions } from "@/lib/conditions/group-composition";
import { ruleToWhere } from "@/lib/conditions/where-builder";

const AUDIO = 2;

let userId: string;
let serverId: string;
/** Title → item id. */
const ids: Record<string, string> = {};
/** Title → the item as Phase 2 reads it (streams loaded). */
const rows: Record<string, Record<string, unknown>> = {};

// Each movie: resolution, year, and its audio tracks' languages.
const MOVIES: Array<{ title: string; resolution: string; year: number; audio: Array<string | null> }> = [
  { title: "4K English", resolution: "4k", year: 2020, audio: ["English", "English"] },
  { title: "4K French", resolution: "4k", year: 2020, audio: ["French"] },
  { title: "4K Mixed", resolution: "4k", year: 2020, audio: ["English", "French"] },
  { title: "4K Unknown Language", resolution: "4k", year: 2020, audio: [null] },
  { title: "4K No Audio", resolution: "4k", year: 2020, audio: [] },
  { title: "1080p English", resolution: "1080", year: 2019, audio: ["English"] },
];

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({ data: { username: "negated-all", passwordHash: "x" } });
  userId = user.id;
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "Test", type: "PLEX", url: "http://test:32400", accessToken: "x", machineId: "negated-all" },
  });
  serverId = server.id;
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });
  for (const m of MOVIES) {
    const item = await prisma.mediaItem.create({
      data: {
        libraryId: library.id, ratingKey: m.title, title: m.title, type: "MOVIE",
        resolution: m.resolution, year: m.year,
        streams: { create: m.audio.map((language) => ({ streamType: AUDIO, codec: "aac", language })) },
      },
      include: { streams: true },
    });
    ids[m.title] = item.id;
    rows[m.title] = item as unknown as Record<string, unknown>;
  }
});

afterAll(async () => {
  await disconnectTestDb();
});

/**
 * One group: `<field> = <value> AND <quantifier> audio stream where Language
 * = English`, negated as a whole unless `negate` is false.
 */
function rules(
  quantifier: "any" | "none" | "all",
  opts: { field?: string; value?: string; negate?: boolean } = {},
): ConditionGroup[] {
  return [
    {
      id: "outer",
      condition: "AND",
      negate: opts.negate ?? true,
      rules: [
        { id: "res", field: opts.field ?? "resolution", operator: "equals", value: opts.value ?? "4K", condition: "AND" },
      ],
      groups: [
        {
          id: "audio",
          condition: "AND",
          rules: [{ id: "lang", field: "sqLanguage", operator: "equals", value: "English", condition: "AND" }],
          groups: [],
          streamQuery: { streamType: "audio", quantifier },
        },
      ],
    },
  ];
}

/** A NOT group holding only a stream query (no other condition). */
function negatedStreamOnly(quantifier: "any" | "none" | "all"): ConditionGroup[] {
  return [
    {
      id: "outer",
      condition: "AND",
      negate: true,
      rules: [],
      groups: [
        {
          id: "audio",
          condition: "AND",
          rules: [{ id: "lang", field: "sqLanguage", operator: "equals", value: "English", condition: "AND" }],
          groups: [],
          streamQuery: { streamType: "audio", quantifier },
        },
      ],
    },
  ];
}

const titlesFor = (itemIds: string[]) =>
  Object.entries(ids).filter(([, id]) => itemIds.includes(id)).map(([title]) => title).sort();

async function lifecycleTitles(groups: ConditionGroup[]): Promise<string[]> {
  const items = await evaluateLifecycleRules(groups as unknown as LifecycleRuleGroup[], "MOVIE", [serverId]);
  return titlesFor(items.map((i) => i.id));
}

async function queryTitles(groups: ConditionGroup[]): Promise<string[]> {
  const definition: QueryDefinition = {
    mediaTypes: ["MOVIE"], serverIds: [serverId], groups: groups as unknown as QueryGroup[],
    sortBy: "title", sortOrder: "asc",
  };
  const result = await executeQuery(definition, userId, 1, 0);
  return titlesFor(result.items.map((i) => i.id as string));
}

/** Phase 1 on its own: the WHERE clause both engines build, run against the database. */
async function phase1Titles(groups: ConditionGroup[]): Promise<string[]> {
  const where = buildGroupConditions(groups, ruleToWhere);
  const items = await getTestPrisma().mediaItem.findMany({
    where: { type: "MOVIE", AND: [where] },
    select: { id: true },
  });
  return titlesFor(items.map((i) => i.id));
}

function phase2Titles(groups: ConditionGroup[], engine: "lifecycle" | "query"): string[] {
  return Object.entries(rows)
    .filter(([, row]) =>
      engine === "lifecycle"
        ? evaluateAllRulesInMemory(groups as unknown as LifecycleRuleGroup[], row)
        : evaluateAllQueryRulesInMemory(groups as unknown as QueryGroup[], row, undefined, undefined),
    )
    .map(([title]) => title)
    .sort();
}

// NOT (4K AND all audio English): everything but the 4K all-English movie, and
// not the 4K movie with no audio track at all (no track fails the rule).
const NOT_4K_ALL_ENGLISH = ["1080p English", "4K French", "4K Mixed", "4K Unknown Language"];

describe("NOT (4K AND all audio Language = English)", () => {
  it("lifecycle engine: 4K all-English does not match, 4K French does", async () => {
    const matched = await lifecycleTitles(rules("all"));
    expect(matched).not.toContain("4K English");
    expect(matched).toContain("4K French");
    expect(matched).toEqual(NOT_4K_ALL_ENGLISH);
  });

  it("query engine: 4K all-English does not match, 4K French does", async () => {
    expect(await queryTitles(rules("all"))).toEqual(NOT_4K_ALL_ENGLISH);
  });

  it("Phase 2 of each engine agrees", () => {
    expect(phase2Titles(rules("all"), "lifecycle")).toEqual(NOT_4K_ALL_ENGLISH);
    expect(phase2Titles(rules("all"), "query")).toEqual(NOT_4K_ALL_ENGLISH);
  });

  it("Phase 1 alone selects the same items (year standing in for resolution, which only Phase 2 reads)", async () => {
    expect(await phase1Titles(rules("all", { field: "year", value: "2020" }))).toEqual(NOT_4K_ALL_ENGLISH);
  });

  it("the un-negated group still matches only the 4K all-English movie", async () => {
    expect(await lifecycleTitles(rules("all", { negate: false }))).toEqual(["4K English"]);
    expect(await queryTitles(rules("all", { negate: false }))).toEqual(["4K English"]);
  });
});

describe("NOT (all audio Language = English) on its own", () => {
  // Some audio track is not English; an item without audio tracks matches neither.
  const expected = ["4K French", "4K Mixed", "4K Unknown Language"];

  it("matches the items with a non-English audio track, in both engines and both phases", async () => {
    const groups = negatedStreamOnly("all");
    expect(await lifecycleTitles(groups)).toEqual(expected);
    expect(await queryTitles(groups)).toEqual(expected);
    expect(await phase1Titles(groups)).toEqual(expected);
    expect(phase2Titles(groups, "lifecycle")).toEqual(expected);
    expect(phase2Titles(groups, "query")).toEqual(expected);
  });
});

describe("NOT around the any / none quantifiers (unchanged)", () => {
  it("NOT (any audio English) matches items with no English audio track", async () => {
    const expected = ["4K French", "4K No Audio", "4K Unknown Language"];
    const groups = negatedStreamOnly("any");
    expect(await lifecycleTitles(groups)).toEqual(expected);
    expect(await queryTitles(groups)).toEqual(expected);
    expect(await phase1Titles(groups)).toEqual(expected);
  });

  it("NOT (none audio English) matches items with an English audio track", async () => {
    const expected = ["1080p English", "4K English", "4K Mixed"];
    const groups = negatedStreamOnly("none");
    expect(await lifecycleTitles(groups)).toEqual(expected);
    expect(await queryTitles(groups)).toEqual(expected);
    expect(await phase1Titles(groups)).toEqual(expected);
  });

  it("NOT (4K AND any audio English) matches all but the 4K movies with an English track", async () => {
    const expected = ["1080p English", "4K French", "4K No Audio", "4K Unknown Language"];
    expect(await lifecycleTitles(rules("any"))).toEqual(expected);
    expect(await queryTitles(rules("any"))).toEqual(expected);
  });
});
