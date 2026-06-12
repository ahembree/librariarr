/**
 * Property-based phase-agreement audit for the lifecycle rule engine.
 *
 * Generates hundreds of seeded-random rule trees — nested groups, mixed
 * AND/OR connectives, per-rule and group-level negation, disabled rules,
 * wildcards, between ranges, deliberately invalid values — and asserts two
 * invariants against a real Postgres test database for every tree:
 *
 *  1. AGREEMENT — `evaluateLifecycleRules` (Phase 1 WHERE, plus Phase 2
 *     in-memory when the engine decides it needs it) returns EXACTLY the
 *     items that `evaluateAllRulesInMemory` (pure Phase 2) accepts. The
 *     engine's two phases must agree or detection and post-filters disagree
 *     about the same item.
 *
 *  2. COMPLEMENT — for trees whose leaves are all valid and enabled,
 *     wrapping the whole tree in a negated group matches exactly the
 *     remaining items (NOT can never fail open into "matches everything",
 *     and never overlaps its positive).
 *
 * Failures print the seed, tree JSON, and differing item ids — a complete
 * reproduction.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { cleanDatabase, getTestPrisma } from "../../setup/test-db";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";

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

// ─── Deterministic PRNG ──────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (rng: Rng, p: number): boolean => rng() < p;

// ─── Seeded library ──────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

interface SeedSpec {
  title: string;
  year: number | null;
  playCount: number;
  resolution: string | null;
  videoCodec: string | null;
  dynamicRange: string | null;
  audioChannels: number | null;
  container: string | null;
  contentRating: string | null;
  fileSize: bigint | null;
  duration: number | null;
  addedAt: Date | null;
  lastPlayedAt: Date | null;
}

function buildSeedSpecs(): SeedSpec[] {
  const rng = mulberry32(0xc0ffee);
  const titles = [
    "Alpha Dawn", "Beta Crest", "Crimson Tide 9", "delta point", "Echo-Lake",
    "Foxtrot", "Gamma Run", "Hidden alpha", "Iris", "Jolt 99", "Kappa Sigma",
    "Lima Noon", "MIDNIGHT SUN", "November Rain", "Oasis", "Punct.uated",
    "Quartz", "rho", "Sierra Madre", "Tango & Cash", "Umbra", "Vortex 4K",
    "Whiskey", "Xenon", "Yankee", "Zulu Hour", "", " padded ", "ümlaut Über",
    "100% Wolf", "a", "The The",
  ];
  return titles.map((title, i) => ({
    title: title || `untitled-${i}`,
    year: pick(rng, [null, 1995, 2000, 2015, 2024] as const),
    playCount: pick(rng, [0, 0, 1, 5, 42] as const),
    resolution: pick(rng, [null, "sd", "720", "1080", "4k"] as const),
    videoCodec: pick(rng, [null, "h264", "hevc", "av1", "mpeg2video"] as const),
    dynamicRange: pick(rng, [null, "SDR", "HDR10", "Dolby Vision"] as const),
    audioChannels: pick(rng, [null, 2, 6, 8] as const),
    container: pick(rng, [null, "mkv", "mp4", "avi"] as const),
    contentRating: pick(rng, [null, "G", "PG-13", "R"] as const),
    fileSize: pick(rng, [null, 52_428_800n, 524_288_000n, 5_368_709_120n, 53_687_091_200n] as const),
    duration: pick(rng, [null, 1_500_000, 5_400_000, 7_200_000] as const),
    addedAt: pick(rng, [null, new Date(NOW - 400 * DAY), new Date(NOW - 45 * DAY), new Date(NOW - 2 * DAY)] as const),
    lastPlayedAt: pick(rng, [null, null, new Date(NOW - 500 * DAY), new Date(NOW - 10 * DAY)] as const),
  }));
}

// ─── Random rule-tree generator ──────────────────────────────────────────────

interface FieldGen {
  field: string;
  type: "number" | "text" | "date";
  values: readonly string[];
}

const FIELDS: readonly FieldGen[] = [
  { field: "year", type: "number", values: ["1995", "2000", "2015", "2024", "2030", "0"] },
  { field: "playCount", type: "number", values: ["0", "1", "5", "42", "100"] },
  { field: "audioChannels", type: "number", values: ["2", "6", "8", "3"] },
  { field: "fileSize", type: "number", values: ["50", "500", "5000", "51200", "999999"] }, // MB
  { field: "duration", type: "number", values: ["25", "90", "120", "300"] }, // minutes
  { field: "title", type: "text", values: ["alpha", "Alpha", "a", "ZZZ", "the", "%", ""] },
  { field: "resolution", type: "text", values: ["sd", "720", "1080", "4k", "8k", "sd|720", "1080|4k"] },
  { field: "videoCodec", type: "text", values: ["h264", "hevc", "HEVC", "av1", "vp9", "h264|hevc"] },
  { field: "dynamicRange", type: "text", values: ["SDR", "HDR10", "Dolby Vision", "HLG"] },
  { field: "container", type: "text", values: ["mkv", "mp4", "avi", "mk", "mkv|mp4"] },
  { field: "contentRating", type: "text", values: ["G", "PG-13", "R", "TV-MA"] },
  { field: "addedAt", type: "date", values: ["30", "100", "365", "1000"] },
] as const;

const NUMBER_OPS = ["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "isNull", "isNotNull"] as const;
const TEXT_OPS = ["equals", "notEquals", "contains", "notContains", "matchesWildcard", "notMatchesWildcard", "isNull", "isNotNull"] as const;
const DATE_OPS = ["before", "after", "inLastDays", "notInLastDays", "between", "isNull", "isNotNull"] as const;

const WILDCARDS = ["*a*", "?lpha*", "*4k*", "*", "z*", "*9?"] as const;

let ruleSeq = 0;

interface GenContext {
  /** false when any leaf is deliberately malformed — complement law only
   *  asserted for fully valid trees */
  valid: boolean;
  /** at least one enabled rule exists somewhere */
  hasActive: boolean;
}

