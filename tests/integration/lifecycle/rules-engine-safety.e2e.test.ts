/**
 * End-to-end safety guarantees for the lifecycle rule engine.
 *
 * Unlike the unit tests in tests/unit/rules/, these run the WHOLE Phase 1
 * (Prisma WHERE) + Phase 2 (in-memory) pipeline against a real Postgres
 * test database. The point is to verify that the hazards we hardened against
 * — empty/whitespace contains, unknown operators, type mismatches, NaN
 * values, malformed `between`, vacuous-truth wildcards — never produce a
 * match-all in the actual deletion path, even when negate=true.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import type { RuleGroup } from "@/lib/rules/types";

// Critical: redirect prisma to test database
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import AFTER the prisma mock so the engine wires up to the test DB
const { evaluateRules } = await import("@/lib/rules/lifecycle-engine");

const SEED_COUNT = 50;
let serverId: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({
    data: { username: "test-engine-safety", passwordHash: "x" },
  });
  const server = await prisma.mediaServer.create({
    data: {
      userId: user.id,
      name: "Test Server", type: "PLEX", url: "http://test:32400",
      accessToken: "x", machineId: "rules-engine-safety-test",
    },
  });
  serverId = server.id;
  const library = await prisma.library.create({
    data: { mediaServerId: server.id, key: "1", title: "Movies", type: "MOVIE" },
  });
  const items = Array.from({ length: SEED_COUNT }, (_, i) => ({
    libraryId: library.id,
    ratingKey: `mv${i}`,
    title: `Movie ${i}`,
    type: "MOVIE" as const,
    year: 2000 + (i % 25),
    studio: i % 2 === 0 ? "Warner Bros" : "Disney",
    genres: i % 3 === 0 ? ["Action"] : ["Comedy"],
    playCount: i,
  }));
  await prisma.mediaItem.createMany({ data: items });
});

afterAll(async () => {
  await disconnectTestDb();
});

function group(rules: RuleGroup["rules"]): RuleGroup[] {
  return [{ id: "g", condition: "AND", rules, groups: [] }];
}

async function matchCount(rules: RuleGroup[]) {
  const items = await evaluateRules(rules, "MOVIE", [serverId]);
  return items.length;
}

describe("Rule engine — match-all safety (E2E against real Postgres)", () => {
  it("baseline: a valid rule that should match items actually does", async () => {
    expect(await matchCount(group([
      { id: "r", field: "studio", operator: "equals", value: "Warner Bros", condition: "AND" },
    ]))).toBeGreaterThan(0);
  });

  it("baseline: the library has the seeded items", async () => {
    // Substring rule against the shared title prefix matches all items.
    expect(await matchCount(group([
      { id: "r", field: "title", operator: "contains", value: "Movie", condition: "AND" },
    ]))).toBe(SEED_COUNT);
  });

  it("title isNotNull matches all items (regression: non-nullable text fields)", async () => {
    // `title` is `String` (not `String?`) in the schema. The old generic
    // text WHERE builder emitted `{ title: { not: null } }`, which Prisma 7
    // rejects with "Argument `not` is missing" for non-nullable columns.
    // Fix: detect non-nullable text fields and use the empty-string inverse.
    expect(await matchCount(group([
      { id: "r", field: "title", operator: "isNotNull", value: "", condition: "AND" },
    ]))).toBe(SEED_COUNT);
  });

  it("title isNull matches 0 items (none of the seeded titles are empty)", async () => {
    expect(await matchCount(group([
      { id: "r", field: "title", operator: "isNull", value: "", condition: "AND" },
    ]))).toBe(0);
  });

  describe("contains / notContains with empty / whitespace-only values", () => {
    const operators = ["contains", "notContains"] as const;
    const emptyValues = ["", "|", "||", "  ", "  |  "];
    const fields = ["studio", "title", "genre", "labels"];

    for (const operator of operators) {
      for (const value of emptyValues) {
        for (const field of fields) {
          for (const negate of [false, true]) {
            it(`${field} ${operator} ${JSON.stringify(value)}${negate ? " + negate" : ""} matches 0`, async () => {
              expect(await matchCount(group([
                { id: "r", field, operator, value, negate, condition: "AND" },
              ]))).toBe(0);
            });
          }
        }
      }
    }
  });

  describe("wildcard with empty pattern", () => {
    for (const operator of ["matchesWildcard", "notMatchesWildcard"] as const) {
      for (const negate of [false, true]) {
        it(`title ${operator} ""${negate ? " + negate" : ""} matches 0`, async () => {
          expect(await matchCount(group([
            { id: "r", field: "title", operator, value: "", negate, condition: "AND" },
          ]))).toBe(0);
        });
      }
    }
  });

  describe("unknown operator", () => {
    for (const negate of [false, true]) {
      it(`title totallyMadeUpOp value${negate ? " + negate" : ""} matches 0`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "title", operator: "totallyMadeUpOp" as never, value: "x", negate, condition: "AND" },
        ]))).toBe(0);
      });
    }
  });

  describe("operator / field-type mismatch", () => {
    for (const negate of [false, true]) {
      it(`playCount contains "5"${negate ? " + negate" : ""} matches 0`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "playCount", operator: "contains", value: "5", negate, condition: "AND" },
        ]))).toBe(0);
      });

      it(`title greaterThan "x"${negate ? " + negate" : ""} matches 0`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "title", operator: "greaterThan", value: "x", negate, condition: "AND" },
        ]))).toBe(0);
      });
    }
  });

  describe("malformed numeric / date values (NaN comparisons)", () => {
    for (const negate of [false, true]) {
      it(`playCount greaterThan "abc"${negate ? " + negate" : ""} matches 0`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "playCount", operator: "greaterThan", value: "abc", negate, condition: "AND" },
        ]))).toBe(0);
      });

      it(`year between "2000,"${negate ? " + negate" : ""} matches 0 (malformed half)`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "year", operator: "between", value: "2000,", negate, condition: "AND" },
        ]))).toBe(0);
      });

      it(`year between "2000"${negate ? " + negate" : ""} matches 0 (missing comma)`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "year", operator: "between", value: "2000", negate, condition: "AND" },
        ]))).toBe(0);
      });

      it(`playCount equals ""${negate ? " + negate" : ""} matches 0 (Number('') === 0 quirk)`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "playCount", operator: "equals", value: "", negate, condition: "AND" },
        ]))).toBe(0);
      });
    }
  });

  describe("unknown field name", () => {
    for (const negate of [false, true]) {
      it(`unknown field${negate ? " + negate" : ""} matches 0`, async () => {
        expect(await matchCount(group([
          { id: "r", field: "thisFieldDoesNotExist" as never, operator: "equals", value: "x", negate, condition: "AND" },
        ]))).toBe(0);
      });
    }
  });

  describe("group composition with unsatisfiable rules", () => {
    it("AND group with unconfigured rule fails the whole group (returns 0)", async () => {
      expect(await matchCount(group([
        // The first rule alone matches everything
        { id: "r1", field: "title", operator: "isNotNull", value: "", condition: "AND" },
        // The second rule is unconfigured — AND collapses to 0
        { id: "r2", field: "studio", operator: "notContains", value: "", condition: "AND" },
      ]))).toBe(0);
    });

    it("OR group with unconfigured rule defers to the configured side", async () => {
      const matched = await matchCount([{
        id: "g", condition: "AND",
        rules: [
          { id: "r1", field: "studio", operator: "equals", value: "Disney", condition: "AND" },
          // OR with an unconfigured rule should NOT lift to match-all
          { id: "r2", field: "title", operator: "contains", value: "", condition: "OR" },
        ],
        groups: [],
      }]);
      // SEED_COUNT items, half are Disney
      expect(matched).toBe(SEED_COUNT / 2);
    });
  });

  describe("legitimate enumerable multi-select (the original bug)", () => {
    it("genre contains 'Action|Comedy' matches items with either genre (the multi-select fix)", async () => {
      expect(await matchCount(group([
        { id: "r", field: "genre", operator: "contains", value: "Action|Comedy", condition: "AND" },
      ]))).toBe(SEED_COUNT);
    });

    it("studio contains 'Warner Bros' (single, enumerable) is exact match, not substring", async () => {
      // The original bug: "Warner" would have matched "Warner Bros" via substring.
      // The fix: only exact matches against the selected value.
      expect(await matchCount(group([
        { id: "r", field: "studio", operator: "contains", value: "Warner", condition: "AND" },
      ]))).toBe(0);

      expect(await matchCount(group([
        { id: "r", field: "studio", operator: "contains", value: "Warner Bros", condition: "AND" },
      ]))).toBe(SEED_COUNT / 2);
    });

    it("title contains 'Movie' (non-enumerable, free text) DOES substring-match", async () => {
      // The fix only changed semantics for enumerable fields. Free-text fields
      // like title still do substring matching as before.
      expect(await matchCount(group([
        { id: "r", field: "title", operator: "contains", value: "Movie", condition: "AND" },
      ]))).toBe(SEED_COUNT);
    });
  });
});
