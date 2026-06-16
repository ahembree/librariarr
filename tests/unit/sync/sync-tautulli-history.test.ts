import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockPrisma, getHistory, getStreamData } = vi.hoisted(() => ({
  mockPrisma: {
    tautulliInstance: { findFirst: vi.fn() },
    watchHistory: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    mediaItemExternalId: { findFirst: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
  getHistory: vi.fn(),
  getStreamData: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/tautulli/client", () => ({
  // Constructor mock must be a function() per Vitest 4.
  TautulliClient: function () {
    return { getHistory, getStreamData };
  },
}));

import { syncTautulliHistory } from "@/lib/sync/sync-tautulli-history";

const INSTANCE = {
  id: "t1",
  name: "Tautulli",
  url: "http://tautulli:8181",
  apiKey: "key",
  mediaServerId: "server-1",
  enabled: true,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    rowId: "r1",
    referenceId: "ref1",
    ratingKey: "100",
    grandparentRatingKey: null,
    guid: null,
    user: "Admin",
    mediaType: "movie",
    watchedAt: new Date("2024-01-01T00:00:00Z"),
    startedAt: new Date("2024-01-01T00:00:00Z"),
    stoppedAt: new Date("2024-01-01T00:00:30Z"),
    playDurationSec: 100,
    pausedCounter: 0,
    percentComplete: 95,
    ipAddress: "1.2.3.4",
    location: "wan",
    platform: "Windows",
    player: "PC",
    product: "Plex",
    transcodeDecision: "direct play",
    videoDecision: "direct play",
    audioDecision: "direct play",
    ...overrides,
  };
}

/** Wire the two findMany calls in code order: existingTautulli, then nativeRows. */
function setupFindMany(existingTautulli: unknown[], nativeRows: unknown[]) {
  mockPrisma.watchHistory.findMany
    .mockResolvedValueOnce(existingTautulli)
    .mockResolvedValueOnce(nativeRows);
}

describe("syncTautulliHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.watchHistory.findFirst.mockResolvedValue(null); // no prior watermark
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: "item-1", ratingKey: "100" }]);
    mockPrisma.watchHistory.upsert.mockResolvedValue({ id: "new-row" });
    getStreamData.mockResolvedValue({});
  });

  it("no-ops when no enabled instance is linked", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(null);
    const res = await syncTautulliHistory("server-1");
    expect(res).toEqual({ count: 0 });
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("merges a correlated Tautulli row into the existing native Plex row", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    setupFindMany([], [
      { id: "wh-native", mediaItemId: "item-1", serverUsername: "Admin", watchedAt: new Date("2024-01-01T00:00:00Z") },
    ]);
    getHistory.mockResolvedValueOnce({ rows: [row()] });

    const res = await syncTautulliHistory("server-1");

    expect(res.count).toBe(1);
    expect(mockPrisma.watchHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "wh-native" },
        data: expect.objectContaining({ source: "PLEX+TAUTULLI", tautulliRowId: "r1" }),
      })
    );
    expect(mockPrisma.watchHistory.upsert).not.toHaveBeenCalled();
  });

  it("keeps an uncorrelated Tautulli row as its own TAUTULLI-source row", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    // Native row is for a different user → no correlation.
    setupFindMany([], [
      { id: "wh-other", mediaItemId: "item-1", serverUsername: "SomeoneElse", watchedAt: new Date("2024-01-01T00:00:00Z") },
    ]);
    getHistory.mockResolvedValueOnce({ rows: [row()] });

    const res = await syncTautulliHistory("server-1");

    expect(res.count).toBe(1);
    expect(mockPrisma.watchHistory.update).not.toHaveBeenCalled();
    expect(mockPrisma.watchHistory.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mediaServerId_tautulliRowId: { mediaServerId: "server-1", tautulliRowId: "r1" } },
        create: expect.objectContaining({ source: "TAUTULLI", tautulliRowId: "r1" }),
      })
    );
  });

  it("does not correlate when the stop time is outside the window", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    setupFindMany([], [
      // Native play 1 hour earlier — same item/user but outside the 5-min window.
      { id: "wh-native", mediaItemId: "item-1", serverUsername: "Admin", watchedAt: new Date("2023-12-31T23:00:00Z") },
    ]);
    getHistory.mockResolvedValueOnce({ rows: [row()] });

    await syncTautulliHistory("server-1");

    expect(mockPrisma.watchHistory.update).not.toHaveBeenCalled();
    expect(mockPrisma.watchHistory.upsert).toHaveBeenCalled();
  });

  it("is idempotent: re-syncing an existing row updates in place by id", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    setupFindMany([{ id: "wh-existing", tautulliRowId: "r1" }], []);
    getHistory.mockResolvedValueOnce({ rows: [row()] });

    const res = await syncTautulliHistory("server-1");

    expect(res.count).toBe(1);
    expect(mockPrisma.watchHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "wh-existing" } })
    );
    expect(mockPrisma.watchHistory.upsert).not.toHaveBeenCalled();
  });

  it("skips rows whose media item cannot be resolved", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // no media items
    setupFindMany([], []);
    // ratingKey misses AND the guid lookup finds nothing → truly unresolvable.
    mockPrisma.mediaItemExternalId.findFirst.mockResolvedValueOnce(null);
    getHistory.mockResolvedValueOnce({ rows: [row({ ratingKey: "999", guid: "com.plexapp.agents.thetvdb://999999/1/1" })] });

    const res = await syncTautulliHistory("server-1");

    expect(res.count).toBe(0);
    expect(mockPrisma.watchHistory.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.watchHistory.update).not.toHaveBeenCalled();
  });

  it("fetches get_stream_data only for non-direct-play sessions", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    setupFindMany([], []);
    getHistory.mockResolvedValueOnce({
      rows: [
        row({ rowId: "direct", transcodeDecision: "direct play" }),
        row({ rowId: "trans", transcodeDecision: "transcode" }),
      ],
    });
    getStreamData.mockResolvedValue({ streamVideoCodec: "h264" });

    await syncTautulliHistory("server-1");

    expect(getStreamData).toHaveBeenCalledTimes(1);
    expect(getStreamData).toHaveBeenCalledWith("trans");
  });

  it("resolves the media item via guid when ratingKey misses", async () => {
    mockPrisma.tautulliInstance.findFirst.mockResolvedValueOnce(INSTANCE);
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]); // ratingKey map empty
    setupFindMany([], []);
    mockPrisma.mediaItemExternalId.findFirst.mockResolvedValueOnce({ mediaItemId: "item-7" });
    getHistory.mockResolvedValueOnce({
      rows: [row({ ratingKey: "nope", guid: "com.plexapp.agents.thetvdb://121361/6/1" })],
    });

    const res = await syncTautulliHistory("server-1");

    expect(res.count).toBe(1);
    expect(mockPrisma.mediaItemExternalId.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: "tvdb", externalId: "121361" }),
      })
    );
  });
});
