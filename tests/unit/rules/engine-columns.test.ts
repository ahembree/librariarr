/**
 * The lifecycle engines load every candidate row of a library; the columns no
 * rule, aggregation or detection step reads are left out of each load.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockFindMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ prisma: { mediaItem: { findMany: mockFindMany } } }));

import {
  UNREAD_ITEM_COLUMNS,
  evaluateLifecycleRules,
  evaluateMusicScope,
  evaluateSeriesScope,
} from "@/lib/rules/lifecycle-engine";
import { CONDITION_FIELDS } from "@/lib/conditions";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

const rules: LifecycleRuleGroup[] = [
  {
    id: "g", condition: "AND", groups: [],
    rules: [{ id: "r", field: "playCount", operator: "equals", value: "0", condition: "AND" }],
  },
];

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
});

describe("engine column loads", () => {
  it("omits the unread columns from the flat, series and artist loads", async () => {
    await evaluateLifecycleRules(rules, "MOVIE", ["s1"]);
    await evaluateSeriesScope(rules, ["s1"]);
    await evaluateMusicScope(rules, ["s1"]);

    expect(mockFindMany).toHaveBeenCalledTimes(3);
    for (const [args] of mockFindMany.mock.calls) {
      expect(args.omit).toEqual(UNREAD_ITEM_COLUMNS);
    }
  });

  it("never omits a column a rule can read", () => {
    const fields = new Set(CONDITION_FIELDS.map((f) => f.value));
    for (const column of Object.keys(UNREAD_ITEM_COLUMNS)) {
      expect(fields.has(column)).toBe(false);
    }
  });
});
