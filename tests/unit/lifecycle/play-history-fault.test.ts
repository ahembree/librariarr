import { describe, it, expect } from "vitest";
import { playHistoryFault, type PlayHistoryEvidence } from "@/lib/lifecycle/play-history-fault";

const NOW = "2026-10-01T12:00:00.000Z";

/** An established native server, as `/api/servers` returns it. */
const NATIVE: PlayHistoryEvidence = {
  libraryResyncRequiredAt: null,
  watchHistorySyncedAt: NOW,
  tracearrServerId: null,
  tracearrForwardFloorAt: null,
  // The schema default — every native server carries it.
  tracearrBackfillComplete: false,
};

/** An established Tracearr-mapped server whose archive walk finished. */
const MAPPED: PlayHistoryEvidence = {
  ...NATIVE,
  tracearrServerId: "trc-server-1",
  tracearrBackfillComplete: true,
};

describe("playHistoryFault", () => {
  it("reports nothing for established servers", () => {
    expect(playHistoryFault(NATIVE)).toBeNull();
    expect(playHistoryFault(MAPPED)).toBeNull();
  });

  it("reports a held library resync first, whatever else is wrong", () => {
    // The hold withdraws the marker too, and what lifts it is a complete
    // library sync — not the watch-history sync "unsynced" would point to.
    expect(playHistoryFault({ ...NATIVE, libraryResyncRequiredAt: NOW })).toBe("resync");
    expect(playHistoryFault({ ...NATIVE, libraryResyncRequiredAt: NOW, watchHistorySyncedAt: null })).toBe("resync");
    expect(
      playHistoryFault({
        ...MAPPED,
        libraryResyncRequiredAt: NOW,
        watchHistorySyncedAt: null,
        tracearrForwardFloorAt: NOW,
        tracearrBackfillComplete: false,
      }),
    ).toBe("resync");
  });

  it("reports an unfinished archive walk on a mapped server before a missing marker or a gap", () => {
    // After a hold's release on a mapped server, both hold: the marker is null
    // and the walk the release restarted is running. Only the walk's
    // completion re-establishes the marker there, so "unsynced" (run a
    // Refresh) would send the user to a sync that cannot help.
    expect(playHistoryFault({ ...MAPPED, tracearrBackfillComplete: false })).toBe("importing");
    expect(playHistoryFault({ ...MAPPED, watchHistorySyncedAt: null, tracearrBackfillComplete: false })).toBe(
      "importing",
    );
    expect(
      playHistoryFault({ ...MAPPED, watchHistorySyncedAt: null, tracearrForwardFloorAt: NOW, tracearrBackfillComplete: false }),
    ).toBe("importing");
    expect(playHistoryFault({ ...MAPPED, tracearrForwardFloorAt: NOW, tracearrBackfillComplete: false })).toBe(
      "importing",
    );
  });

  it("reports a missing marker before a forward gap", () => {
    expect(playHistoryFault({ ...NATIVE, watchHistorySyncedAt: null })).toBe("unsynced");
    // A mapped server whose walk has finished: the next watch-history sync helps.
    expect(playHistoryFault({ ...MAPPED, watchHistorySyncedAt: null })).toBe("unsynced");
    expect(playHistoryFault({ ...MAPPED, watchHistorySyncedAt: null, tracearrForwardFloorAt: NOW })).toBe("unsynced");
  });

  it("reports a forward gap on a mapped server whose walk finished and whose marker stands", () => {
    expect(playHistoryFault({ ...MAPPED, tracearrForwardFloorAt: NOW })).toBe("gap");
  });

  it("ignores the Tracearr columns of a server that is not mapped", () => {
    // `tracearrBackfillComplete` is false on every native server by default,
    // and a floor left behind by an unlink describes no import.
    expect(playHistoryFault({ ...NATIVE, tracearrBackfillComplete: false })).toBeNull();
    expect(playHistoryFault({ ...NATIVE, tracearrForwardFloorAt: NOW })).toBeNull();
  });

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
