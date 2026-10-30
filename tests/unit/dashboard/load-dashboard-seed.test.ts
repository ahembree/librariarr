import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every read is a route handler; each is stubbed so a test decides how it answers.
const handlers = vi.hoisted(() => {
  const make = () => vi.fn();
  return {
    stats: make(),
    sparklines: make(),
    recentlyAdded: make(),
    summary: make(),
    schedule: make(),
    syncStatus: make(),
    servers: make(),
  };
});
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));

vi.mock("@/lib/logger", () => ({ apiLogger: logger, logger, dbLogger: logger }));
vi.mock("@/app/api/media/stats/route", () => ({ GET: handlers.stats }));
vi.mock("@/app/api/media/stats/sparklines/route", () => ({ GET: handlers.sparklines }));
vi.mock("@/app/api/media/recently-added/route", () => ({ GET: handlers.recentlyAdded }));
vi.mock("@/app/api/lifecycle/summary/route", () => ({ GET: handlers.summary }));
vi.mock("@/app/api/settings/schedule-info/route", () => ({ GET: handlers.schedule }));
vi.mock("@/app/api/sync/status/route", () => ({ GET: handlers.syncStatus }));
vi.mock("@/app/api/servers/route", () => ({ GET: handlers.servers }));

import { DASHBOARD_SEED_BUDGET_MS, loadDashboardSeed, serverClock } from "@/lib/dashboard/load-dashboard-seed";

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockReset().mockImplementation(() => json({ ok: true }));
  logger.warn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadDashboardSeed", () => {
  it("answers every read under the URL the dashboard asks it by", async () => {
    handlers.stats.mockImplementation(() => json({ movieCount: 3 }));
    const seed = await loadDashboardSeed(["MOVIE", "MUSIC"]);
    expect(Object.keys(seed.bodies).sort()).toEqual([
      "/api/lifecycle/summary",
      "/api/media/recently-added?limit=24",
      "/api/media/stats",
      "/api/media/stats/sparklines?types=MOVIE%2CMUSIC",
      "/api/servers?fields=basic",
      "/api/settings/schedule-info",
      "/api/sync/status",
    ]);
    expect(seed.bodies["/api/media/stats"]).toEqual({ movieCount: 3 });
  });

  it("hands each handler a request for its own URL", async () => {
    await loadDashboardSeed([]);
    const url = (handler: typeof handlers.stats) => new URL((handler.mock.calls[0][0] as Request).url);
    expect(url(handlers.sparklines).searchParams.get("types")).toBe("MOVIE,SERIES,MUSIC");
    expect(url(handlers.recentlyAdded).searchParams.get("limit")).toBe("24");
    expect(url(handlers.servers).searchParams.get("fields")).toBe("basic");
  });

  it("leaves out a read that answered an error or threw, for the browser to fetch", async () => {
    handlers.summary.mockImplementation(() => json({ error: "Internal server error" }, 500));
    handlers.schedule.mockImplementation(() => Promise.reject(new Error("db down")));
    const seed = await loadDashboardSeed([]);
    expect(seed.bodies).not.toHaveProperty("/api/lifecycle/summary");
    expect(seed.bodies).not.toHaveProperty("/api/settings/schedule-info");
    expect(seed.bodies).toHaveProperty("/api/media/stats");
    expect(logger.warn).toHaveBeenCalledWith(
      "Dashboard",
      expect.stringContaining("/api/settings/schedule-info"),
      { error: "db down" },
    );
  });

  it("does not wait past its budget for a slow read", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    handlers.stats.mockImplementation(() => new Promise(() => {}));
    const pending = loadDashboardSeed([]);
    await vi.advanceTimersByTimeAsync(DASHBOARD_SEED_BUDGET_MS);
    const seed = await pending;
    expect(seed.bodies).not.toHaveProperty("/api/media/stats");
    expect(seed.bodies).toHaveProperty("/api/sync/status");
    // The time the reads started, which the page compares events with.
    expect(seed.at).toBe(1_000_000);
  });
});

describe("serverClock", () => {
  it("records the render time with the server's hour and date", () => {
    const now = new Date(2026, 2, 10, 15, 30);
    expect(serverClock(now)).toEqual({
      at: now.getTime(),
      hour: 15,
      weekday: now.toLocaleDateString(undefined, { weekday: "long" }),
      monthDay: now.toLocaleDateString(undefined, { month: "long", day: "numeric" }),
    });
  });
});
