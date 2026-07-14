/**
 * E2E regression: `notEquals` / `notContains` / `isNull` / `isNotNull` must
 * correctly include or exclude NULL rows from the Phase 1 Prisma WHERE clause.
 *
 * Prior to the `withNullSafety` wrapper, Prisma's three-valued logic excluded
 * NULL rows from `{ field: { not: X } }` and `{ NOT: { field: ... } }`, so a
 * rule like `studio notEquals "WB"` would only return rows where `studio` was
 * explicitly some other non-null string — silently dropping every NULL row,
 * even though Phase 2's in-memory `String(itemValue ?? "")` coerces NULL to
 * "" and would have included them. Mixed Phase 1 + Phase 2 rule sets thus
 * lost items permanently.
 *
 * Seeds half the items with non-null values and half with NULLs in every
 * nullable column the engine handles, then asserts each rule returns the
 * NULL-inclusive count.
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

const { evaluateLifecycleRules } = await import("@/lib/rules/lifecycle-engine");

const FULL_COUNT = 20;
const NULL_COUNT = 20;
let serverId: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({ data: { username: "test-null-handling", passwordHash: "x" } });
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "Test", type: "PLEX", url: "http://test:32400", accessToken: "x", machineId: "null-handling-test" },
  });
  serverId = server.id;
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });

  // Group A: every nullable column populated.
  const full = Array.from({ length: FULL_COUNT }, (_, i) => ({
    libraryId: library.id,
    ratingKey: `full${i}`,
    title: `Full Movie ${i}`,
    type: "MOVIE" as const,
    year: 2020,
    studio: "WB",
    contentRating: "PG-13",
    audioCodec: "aac",
    videoCodec: "h264",
    resolution: "1080",
    audioProfile: "Dolby Atmos",
    rating: 8.0,
    audienceRating: 7.0,
    duration: 7_200_000,
    fileSize: BigInt(5000 * 1024 * 1024), // exactly 5000 binary MB (engine uses MB_IN_BYTES = 1<<20)
    genres: ["Action", "Drama"],
    labels: ["watched"],
    countries: ["United States", "Canada"],
    playCount: 2,
    addedAt: new Date("2024-01-15"),
    lastPlayedAt: new Date("2024-06-01"),
    originallyAvailableAt: new Date("2020-05-01"),
  }));

  // Group B: NULL for every nullable column. playCount stays default 0 (non-nullable).
  const nulls = Array.from({ length: NULL_COUNT }, (_, i) => ({
    libraryId: library.id,
    ratingKey: `null${i}`,
    title: `Null Movie ${i}`,
    type: "MOVIE" as const,
    // Every nullable field omitted → DB stores NULL.
  }));

  await prisma.mediaItem.createMany({ data: [...full, ...nulls] });
});

afterAll(async () => {
  await disconnectTestDb();
});

function group(field: string, operator: string, value: string, negate = false): LifecycleRuleGroup[] {
  return [{
    id: "g", condition: "AND",
    rules: [{ id: "r", field, operator, value, condition: "AND", negate }],
    groups: [],
  }];
}

async function count(rules: LifecycleRuleGroup[]) {
  return (await evaluateLifecycleRules(rules, "MOVIE", [serverId])).length;
}

describe("Rule engine — NULL handling for notEquals/notContains (Phase 1 must include NULL rows)", () => {
  it("text notEquals on nullable column includes NULL rows", async () => {
    // Group A has studio="WB". Group B has studio=NULL.
    // notEquals "WB" must return both rows that don't equal AND NULL rows = 20 (null group).
    expect(await count(group("studio", "notEquals", "WB"))).toBe(NULL_COUNT);
  });

  it("text notContains on nullable column includes NULL rows", async () => {
    expect(await count(group("audioCodec", "notContains", "aac"))).toBe(NULL_COUNT);
  });

  it("text notEquals on nullable enumerable column includes NULL rows", async () => {
    expect(await count(group("contentRating", "notEquals", "PG-13"))).toBe(NULL_COUNT);
    expect(await count(group("audioProfile", "notEquals", "Dolby Atmos"))).toBe(NULL_COUNT);
  });

  it("resolution notEquals + notContains include NULL rows", async () => {
    // Group A resolution="1080" → notEquals "1080P" must return NULL_COUNT.
    expect(await count(group("resolution", "notEquals", "1080P"))).toBe(NULL_COUNT);
    expect(await count(group("resolution", "notContains", "1080P"))).toBe(NULL_COUNT);
  });

  it("numeric notEquals on nullable Float includes NULL rows", async () => {
    // Group A rating=8.0, Group B rating=NULL → notEquals "8" returns 20.
    expect(await count(group("rating", "notEquals", "8"))).toBe(NULL_COUNT);
    expect(await count(group("audienceRating", "notEquals", "7"))).toBe(NULL_COUNT);
  });

  it("numeric notEquals on non-nullable Int (playCount) does NOT add OR null (no NULL rows possible)", async () => {
    // Group A playCount=2, Group B playCount=0 (default). notEquals "2" must return 20 (group B).
    // The withNullSafety helper must skip wrapping non-nullable columns.
    expect(await count(group("playCount", "notEquals", "2"))).toBe(NULL_COUNT);
  });

  it("date notEquals on nullable DateTime includes NULL rows", async () => {
    expect(await count(group("lastPlayedAt", "notEquals", "2024-06-01"))).toBe(NULL_COUNT);
    expect(await count(group("addedAt", "notEquals", "2024-01-15"))).toBe(NULL_COUNT);
  });

  it("fileSize notEquals on nullable BigInt includes NULL rows", async () => {
    // Group A fileSize=5GB → user value in MB. notEquals 5000 should return NULL_COUNT.
    expect(await count(group("fileSize", "notEquals", "5000"))).toBe(NULL_COUNT);
  });

  it("duration notEquals on nullable Int includes NULL rows", async () => {
    // Group A duration=7_200_000ms (=120min). notEquals "120" must return NULL_COUNT.
    expect(await count(group("duration", "notEquals", "120"))).toBe(NULL_COUNT);
  });

  it("genre notEquals + notContains on nullable JSON array include NULL rows", async () => {
    // Group A genres=["Action","Drama"]. notEquals "Action" must return NULL_COUNT.
    expect(await count(group("genre", "notEquals", "Action"))).toBe(NULL_COUNT);
    expect(await count(group("genre", "notContains", "Action"))).toBe(NULL_COUNT);
  });

  it("labels notEquals + notContains on nullable JSON array include NULL rows", async () => {
    expect(await count(group("labels", "notEquals", "watched"))).toBe(NULL_COUNT);
    expect(await count(group("labels", "notContains", "watched"))).toBe(NULL_COUNT);
  });

  it("country contains matches populated rows via Phase 1 array_contains", async () => {
    // Group A countries=["United States","Canada"]. contains "Canada" → FULL_COUNT.
    expect(await count(group("country", "contains", "Canada"))).toBe(FULL_COUNT);
    // Multi-select: matches if any selected value is present.
    expect(await count(group("country", "contains", "Canada|France"))).toBe(FULL_COUNT);
  });

  it("country notEquals + notContains on nullable JSON array include NULL rows", async () => {
    expect(await count(group("country", "notEquals", "United States"))).toBe(NULL_COUNT);
    expect(await count(group("country", "notContains", "United States"))).toBe(NULL_COUNT);
  });

  it("country isNull / isNotNull symmetric coverage", async () => {
    expect(await count(group("country", "isNull", ""))).toBe(NULL_COUNT);
    expect(await count(group("country", "isNotNull", ""))).toBe(FULL_COUNT);
  });

  it("genre isNull returns rows with NULL genres array", async () => {
    expect(await count(group("genre", "isNull", ""))).toBe(NULL_COUNT);
  });

  it("genre isNotNull returns rows with non-NULL genres array", async () => {
    expect(await count(group("genre", "isNotNull", ""))).toBe(FULL_COUNT);
  });

  it("labels isNull / isNotNull symmetric coverage", async () => {
    expect(await count(group("labels", "isNull", ""))).toBe(NULL_COUNT);
    expect(await count(group("labels", "isNotNull", ""))).toBe(FULL_COUNT);
  });

  it("notEquals negate=true inverts correctly (NULL rows excluded from negated set)", async () => {
    // notEquals "WB" matches NULL rows (20). negate=true should INVERT → match Group A (20).
    expect(await count(group("studio", "notEquals", "WB", true))).toBe(FULL_COUNT);
  });
});

/**
 * Regression for the broader negate=true bug class: any positive operator
 * (equals, contains, before, after, gt, lt, between, ...) emitted as a Phase 1
 * `NOT(positive)` excludes NULL rows under 3VL, but Phase 2 coerces NULL to a
 * default and the negation flips false → true, INCLUDING NULL rows. Phase 1
 * must use applyNegateNullable to wrap with OR null on negation. Without this,
 * a lifecycle deletion rule like `studio equals "WB" negate=true` (i.e. "items
 * whose studio is NOT WB, including unknown") would silently EXCLUDE all NULL
 * studio rows that the user expects to match.
 */
