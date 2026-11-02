/**
 * The history listing of GET /api/lifecycle/actions (COMPLETED / FAILED / ALL)
 * picks the latest action per (rule set, item) in SQL and reads only those
 * rows. The SQL itself runs in tests/integration/lifecycle/actions*.test.ts;
 * this pins what the route asks for and how it uses the answer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const mockPrisma = vi.hoisted(() => ({
  lifecycleAction: { findMany: vi.fn(), update: vi.fn() },
  ruleSet: { findMany: vi.fn() },
  library: { findMany: vi.fn() },
  mediaItem: { findMany: vi.fn() },
  $queryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(async () => ({ isLoggedIn: true, userId: "u1" })),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/lifecycle/actions/route";

const list = (status: string) => GET(new NextRequest(`http://localhost/api/lifecycle/actions?status=${status}`));

function action(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u1",
    mediaItemId: null,
    mediaItem: null,
    ruleSetId: "rs1",
    ruleSetName: "Rule",
    ruleSetType: "MOVIE",
    actionType: "UNMONITOR_RADARR",
    status: "COMPLETED",
    scheduledFor: new Date("2025-01-01T00:00:00Z"),
    executedAt: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    error: null,
    addImportExclusion: false,
    addArrTags: [],
    removeArrTags: [],
    targetQualityProfileId: null,
    matchedMediaItemIds: [],
    mediaItemTitle: `Title ${id}`,
    mediaItemParentTitle: null,
    deletedBytes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.ruleSet.findMany.mockResolvedValue([
    {
      id: "rs1", name: "Rule", type: "MOVIE", actionType: "UNMONITOR_RADARR", actionDelayDays: 0,
      addImportExclusion: false, searchAfterAction: false, addArrTags: [], removeArrTags: [],
      arrInstanceId: null, targetQualityProfileId: null,
    },
  ]);
  mockPrisma.library.findMany.mockResolvedValue([]);
});

describe("GET /api/lifecycle/actions — history", () => {
  it("asks SQL for the latest action of each pair, filtered by status, then reads only those", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: "a2" }, { id: "a1" }]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      action("a2", { scheduledFor: new Date("2025-02-01T00:00:00Z") }),
      action("a1"),
    ]);

    const body = (await (await list("FAILED")).json()) as { groups: Array<{ items: Array<{ id: string }> }> };

    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("DISTINCT ON");
    expect(sql).toContain(`'deleted:' || COALESCE("ruleSetName", 'unknown')`);
    expect(sql).toContain(`COALESCE("mediaItemId", id)`);
    expect(sql).toContain(`status = $2::"LifecycleActionStatus"`);
    expect(params).toEqual(["u1", "FAILED"]);

    expect(mockPrisma.lifecycleAction.findMany).toHaveBeenCalledTimes(1);
    const args = mockPrisma.lifecycleAction.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ id: { in: ["a2", "a1"] } });
    expect(args.orderBy).toEqual([{ scheduledFor: "desc" }, { id: "asc" }]);
    expect(body.groups[0].items.map((i) => i.id)).toEqual(["a2", "a1"]);
  });

  it("does not filter by status for ALL", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    const body = await (await list("ALL")).json();

    const [sql, ...params] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).not.toContain("status =");
    expect(params).toEqual(["u1"]);
    // Nothing to read.
    expect(mockPrisma.lifecycleAction.findMany).not.toHaveBeenCalled();
    expect(body).toEqual({ groups: [] });
  });

  it("backfills the title snapshot of a listed action that has none", async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: "a1" }]);
    mockPrisma.lifecycleAction.findMany.mockResolvedValue([
      action("a1", {
        mediaItemId: "m1",
        mediaItemTitle: null,
        mediaItem: {
          id: "m1", title: "Heat", parentTitle: null, type: "MOVIE", thumbUrl: null, seasonNumber: null,
          episodeNumber: null, year: 1995, summary: null, parentSummary: null, contentRating: null, rating: null,
          ratingImage: null, audienceRating: null, audienceRatingImage: null, duration: null, resolution: null,
          dynamicRange: null, audioProfile: null, audioCodec: null, fileSize: null, genres: null, studio: null,
          playCount: 0, lastPlayedAt: null, addedAt: null, libraryId: "lib1",
        },
      }),
    ]);
    mockPrisma.lifecycleAction.update.mockResolvedValue({});

    await list("COMPLETED");

    expect(mockPrisma.lifecycleAction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "a1" }, data: expect.objectContaining({ mediaItemTitle: "Heat" }) }),
    );
  });
});
