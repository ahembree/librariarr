import { describe, it, expect } from "vitest";
import { playHistoryFault, type PlayHistoryEvidence } from "@/lib/lifecycle/play-history-fault";

// Every fault and its precedence: tests/integration/lifecycle/play-history-fault-guard (against the real guard).

const NOW = "2026-10-01T12:00:00.000Z";

/** An established native server, as `/api/servers` returns it (the backfill flag at its schema default). */
const NATIVE: PlayHistoryEvidence = {
  libraryResyncRequiredAt: null,
  watchHistorySyncedAt: NOW,
  tracearrServerId: null,
  tracearrForwardFloorAt: null,
  tracearrBackfillComplete: false,
};

/** An established Tracearr-mapped server whose archive walk finished. */
const MAPPED: PlayHistoryEvidence = {
  ...NATIVE,
  tracearrServerId: "trc-server-1",
  tracearrBackfillComplete: true,
};

describe("playHistoryFault", () => {
  it("reads a field absent from the payload as established", () => {
    expect(playHistoryFault({})).toBeNull();
    expect(playHistoryFault({ tracearrServerId: "trc-server-1" })).toBeNull();
    // No marker field: not "unsynced".
    expect(playHistoryFault({ libraryResyncRequiredAt: null, tracearrServerId: null })).toBeNull();
    // No hold field: not "resync" — the marker still speaks for itself.
    expect(playHistoryFault({ watchHistorySyncedAt: null, tracearrServerId: null })).toBe("unsynced");
    // Only the field that is missing is assumed; the ones present still count.
    expect(
      playHistoryFault({ libraryResyncRequiredAt: null, tracearrServerId: "trc-server-1", tracearrBackfillComplete: false }),
    ).toBe("importing");
  });

  it("reads Date values the same as their JSON strings", () => {
    const at = new Date(NOW);
    expect(playHistoryFault({ ...NATIVE, libraryResyncRequiredAt: at })).toBe("resync");
    expect(playHistoryFault({ ...MAPPED, tracearrForwardFloorAt: at })).toBe("gap");
    expect(playHistoryFault({ ...NATIVE, watchHistorySyncedAt: at })).toBeNull();
  });
});
