import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  executeAction: vi.fn(),
  prisma: {
    lifecycleAction: { create: vi.fn(), deleteMany: vi.fn() },
    ruleMatch: { deleteMany: vi.fn() },
    mediaItem: { aggregate: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: m.prisma }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/lifecycle/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lifecycle/actions")>()),
  executeAction: m.executeAction,
}));

import { executeActionsForItems } from "@/lib/lifecycle/run-actions";
import { IntegrationError } from "@/lib/integration-error";

const CONFIG = {
  actionType: "UNMONITOR_RADARR",
  arrInstanceId: "radarr-1",
  targetQualityProfileId: null,
  addImportExclusion: false,
  searchAfterAction: false,
  addArrTags: [],
  removeArrTags: [],
};
const HISTORY = { ruleSetId: null, ruleSetName: "Query", ruleSetType: "MOVIE" };

const item = (n: number) => ({
  id: `m${n}`,
  title: `Movie ${n}`,
  parentTitle: null,
  year: 2020,
  fileSize: null,
  libraryId: "lib",
  externalIds: [],
});

function hostDown(status: number | null) {
  return new IntegrationError("Radarr", {
    config: { url: "/api/v3/movie" },
    code: status === null ? "ECONNABORTED" : "ERR_BAD_RESPONSE",
    response: status === null ? undefined : { status, data: {} },
  } as never);
}

describe("executeActionsForItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.prisma.$transaction.mockResolvedValue([]);
    m.prisma.lifecycleAction.create.mockResolvedValue({});
  });

  it("fails the remaining items at once when the Arr instance is down, without asking it again", async () => {
    // Each attempt against a dead instance costs the client's whole retry budget.
    m.executeAction.mockRejectedValue(hostDown(null));

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY);

    expect(m.executeAction).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(3);
    expect(result.executed).toBe(0);
    // Every item still gets its FAILED history row, carrying the host error.
    expect(m.prisma.lifecycleAction.create).toHaveBeenCalledTimes(3);
    for (const f of result.failures) expect(f.error).toMatch(/Radarr unreachable/);
  });

  it("keeps going after an item-specific failure", async () => {
    m.executeAction
      .mockRejectedValueOnce(hostDown(404))
      .mockResolvedValue(undefined);

    const result = await executeActionsForItems("u1", [item(1), item(2), item(3)], CONFIG, new Map(), HISTORY);

    expect(m.executeAction).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ executed: 2, failed: 1 });
  });
});