function genRule(rng: Rng, ctx: GenContext): LifecycleRule {
  const fg = pick(rng, FIELDS);
  const ops = fg.type === "number" ? NUMBER_OPS : fg.type === "date" ? DATE_OPS : TEXT_OPS;
  let operator: string = pick(rng, ops);
  // playCount is non-nullable — isNull there is a degenerate-but-legal rule;
  // keep it occasionally but treat tree as still valid (engine must handle it)
  let value: string;
  if (operator === "isNull" || operator === "isNotNull") {
    value = "";
  } else if (operator === "between") {
    if (fg.type === "date") {
      value = pick(rng, ["2010-01-01,2020-01-01", "2020-01-01,2010-01-01", "2015-06-01,"] as const);
      if (value !== "2010-01-01,2020-01-01") ctx.valid = false; // inverted/half ranges are dead rules
    } else {
      value = pick(rng, ["1,2000", "2000,2024", "9,1", "5,", ",5"] as const);
      if (value === "9,1" || value === "5," || value === ",5") ctx.valid = false;
    }
  } else if (operator === "matchesWildcard" || operator === "notMatchesWildcard") {
    if (fg.type !== "text") {
      operator = "equals";
      value = pick(rng, fg.values);
    } else {
      value = pick(rng, WILDCARDS);
    }
  } else if (fg.type === "date" && (operator === "before" || operator === "after")) {
    value = pick(rng, ["2010-01-01", "2024-01-01", "not-a-date"] as const);
    if (value === "not-a-date") ctx.valid = false;
  } else if (fg.type === "date") {
    value = pick(rng, fg.values);
  } else {
    value = pick(rng, fg.values);
    if (value === "" || (fg.type === "number" && Number.isNaN(Number(value)))) ctx.valid = false;
  }
  // contains/notContains with pipes only applies to enumerable fields; for
  // free-text fields a pipe is a literal — both are legal inputs.
  const enabled = chance(rng, 0.1) ? false : undefined;
  if (enabled !== false) ctx.hasActive = true;
  return {
    id: `r${++ruleSeq}`,
    field: fg.field,
    operator,
    value,
    condition: chance(rng, 0.5) ? "AND" : "OR",
    negate: chance(rng, 0.25) ? true : undefined,
    enabled,
  };
}

