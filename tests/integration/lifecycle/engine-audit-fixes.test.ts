/**
 * Regression tests for the fail-open and phase-divergence bugs found in the
 * deep engine audit. Each asserts BOTH phases agree on the corrected
 * behavior against a real test database.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { cleanDatabase, getTestPrisma } from "../../setup/test-db";
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

const { evaluateLifecycleRules, getMatchedCriteriaForItems } = await import(
  "@/lib/rules/lifecycle-engine"
);

let serverId: string;
let total: number;
let withTmdbId: string;
let withImdbId: string;
let withNoIds: string;

beforeAll(async () => {
  await cleanDatabase();
  const prisma = getTestPrisma();
  const user = await prisma.user.create({ data: { username: "audit-fixes", passwordHash: "x" } });
  const server = await prisma.mediaServer.create({
    data: { userId: user.id, name: "S", type: "PLEX", url: "http://s:32400", accessToken: "x", machineId: "audit-fixes" },
  });
  serverId = server.id;
  const lib = await prisma.library.create({
    data: { mediaServerId: server.id, key: "l", title: "Movies", type: "MOVIE" },
  });
  const mk = async (ratingKey: string, title: string, sources: string[], title4k = false) => {
    const item = await prisma.mediaItem.create({
      data: { libraryId: lib.id, ratingKey, type: "MOVIE", title, resolution: title4k ? "4k" : "1080" },
    });
    for (const source of sources) {
      await prisma.mediaItemExternalId.create({ data: { mediaItemId: item.id, source, externalId: `${source}-1` } });
    }
    return item.id;
  };
  withTmdbId = await mk("a", "Has TMDB", ["TMDB"]);
  withImdbId = await mk("b", "Has IMDB", ["IMDB"]);
  withNoIds = await mk("c", "Has none", []);
  total = 3;
});

function lifecycleGroup(rule: Record<string, unknown>): LifecycleRuleGroup[] {
  return [{ id: "g", condition: "AND", rules: [{ id: "r", condition: "AND", ...rule } as never], groups: [] }];
}

describe("F1: hasExternalId contains/notContains no longer fails open", () => {
  it("contains matches only items having one of the listed sources (not the whole library)", async () => {
    const rules = lifecycleGroup({ field: "hasExternalId", operator: "contains", value: "TMDB|IMDB" });
    const ids = (await evaluateLifecycleRules(rules, "MOVIE", [serverId])).map((i: { id: string }) => i.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(withTmdbId);
    expect(ids).toContain(withImdbId);
    expect(ids).not.toContain(withNoIds);
    expect(ids.length).toBeLessThan(total + 1); // never the whole library
  });

  it("notContains excludes items having a listed source", async () => {
    const rules = lifecycleGroup({ field: "hasExternalId", operator: "notContains", value: "TMDB" });
    const ids = (await evaluateLifecycleRules(rules, "MOVIE", [serverId])).map((i: { id: string }) => i.id);
    expect(ids).toContain(withImdbId);
    expect(ids).toContain(withNoIds);
    expect(ids).not.toContain(withTmdbId);
  });

  it("Phase 2 (matched criteria) agrees with the same source-membership semantics", async () => {
    const rules = lifecycleGroup({ field: "hasExternalId", operator: "contains", value: "TMDB" });
    const items = await getTestPrisma().mediaItem.findMany({
      where: { library: { mediaServerId: serverId } },
      include: { externalIds: true },
    });
    const map = getMatchedCriteriaForItems(items as never, rules, "MOVIE");
    expect(map.get(withTmdbId)!.length).toBeGreaterThan(0);
    expect(map.get(withImdbId) ?? []).toHaveLength(0);
    expect(map.get(withNoIds) ?? []).toHaveLength(0);
  });
});

describe("F2: isWatchlisted isNull/isNotNull tautology is phase-consistent", () => {
  it("isNotNull matches all (non-nullable boolean tautology), in both phases", async () => {
    const rules = lifecycleGroup({ field: "isWatchlisted", operator: "isNotNull", value: "" });
    const engine = await evaluateLifecycleRules(rules, "MOVIE", [serverId]);
    expect(engine).toHaveLength(total);
    const items = await getTestPrisma().mediaItem.findMany({ where: { library: { mediaServerId: serverId } } });
    const map = getMatchedCriteriaForItems(items as never, rules, "MOVIE");
    // Phase 2 must also treat every item as matched (was: default false → 0)
    expect([...map.values()].filter((c) => c.length > 0)).toHaveLength(total);
  });

  it("isNull matches nothing, in both phases", async () => {
    const rules = lifecycleGroup({ field: "isWatchlisted", operator: "isNull", value: "" });
    expect(await evaluateLifecycleRules(rules, "MOVIE", [serverId])).toHaveLength(0);
  });
});
