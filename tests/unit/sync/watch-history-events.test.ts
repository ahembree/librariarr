import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  emit: vi.fn(),
  findUnique: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/events/event-bus", () => ({ eventBus: { emit: h.emit } }));
vi.mock("@/lib/db", () => ({ prisma: { mediaServer: { findUnique: h.findUnique } } }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { emitWatchHistoryUpdated } from "@/lib/sync/watch-history-events";

describe("emitWatchHistoryUpdated", () => {
  beforeEach(() => {
    h.emit.mockClear();
    h.findUnique.mockReset();
    h.warn.mockClear();
  });

  it("emits watch-history:updated addressed to the server's owner", async () => {
    // These jobs are scheduler- and realtime-driven, so there is no session to
    // read the owner from — it has to come from the server row.
    h.findUnique.mockResolvedValue({ userId: "user-1" });

    await emitWatchHistoryUpdated("srv-1", { imported: 42 });

    expect(h.emit).toHaveBeenCalledWith({
      type: "watch-history:updated",
      userId: "user-1",
      meta: { serverId: "srv-1", imported: 42 },
    });
  });

  it("does NOT emit sync:completed", async () => {
    // Reusing sync:completed here would make all 16 library subscribers refetch
    // whole listings once per backfill slice, for the hours an archive walk
    // takes. The separation is the point of this module.
    h.findUnique.mockResolvedValue({ userId: "user-1" });

    await emitWatchHistoryUpdated("srv-1");

    expect(h.emit.mock.calls[0][0].type).toBe("watch-history:updated");
  });

  it("emits with no extra meta when none is given", async () => {
    h.findUnique.mockResolvedValue({ userId: "user-1" });

    await emitWatchHistoryUpdated("srv-1");

    expect(h.emit.mock.calls[0][0].meta).toEqual({ serverId: "srv-1" });
  });

  it("stays silent for a server that no longer exists", async () => {
    h.findUnique.mockResolvedValue(null);

    await emitWatchHistoryUpdated("gone");

    expect(h.emit).not.toHaveBeenCalled();
  });

  it("swallows a database failure so a sync never fails over an event", async () => {
    h.findUnique.mockRejectedValue(new Error("db down"));

    await expect(emitWatchHistoryUpdated("srv-1")).resolves.toBeUndefined();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalled();
  });
});
