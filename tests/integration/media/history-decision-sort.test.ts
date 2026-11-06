import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";
import { streamDecision } from "@/lib/media/stream-decision";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return {
    // A constructor mock needs `function`: Vitest 4 cannot `new` an arrow.
    MemoryCache: vi.fn(function () {
      return noopCache;
    }),
    appCache: noopCache,
  };
});

import { GET } from "@/app/api/media/history/route";

type Row = {
  id: string;
  isTranscode: boolean | null;
  videoDecision: string | null;
  audioDecision: string | null;
};
type HistoryResponse = { items: Row[]; pagination: { hasMore: boolean } };

/** The rank the Decision column sorts by: the chip's verdict, unknown last. */
const RANK: Record<string, number> = { transcode: 2, "direct-stream": 1, "direct-play": 0 };

describe("GET /api/media/history — the Decision column sorts by the chip's verdict", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    const user = await createTestUser();
    setMockSession({ userId: user.id, isLoggedIn: true });
    const server = await createTestServer(user.id);
    const library = await createTestLibrary(server.id, { type: "MOVIE" });

    const plays: Array<Record<string, unknown>> = [
      // An audio-only transcode: the flag says no, the audio decision says yes.
      // Sorted on `isTranscode` it landed among the direct plays.
      { isTranscode: false, videoDecision: "copy", audioDecision: "transcode" },
      { isTranscode: true, videoDecision: "transcode", audioDecision: "copy" },
      { isTranscode: false, videoDecision: "copy", audioDecision: "copy" },
      { isTranscode: false, videoDecision: "directplay", audioDecision: "directplay" },
      { isTranscode: false, videoDecision: null, audioDecision: null },
      // No flag, only a decision: the decision decides, as it does for the chip.
      { isTranscode: null, videoDecision: "transcode", audioDecision: null },
      { isTranscode: null, videoDecision: null, audioDecision: "copy" },
      // Empty decisions are absent ones: nothing known, no chip.
      { isTranscode: null, videoDecision: "", audioDecision: "" },
      // A native row: nothing known, no chip.
      {},
    ];
    for (const [i, play] of plays.entries()) {
      const item = await createTestMediaItem(library.id, { title: `Film ${i}` });
      await getTestPrisma().watchHistory.create({
        data: {
          mediaItemId: item.id,
          mediaServerId: server.id,
          serverUsername: "ann",
          watchedAt: new Date(Date.UTC(2024, 0, 1 + i)),
          ...(Object.keys(play).length > 0 ? { source: "TRACEARR", sourceEventId: `evt-${i}` } : {}),
          ...play,
        },
      });
    }
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function ranks(sortOrder: "asc" | "desc") {
    const data = await expectJson<HistoryResponse>(
      await callRoute(GET, {
        url: "/api/media/history",
        searchParams: { page: "1", limit: "50", sortBy: "decision", sortOrder },
      }),
    );
    return data.items.map((row) => {
      const kind = streamDecision(row)?.kind;
      return kind === undefined ? null : RANK[kind];
    });
  }

  it("puts every transcode first, then remuxes, then direct plays, unknown last", async () => {
    expect(await ranks("desc")).toEqual([2, 2, 2, 1, 1, 0, 0, null, null]);
  });

  it("reverses the known decisions ascending, unknown still last", async () => {
    expect(await ranks("asc")).toEqual([0, 0, 1, 1, 2, 2, 2, null, null]);
  });
});
