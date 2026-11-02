/**
 * An incremental detection run re-snapshots a held match whose identity
 * changed — here a re-title — through one UPDATE … FROM per slice of matches,
 * against the real database: the stored snapshot must read exactly as the
 * one a fresh match is written with (a BigInt as a string), and a row the
 * run no longer finds is simply not written.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import {
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  createTestRuleSet,
} from "../../setup/test-helpers";
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

import { detectAndSaveMatches } from "@/lib/lifecycle/detect-matches";

const rules: LifecycleRuleGroup[] = [
  {
    id: "g", condition: "AND", groups: [],
    rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND" }],
  },
];

describe("held match refresh", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  it("rewrites a re-titled match's snapshot in place, as a fresh match would be written", async () => {
    const prisma = getTestPrisma();
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });
    const heat = await createTestMediaItem(library.id, { type: "MOVIE", title: "Heat", playCount: 0 });
    const other = await createTestMediaItem(library.id, { type: "MOVIE", title: "Ronin", playCount: 0 });
    await prisma.mediaItem.update({ where: { id: heat.id }, data: { fileSize: BigInt("12345678901") } });

    const ruleSet = await createTestRuleSet(user.id, { type: "MOVIE", rules, serverIds: [server.id] });
    const cfg = { ...ruleSet, type: "MOVIE", rules, serverIds: [server.id] } as never;

    await detectAndSaveMatches(cfg, [server.id]);
    const before = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id }, orderBy: { mediaItemId: "asc" } });
    expect(before).toHaveLength(2);

    await prisma.mediaItem.update({ where: { id: heat.id }, data: { title: "Heat (Director's Cut)" } });
    await detectAndSaveMatches(cfg, [server.id]);

    const after = await prisma.ruleMatch.findMany({ where: { ruleSetId: ruleSet.id } });
    const heatMatch = after.find((m) => m.mediaItemId === heat.id)!;
    const data = heatMatch.itemData as Record<string, unknown>;
    expect(data.title).toBe("Heat (Director's Cut)");
    expect(data.fileSize).toBe("12345678901");
    expect(heatMatch.copyIds).toEqual([]);
    // The same row, not a new one.
    expect(heatMatch.id).toBe(before.find((m) => m.mediaItemId === heat.id)!.id);
    // The unchanged match was not rewritten.
    const ronin = after.find((m) => m.mediaItemId === other.id)!;
    expect(ronin.itemData).toEqual(before.find((m) => m.mediaItemId === other.id)!.itemData);
  });
});
