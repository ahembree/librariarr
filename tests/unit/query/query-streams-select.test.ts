/**
 * The query engine loads an item's streams only for a query whose rules read
 * them (stream fields, stream queries) — not for every query evaluated in
 * memory. The evaluation itself is covered against the database by
 * tests/integration/query/*.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  mediaItem: { findMany: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/dedup/server-filter", () => ({
  resolveServerFilter: vi.fn(async () => ({ serverIds: ["s1"], isSingleServer: true })),
}));

import { executeQuery } from "@/lib/query/query-engine";
import type { QueryDefinition, QueryGroup } from "@/lib/query/types";

function definition(groups: QueryGroup[]): QueryDefinition {
  return {
    mediaTypes: ["MOVIE"],
    serverIds: [],
    groups,
    sortBy: "title",
    sortOrder: "asc",
  } as unknown as QueryDefinition;
}

const group = (field: string, operator: string, value: string): QueryGroup[] => [
  { id: "g", condition: "AND", groups: [], rules: [{ id: "r", field, operator, value, condition: "AND" }] },
] as unknown as QueryGroup[];

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.mediaItem.findMany.mockResolvedValue([]);
});

const selectUsed = () => mockPrisma.mediaItem.findMany.mock.calls[0][0].select as Record<string, unknown>;

describe("query engine streams", () => {
  it("does not load streams for a query evaluated in memory on columns alone", async () => {
    // A wildcard rule forces in-memory evaluation, and reads only the title.
    await executeQuery(definition(group("title", "matchesWildcard", "The *")), "u1", 1, 50);

    expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(1);
    expect(selectUsed()).toHaveProperty("externalIds");
    expect(selectUsed()).not.toHaveProperty("streams");
  });

  it("loads streams for a stream-field rule", async () => {
    await executeQuery(definition(group("audioStreamCount", "greaterThan", "1")), "u1", 1, 50);

    expect(selectUsed()).toHaveProperty("streams");
  });

  it("loads streams for a stream query group", async () => {
    const groups = [
      {
        id: "g", condition: "AND", rules: [],
        groups: [
          {
            id: "sq", condition: "AND", groups: [], streamQuery: { streamType: "audio", quantifier: "any" },
            rules: [{ id: "r", field: "sqCodec", operator: "matchesWildcard", value: "a*", condition: "AND" }],
          },
        ],
      },
    ] as unknown as QueryGroup[];
    await executeQuery(definition(groups), "u1", 1, 50);

    expect(selectUsed()).toHaveProperty("streams");
  });
});
