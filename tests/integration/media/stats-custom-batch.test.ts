import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { NextRequest } from "next/server";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Each card's own route is called directly as well; the cache would answer
// the second read from the first, which is not what the comparison is for.
vi.mock("@/lib/cache/memory-cache", () => {
  const noopCache = {
    get: () => undefined,
    set: () => {},
    getOrSet: async (_k: string, compute: () => Promise<unknown>) => compute(),
    invalidate: () => {},
    invalidatePrefix: () => {},
    clear: () => {},
  };
  return { MemoryCache: vi.fn(function () { return noopCache; }), appCache: noopCache };
});

import { POST } from "@/app/api/media/stats/custom-batch/route";
import { GET as timelineGet } from "@/app/api/media/stats/timeline/route";
import { GET as crossTabGet } from "@/app/api/media/stats/cross-tab/route";
import { GET as customGet } from "@/app/api/media/stats/custom/route";
import { MAX_CUSTOM_STATS_BATCH } from "@/lib/validation";

type Answer = { status: number; body: unknown };
const batch = (cards: unknown) =>
  callRoute(POST, { url: "/api/media/stats/custom-batch", method: "POST", body: { cards } });

describe("POST /api/media/stats/custom-batch", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  async function library() {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const lib = await createTestLibrary(server.id, { type: "MOVIE" });
    await createTestMediaItem(lib.id, { type: "MOVIE", resolution: "1080", videoCodec: "h264", addedAt: new Date("2024-01-05") });
    await createTestMediaItem(lib.id, { type: "MOVIE", resolution: "2160", videoCodec: "hevc", addedAt: new Date("2024-02-05") });
    await createTestMediaItem(lib.id, { type: "MOVIE", resolution: "2160", videoCodec: "hevc", addedAt: new Date("2024-02-09") });
    setMockSession({ userId: user.id, isLoggedIn: true });
    return { server };
  }

  it("returns 401 without a session", async () => {
    await expectJson(await batch([{ kind: "custom", dimension: "resolution" }]), 401);
  });

  it("answers each card exactly as its own route does, in the order sent", async () => {
    const { server } = await library();
    const { cards } = await expectJson<{ cards: Answer[] }>(
      await batch([
        { kind: "custom", dimension: "videoCodec" },
        { kind: "timeline", dateField: "addedAt", bin: "month", breakdown: "resolution", topN: 5, serverId: server.id },
        { kind: "crossTab", dimension1: "resolution", dimension2: "videoCodec" },
        { kind: "timeline", dateField: "addedAt", topN: null },
      ]),
      200,
    );

    const direct = async (handler: (request: NextRequest) => Promise<Response>, url: string) => {
      const res = await callRoute(handler, { url });
      return { status: res.status, body: await res.json() };
    };
    expect(cards).toEqual([
      await direct(customGet, "/api/media/stats/custom?dimension=videoCodec"),
      await direct(
        timelineGet,
        `/api/media/stats/timeline?dateField=addedAt&bin=month&breakdown=resolution&topN=5&serverId=${server.id}`,
      ),
      await direct(crossTabGet, "/api/media/stats/cross-tab?dimension1=resolution&dimension2=videoCodec"),
      await direct(timelineGet, "/api/media/stats/timeline?dateField=addedAt"),
    ]);
    expect(cards.every((card) => card.status === 200)).toBe(true);
  });

  it("answers a card its route refuses with that route's error, beside the others", async () => {
    await library();
    const { cards } = await expectJson<{ cards: Answer[] }>(
      await batch([
        { kind: "custom", dimension: "notADimension" },
        { kind: "crossTab", dimension1: "audioLanguage", dimension2: "subtitleLanguage" },
        { kind: "timeline", dateField: "createdAt" },
        { kind: "custom", dimension: "resolution" },
        { kind: "custom", dimension: "resolution", serverId: "no-such-server" },
      ]),
      200,
    );
    expect(cards.map((c) => c.status)).toEqual([400, 400, 400, 200, 404]);
    expect(cards[0].body).toEqual({ error: "Invalid dimension" });
    expect(cards[1].body).toEqual({ error: "Cannot cross two stream dimensions" });
    expect(cards[2].body).toEqual({ error: "Invalid or missing dateField" });
  });

  it("refuses an empty list, too many cards, and a card of no known kind", async () => {
    await library();
    await expectJson(await batch([]), 400);
    await expectJson(
      await batch(Array.from({ length: MAX_CUSTOM_STATS_BATCH + 1 }, () => ({ kind: "custom", dimension: "resolution" }))),
      400,
    );
    await expectJson(await batch([{ kind: "pie", dimension: "resolution" }]), 400);
    await expectJson(await batch([{ kind: "custom" }]), 400);
  });
});
