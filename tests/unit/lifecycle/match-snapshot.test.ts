import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({ $queryRawUnsafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import { loadStoredMatches, loadStoredMatchMembers } from "@/lib/lifecycle/match-snapshot";

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
});

describe("loadStoredMatches", () => {
  it("asks for nothing without a rule set", async () => {
    expect(await loadStoredMatches([], ["id"])).toEqual([]);
    expect(await loadStoredMatchMembers([])).toEqual([]);
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("projects the asked-for keys of each snapshot in SQL", async () => {
    const rows = [{ ruleSetId: "rs1", mediaItemId: "m1", itemData: { id: "m1", title: "Heat" } }];
    mockPrisma.$queryRawUnsafe.mockResolvedValue(rows);

    expect(await loadStoredMatches(["rs1", "rs2"], ["id", "title"])).toBe(rows);

    const [sql, ruleSetIds, keys] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`jsonb_each("itemData")`);
    expect(sql).toContain(`e.key = ANY($2::text[])`);
    // A snapshot that is not an object is passed through rather than failing the read.
    expect(sql).toContain(`jsonb_typeof("itemData") = 'object'`);
    expect(sql).toContain(`"ruleSetId" = ANY($1::text[])`);
    expect(ruleSetIds).toEqual(["rs1", "rs2"]);
    expect(keys).toEqual(["id", "title"]);
  });

  it("reads the whole snapshot when no keys are given", async () => {
    await loadStoredMatches(["rs1"], null);
    const [sql, ruleSetIds] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain("jsonb_each");
    expect(sql).toContain(`"itemData"`);
    expect(ruleSetIds).toEqual(["rs1"]);
  });
});

describe("loadStoredMatchMembers", () => {
  it("reads only memberIds out of each snapshot", async () => {
    await loadStoredMatchMembers(["rs1"]);
    const [sql, ruleSetIds] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`"itemData"->'memberIds' AS "memberIds"`);
    expect(ruleSetIds).toEqual(["rs1"]);
  });
});