describe("Rule engine — positive operators with negate=true must include NULL rows", () => {
  it("text equals + negate=true includes NULL rows", async () => {
    // Group A studio="WB" (full), Group B studio=NULL.
    // equals "WB" matches FULL_COUNT. negate=true → NULL_COUNT.
    expect(await count(group("studio", "equals", "WB", true))).toBe(NULL_COUNT);
  });

  it("text contains + negate=true includes NULL rows", async () => {
    expect(await count(group("studio", "contains", "WB", true))).toBe(NULL_COUNT);
  });

  it("numeric equals + negate=true on nullable Float includes NULL rows", async () => {
    expect(await count(group("rating", "equals", "8", true))).toBe(NULL_COUNT);
  });

  it("numeric greaterThan + negate=true on nullable Float includes NULL rows", async () => {
    // Group A rating=8 (> 5), Group B rating=NULL.
    // greaterThan 5 matches FULL_COUNT. negate=true → NULL_COUNT.
    expect(await count(group("rating", "greaterThan", "5", true))).toBe(NULL_COUNT);
  });

  it("numeric between + negate=true on nullable Float includes NULL rows", async () => {
    expect(await count(group("rating", "between", "7,9", true))).toBe(NULL_COUNT);
  });

  it("date before + negate=true includes NULL rows", async () => {
    // Group A lastPlayedAt=2024-06-01, Group B NULL.
    // before 2025-01-01 matches FULL_COUNT. negate=true → NULL_COUNT.
    expect(await count(group("lastPlayedAt", "before", "2025-01-01", true))).toBe(NULL_COUNT);
  });

  it("date after + negate=true includes NULL rows", async () => {
    expect(await count(group("lastPlayedAt", "after", "2000-01-01", true))).toBe(NULL_COUNT);
  });

  it("date equals + negate=true includes NULL rows", async () => {
    expect(await count(group("lastPlayedAt", "equals", "2024-06-01", true))).toBe(NULL_COUNT);
  });

  it("date between + negate=true includes NULL rows", async () => {
    expect(await count(group("addedAt", "between", "2024-01-01,2024-12-31", true))).toBe(NULL_COUNT);
  });

  it("date inLastDays + negate=true includes NULL rows", async () => {
    // Group A lastPlayedAt=2024-06-01 — far in the past from test run time, so
    // "in last 99999 days" should match all Group A. negate=true → NULL_COUNT.
    expect(await count(group("lastPlayedAt", "inLastDays", "99999", true))).toBe(NULL_COUNT);
  });

  it("resolution equals + negate=true includes NULL rows", async () => {
    expect(await count(group("resolution", "equals", "1080P", true))).toBe(NULL_COUNT);
  });

  it("fileSize equals + negate=true includes NULL rows", async () => {
    expect(await count(group("fileSize", "equals", "5000", true))).toBe(NULL_COUNT);
  });

  it("duration greaterThan + negate=true includes NULL rows", async () => {
    expect(await count(group("duration", "greaterThan", "60", true))).toBe(NULL_COUNT);
  });

  it("non-nullable playCount equals + negate=true does NOT add OR null (no NULL rows)", async () => {
    // Group A playCount=2, Group B playCount=0 (default).
    // equals 2 matches FULL_COUNT. negate=true → NULL_COUNT (the playCount=0 rows).
    expect(await count(group("playCount", "equals", "2", true))).toBe(NULL_COUNT);
  });
});