function genGroup(rng: Rng, depth: number, ctx: GenContext): LifecycleRuleGroup {
  const ruleCount = 1 + Math.floor(rng() * 3);
  const rules = Array.from({ length: ruleCount }, () => genRule(rng, ctx));
  const subCount = depth < 2 && chance(rng, 0.45) ? 1 + (chance(rng, 0.25) ? 1 : 0) : 0;
  const groups = Array.from({ length: subCount }, () => genGroup(rng, depth + 1, ctx));
  return {
    id: `g${++ruleSeq}`,
    condition: chance(rng, 0.5) ? "AND" : "OR",
    rules,
    groups,
    enabled: chance(rng, 0.07) ? false : undefined,
    negate: chance(rng, 0.25) ? true : undefined,
  };
}

function genTree(rng: Rng): { groups: LifecycleRuleGroup[]; ctx: GenContext } {
  const ctx: GenContext = { valid: true, hasActive: false };
  const count = 1 + (chance(rng, 0.3) ? 1 : 0);
  const groups = Array.from({ length: count }, () => genGroup(rng, 0, ctx));
  // top-level group disabled flags affect hasActive too
  if (groups.every((g) => g.enabled === false)) ctx.hasActive = false;
  return { groups, ctx };
}

// ─── Phase 2 reference evaluation ────────────────────────────────────────────

/** Mirrors the serialization evaluateLifecycleRules applies before its own
 *  in-memory filter, so the reference evaluation sees identical shapes. */
function serialize(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    fileSize: item.fileSize != null ? String(item.fileSize) : null,
    lastPlayedAt: item.lastPlayedAt ? (item.lastPlayedAt as Date).toISOString() : null,
    addedAt: item.addedAt ? (item.addedAt as Date).toISOString() : null,
    originallyAvailableAt: null,
    streams: [],
    watchHistory: [],
  };
}

// ─── The audit ───────────────────────────────────────────────────────────────

const TREES = 500;
const SEED = 0x5eed;

let serverId: string;
let allItems: Array<Record<string, unknown> & { id: string }>;

describe("rule engine phase agreement (property audit)", () => {
  beforeAll(async () => {
    await cleanDatabase();
    const prisma = getTestPrisma();
    const user = await prisma.user.create({
      data: { username: "property-audit", passwordHash: "x" },
    });
    const server = await prisma.mediaServer.create({
      data: {
        userId: user.id,
        name: "Audit",
        type: "PLEX",
        url: "http://audit:32400",
        accessToken: "x",
        machineId: "property-audit",
      },
    });
    serverId = server.id;
    const library = await prisma.library.create({
      data: {
        mediaServerId: server.id,
        key: "lib-audit",
        title: "Movies",
        type: "MOVIE",
      },
    });
    const specs = buildSeedSpecs();
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      await prisma.mediaItem.create({
        data: {
          libraryId: library.id,
          ratingKey: `audit-${i}`,
          type: "MOVIE",
          title: s.title,
          year: s.year,
          playCount: s.playCount,
          resolution: s.resolution,
          videoCodec: s.videoCodec,
          dynamicRange: s.dynamicRange,
          audioChannels: s.audioChannels,
          container: s.container,
          contentRating: s.contentRating,
          fileSize: s.fileSize,
          duration: s.duration,
          addedAt: s.addedAt,
          lastPlayedAt: s.lastPlayedAt,
        },
      });
    }
    allItems = (await prisma.mediaItem.findMany({
      where: { library: { mediaServerId: server.id } },
    })) as never;
    expect(allItems.length).toBe(specs.length);
  }, 60_000);

  it(`phase 1 and phase 2 agree exactly across ${TREES} random trees`, async () => {
    const rng = mulberry32(SEED);
    const failures: string[] = [];

    for (let t = 0; t < TREES; t++) {
      const { groups, ctx } = genTree(rng);

      const engineItems = (await evaluateLifecycleRules(groups, "MOVIE", [serverId])) as Array<{ id: string }>;
      const engineIds = new Set(engineItems.map((i) => i.id));

      const memIds = new Set(
        allItems
          .filter((item) => evaluateAllRulesInMemory(groups, serialize(item)))
          .map((i) => i.id),
      );
      // hasAnyActiveRules guard: engine returns [] when nothing is active —
      // the reference must compare against the same guard semantics
      const expectedIds = ctx.hasActive ? memIds : new Set<string>();

      if (
        engineIds.size !== expectedIds.size ||
        [...engineIds].some((id) => !expectedIds.has(id))
      ) {
        const onlyEngine = [...engineIds].filter((id) => !expectedIds.has(id));
        const onlyMem = [...expectedIds].filter((id) => !engineIds.has(id));
        const label = (ids: string[]) =>
          ids.map((id) => (allItems.find((i) => i.id === id) as { title?: string })?.title).join(", ");
        failures.push(
          `tree #${t}: engine=${engineIds.size} mem=${expectedIds.size}\n` +
            `  only-engine: [${label(onlyEngine)}]\n  only-mem: [${label(onlyMem)}]\n` +
            `  tree: ${JSON.stringify(groups)}`,
        );
        if (failures.length >= 5) break;
      }
    }

    expect(failures, failures.join("\n\n")).toEqual([]);
  }, 240_000);

  it("group NOT is an exact complement for fully valid trees", async () => {
    const rng = mulberry32(SEED ^ 0xbadc0de);
    const failures: string[] = [];
    let checked = 0;

    for (let t = 0; t < TREES && checked < 150; t++) {
      const { groups, ctx } = genTree(rng);
      if (!ctx.valid || !ctx.hasActive) continue;
      checked++;

      const positive = (await evaluateLifecycleRules(groups, "MOVIE", [serverId])) as Array<{ id: string }>;
      const wrapped: LifecycleRuleGroup[] = [
        { id: `wrap-${t}`, condition: "AND", negate: true, rules: [], groups },
      ];
      const negative = (await evaluateLifecycleRules(wrapped, "MOVIE", [serverId])) as Array<{ id: string }>;

      const pos = new Set(positive.map((i) => i.id));
      const neg = new Set(negative.map((i) => i.id));
      const overlap = [...pos].filter((id) => neg.has(id));
      const union = pos.size + neg.size;

      if (overlap.length > 0 || union !== allItems.length) {
        failures.push(
          `tree #${t}: pos=${pos.size} neg=${neg.size} all=${allItems.length} overlap=${overlap.length}\n` +
            `  tree: ${JSON.stringify(groups)}`,
        );
        if (failures.length >= 5) break;
      }
    }

    expect(checked).toBeGreaterThan(50);
    expect(failures, failures.join("\n\n")).toEqual([]);
  }, 240_000);

  it("degenerate rule sets fail closed, never open", async () => {
    const cases: Array<{ name: string; groups: LifecycleRuleGroup[] }> = [
      { name: "empty groups array", groups: [] },
      { name: "single empty group", groups: [{ id: "g", condition: "AND", rules: [], groups: [] }] },
      {
        name: "all rules disabled",
        groups: [{ id: "g", condition: "AND", rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND", enabled: false }], groups: [] }],
      },
      {
        name: "group disabled",
        groups: [{ id: "g", condition: "AND", enabled: false, rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND" }], groups: [] }],
      },
      {
        name: "negated empty group",
        groups: [{ id: "g", condition: "AND", negate: true, rules: [], groups: [] }],
      },
      {
        name: "negated all-disabled group",
        groups: [{ id: "g", condition: "AND", negate: true, rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND", enabled: false }], groups: [] }],
      },
      {
        name: "unknown field",
        groups: [{ id: "g", condition: "AND", rules: [{ id: "r", field: "nonsenseField", operator: "equals", value: "x", condition: "AND" }], groups: [] }],
      },
      {
        name: "negated unknown field",
        groups: [{ id: "g", condition: "AND", rules: [{ id: "r", field: "nonsenseField", operator: "equals", value: "x", condition: "AND", negate: true }], groups: [] }],
      },
      {
        name: "NOT group around unknown field",
        groups: [{ id: "g", condition: "AND", negate: true, rules: [{ id: "r", field: "nonsenseField", operator: "equals", value: "x", condition: "AND" }], groups: [] }],
      },
      {
        name: "inverted between negated",
        groups: [{ id: "g", condition: "AND", rules: [{ id: "r", field: "year", operator: "between", value: "9,1", condition: "AND", negate: true }], groups: [] }],
      },
      {
        name: "unknown operator negated",
        groups: [{ id: "g", condition: "AND", rules: [{ id: "r", field: "year", operator: "frobnicate", value: "1", condition: "AND", negate: true }], groups: [] }],
      },
    ];

    for (const c of cases) {
      const result = (await evaluateLifecycleRules(c.groups, "MOVIE", [serverId])) as unknown[];
      expect(result.length, `"${c.name}" must not fail open (matched ${result.length}/${allItems.length})`).toBe(0);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Legacy flat rules — converted through the same group machinery, so the
// phases must agree for the pre-groups format too (incl. disabled rules,
// whose connectives previously moved Phase 1 bucket boundaries).
// ---------------------------------------------------------------------------

describe("legacy flat rules phase agreement", () => {
  it(`agrees across 150 random flat rule sets`, async () => {
    const rng = mulberry32(SEED ^ 0xf1a7);
    const failures: string[] = [];
    for (let t = 0; t < 150; t++) {
      const ctx: GenContext = { valid: true, hasActive: false };
      const count = 1 + Math.floor(rng() * 4);
      const flat = Array.from({ length: count }, () => genRule(rng, ctx));

      const engineItems = (await evaluateLifecycleRules(flat, "MOVIE", [serverId])) as Array<{ id: string }>;
      const engineIds = new Set(engineItems.map((i) => i.id));
      const memIds = new Set(
        allItems.filter((item) => evaluateAllRulesInMemory(flat, serialize(item))).map((i) => i.id),
      );
      const expectedIds = ctx.hasActive ? memIds : new Set<string>();
      if (engineIds.size !== expectedIds.size || [...engineIds].some((id) => !expectedIds.has(id))) {
        failures.push(`flat #${t}: engine=${engineIds.size} mem=${expectedIds.size} rules=${JSON.stringify(flat)}`);
        if (failures.length >= 5) break;
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  }, 120_000);

  it("disabled flat rules neither constrain nor move bucket boundaries", async () => {
    // (A pc=0 OR) (B year<1980 AND, DISABLED) (C container=mkv) — enabled
    // semantics: single bucket A ∨ C. The old Phase 1 evaluated
    // (A ∨ B) ∧ C because B's connective split the buckets.
    const flat = [
      { id: "A", field: "playCount", operator: "equals", value: "0", condition: "OR" },
      { id: "B", field: "year", operator: "lessThan", value: "1980", condition: "AND", enabled: false },
      { id: "C", field: "container", operator: "equals", value: "mkv", condition: "AND" },
    ] as never;
    const engineIds = new Set(
      ((await evaluateLifecycleRules(flat, "MOVIE", [serverId])) as Array<{ id: string }>).map((i) => i.id),
    );
    const memIds = new Set(
      allItems.filter((item) => evaluateAllRulesInMemory(flat, serialize(item))).map((i) => i.id),
    );
    expect([...engineIds].sort()).toEqual([...memIds].sort());
    // sanity: A ∨ C semantics — every playCount=0 item matches regardless of container
    const unwatched = allItems.filter((i) => (i as { playCount?: number }).playCount === 0);
    for (const it of unwatched) expect(engineIds.has(it.id)).toBe(true);
  });
});
