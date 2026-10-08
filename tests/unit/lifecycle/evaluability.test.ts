import { describe, it, expect, beforeEach, vi } from "vitest";

const mockHasEnabledArrInstances = vi.hoisted(() => vi.fn());
const mockHasEnabledSeerrInstances = vi.hoisted(() => vi.fn());

// Real hasArrRules/hasSeerrRules from the engine classify the rule fixtures;
// only the instance lookups (DB) are mocked.
// `findMany`, not `count`: the guard names the offending server and states
// which of its two faults applies, so it reads the rows rather than tallying.
const mockServerFindMany = vi.hoisted(() => vi.fn());
const mockRadarrFindFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  prisma: {
    mediaServer: { findMany: mockServerFindMany },
    radarrInstance: { findFirst: mockRadarrFindFirst },
  },
}));

/** An unevidenced server row, in the shape the guard selects. */
function unsyncedServer(name: string) {
  return {
    name,
    libraryResyncRequiredAt: null,
    watchHistorySyncedAt: null,
    tracearrServerId: null,
    tracearrForwardFloorAt: null,
    tracearrBackfillComplete: false,
  };
}

/** A Tracearr-mapped server whose archive walk has not reached the far end. */
function importingServer(name: string) {
  return {
    name,
    libraryResyncRequiredAt: null,
    watchHistorySyncedAt: new Date("2025-07-10T12:00:00.000Z"),
    tracearrServerId: "trc-1",
    tracearrForwardFloorAt: null,
    tracearrBackfillComplete: false,
  };
}

/** A server held for a library resync (a purge, a restore, a first population). */
function heldServer(name: string, overrides: Record<string, unknown> = {}) {
  return {
    ...importingServer(name),
    libraryResyncRequiredAt: new Date("2025-07-11T12:00:00.000Z"),
    ...overrides,
  };
}

/** A mapped server whose forward walk stopped part-way, leaving a known gap. */
function gappedServer(name: string, overrides: Record<string, unknown> = {}) {
  return {
    ...importingServer(name),
    tracearrBackfillComplete: true,
    tracearrForwardFloorAt: new Date("2025-07-09T12:00:00.000Z"),
    ...overrides,
  };
}
vi.mock("@/lib/lifecycle/fetch-arr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-arr-metadata")>();
  return {
    ...actual,
    hasEnabledArrInstances: mockHasEnabledArrInstances,
  };
});
vi.mock("@/lib/lifecycle/fetch-seerr-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/fetch-seerr-metadata")>();
  return {
    ...actual,
    hasEnabledSeerrInstances: mockHasEnabledSeerrInstances,
  };
});

import { checkLifecycleRuleEvaluability } from "@/lib/lifecycle/evaluability";
import type { LifecycleRuleGroup } from "@/lib/rules/types";

function groupsWith(field: string): LifecycleRuleGroup[] {
  return [
    {
      id: "g1",
      condition: "AND",
      rules: [{ id: "r1", field, operator: "equals", value: "false", condition: "AND" }],
      groups: [],
    },
  ];
}

describe("checkLifecycleRuleEvaluability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasEnabledArrInstances.mockResolvedValue(true);
    mockHasEnabledSeerrInstances.mockResolvedValue(true);
    // No server mid-import by default.
    mockServerFindMany.mockResolvedValue([]);
  });

  it("is evaluable for plain DB rules without touching instance lookups", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("title"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledArrInstances).not.toHaveBeenCalled();
    expect(mockHasEnabledSeerrInstances).not.toHaveBeenCalled();
  });

  it("is evaluable for Arr rules when an enabled instance exists", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledArrInstances).toHaveBeenCalledWith("u1", "MOVIE", undefined);
  });

  it("refuses Arr rules with no enabled instance (transient — no disarm)", async () => {
    mockHasEnabledArrInstances.mockResolvedValue(false);
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/no enabled Radarr instance/i);
    }
  });

  it("passes the rule set's Arr instance and names it when it is disabled", async () => {
    mockHasEnabledArrInstances.mockResolvedValue(false);
    mockRadarrFindFirst.mockResolvedValue({ id: "r2", name: "Radarr 4K", enabled: false });
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"), undefined, "r2");
    expect(mockHasEnabledArrInstances).toHaveBeenCalledWith("u1", "MOVIE", "r2");
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/instance "Radarr 4K" is disabled/);
    }
  });

  it("names the right Arr family per library type", async () => {
    mockHasEnabledArrInstances.mockResolvedValue(false);
    const series = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("foundInArr"));
    if (!series.evaluable) expect(series.reason).toMatch(/Sonarr/);
    const music = await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("foundInArr"));
    if (!music.evaluable) expect(music.reason).toMatch(/Lidarr/);
  });

  it("refuses Seerr rules on MUSIC as PERMANENT regardless of instances", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("seerrRequested"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(true);
      expect(result.reason).toMatch(/Seerr criteria are not supported for music/i);
    }
    // Never even needs the instance lookup — the config can never evaluate
    expect(mockHasEnabledSeerrInstances).not.toHaveBeenCalled();
  });

  it("refuses Seerr rules with no enabled Seerr instance (transient)", async () => {
    mockHasEnabledSeerrInstances.mockResolvedValue(false);
    const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("seerrRequested"));
    expect(result.evaluable).toBe(false);
    if (!result.evaluable) {
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/no enabled Seerr instance/i);
    }
  });

  it("is evaluable for Seerr rules on MOVIE/SERIES when an enabled instance exists", async () => {
    const result = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("seerrRequested"));
    expect(result).toEqual({ evaluable: true });
    expect(mockHasEnabledSeerrInstances).toHaveBeenCalledWith("u1");
  });

  describe("watch history", () => {
    it("refuses watchedByUser rules while a Tracearr server is still importing", async () => {
      // The match-all hazard, in its third flavour. `watchedByUser` reads the
      // `WatchHistory` relation directly — not the monotonic playCount columns —
      // so its negative forms compile to `watchHistory: { none: … }`, which is
      // trivially TRUE for every item against an empty relation.
      //
      // Changing a server's watch-history source wipes its rows on purpose, and
      // the re-import is a background walk taking minutes to hours. A detection
      // run in that window would match the entire library, and on a DELETE rule
      // set that is the whole library deleted.
      mockServerFindMany.mockResolvedValue([importingServer("Plex")]);

      const result = await checkLifecycleRuleEvaluability(
        "u1",
        "MOVIE",
        groupsWith("watchedByUser"),
      );

      expect(result.evaluable).toBe(false);
      if (result.evaluable) throw new Error("expected not evaluable");
      // Transient: it resumes by itself once the backfill finishes, so callers
      // skip rather than disarm.
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/play history|import/i);
    });

    it("is evaluable once every Tracearr server has finished importing", async () => {
      mockServerFindMany.mockResolvedValue([]);

      await expect(
        checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser")),
      ).resolves.toEqual({ evaluable: true });
    });



    it("refuses after an UNLINK, not just during an import", async () => {
      // The hole the first version of this guard had. Unlinking a server
      // (Tracearr -> native) wipes its rows AND sets `tracearrServerId` to
      // null, so a check keyed on "is Tracearr-mapped and unfinished" stops
      // seeing the server at exactly its emptiest moment. The marker is set by
      // the wipe itself, so it covers both directions.
      //
      // Asserted through the WHERE clause: the count must consider a cleared
      // history independently of any Tracearr mapping.
      mockServerFindMany.mockResolvedValue([]);

      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser"));

      const where = mockServerFindMany.mock.calls[0][0].where;
      expect(where.OR).toEqual(
        expect.arrayContaining([{ watchHistorySyncedAt: null }]),
      );
      // ...and must NOT require a Tracearr mapping at the top level, or an
      // unlinked server would be filtered out before the OR is considered.
      expect(where).not.toHaveProperty("tracearrServerId");
    });

    it("refuses a server whose history has never been established", async () => {
      // The state a null default has to cover: a brand-new server, and one
      // whose history was destroyed by a purge or a restore. A "cleared at"
      // marker could not express either — its null read as healthy, so absence
      // of evidence presented itself as evidence of absence.
      mockServerFindMany.mockResolvedValue([]);

      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser"));

      const where = mockServerFindMany.mock.calls[0][0].where;
      expect(where.OR).toEqual(
        expect.arrayContaining([{ watchHistorySyncedAt: null }]),
      );
    });

    it("only considers the servers the rule set targets", async () => {
      // Without scoping, one unrelated server part-way through its Tracearr
      // import would pause every watchedByUser rule set on the install —
      // including ones reading only native servers whose history is complete.
      // Worse, a backfill that never finishes (instance disabled, mapping to a
      // server Tracearr no longer monitors) would disable them permanently.
      mockServerFindMany.mockResolvedValue([]);

      await checkLifecycleRuleEvaluability(
        "u1",
        "MOVIE",
        groupsWith("watchedByUser"),
        ["server-a", "server-b"],
      );

      expect(mockServerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ["server-a", "server-b"] } }),
        }),
      );
    });

    it("falls back to every server when the rule set targets all of them", async () => {
      // An empty `serverIds` is the rule set's own default and means "all", so
      // the check must stay broad rather than silently matching nothing.
      mockServerFindMany.mockResolvedValue([]);

      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser"), []);

      const where = mockServerFindMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty("id");
    });

    it("names the server and its specific fault, not a bare tally", async () => {
      // The two clauses are different faults with different remedies, and the
      // old message ("N server(s) ... never synced, recently cleared, or still
      // importing") could distinguish neither. A user whose Tracearr import had
      // long since finished was told to go watch its progress bar — which reads
      // done, because it reflects `tracearrBackfillComplete`, while what had
      // actually been withdrawn was `watchHistorySyncedAt`. A refusal the user
      // cannot act on reads as a bug in the rule they were writing.
      mockServerFindMany.mockResolvedValue([unsyncedServer("Cornerstone")]);

      const result = await checkLifecycleRuleEvaluability(
        "u1",
        "MOVIE",
        groupsWith("playCount"),
      );

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain('"Cornerstone"');
      expect(result.reason).toMatch(/no sync has established/i);
      // ...and must NOT blame an import, which is the other fault entirely.
      expect(result.reason).not.toMatch(/import/i);
    });

    it("blames the import only for a server that is actually still importing", async () => {
      mockServerFindMany.mockResolvedValue([importingServer("Plex")]);

      const result = await checkLifecycleRuleEvaluability(
        "u1",
        "MOVIE",
        groupsWith("playCount"),
      );

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain('"Plex"');
      expect(result.reason).toMatch(/import/i);
    });

    it("keeps the message bounded when many servers are unevidenced", async () => {
      mockServerFindMany.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => unsyncedServer(`Server ${i}`)),
      );

      const result = await checkLifecycleRuleEvaluability(
        "u1",
        "MOVIE",
        groupsWith("playCount"),
      );

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain("8 server(s)");
      expect(result.reason).toContain("and 3 more");
      expect(result.reason).not.toContain('"Server 5"');
    });

    it("asks for held servers and mapped servers with a forward gap, besides the two older faults", async () => {
      mockServerFindMany.mockResolvedValue([]);

      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser"));

      const { where, select } = mockServerFindMany.mock.calls[0][0];
      expect(where.OR).toEqual([
        { libraryResyncRequiredAt: { not: null } },
        { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
        { watchHistorySyncedAt: null },
        { tracearrServerId: { not: null }, tracearrForwardFloorAt: { not: null } },
      ]);
      expect(select).toMatchObject({ libraryResyncRequiredAt: true, tracearrForwardFloorAt: true });
    });

    it("sends a held server to a full library sync, ahead of every other fault it has", async () => {
      // The hold's only remedy is a complete library sync; a history sync or
      // a finishing import cannot lift it, so naming those would be a dead end.
      mockServerFindMany.mockResolvedValue([
        heldServer("Purged", {
          tracearrServerId: null,
          watchHistorySyncedAt: null,
          tracearrForwardFloorAt: new Date(),
        }),
      ]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.permanent).toBe(false);
      expect(result.reason).toContain(
        '"Purged" (some of its media was removed in bulk or is being added for the first time — ' +
          "a purge, a restore, or a library's first sync — and play history waits for a complete " +
          "library sync of this server; run Sync on it under Settings → Servers, and if this stays, " +
          "System Logs name the library it is still waiting for)",
      );
      expect(result.reason).not.toMatch(/no sync has established|reading recent plays|not finished walking/);
    });

    it("tells a held Tracearr-mapped server that the restarted import comes after the library sync", async () => {
      // Its release nulls the marker and only the restarted walk's completion
      // establishes it again, so the library sync alone does not end the pause.
      mockServerFindMany.mockResolvedValue([heldServer("Mapped", { watchHistorySyncedAt: null })]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain(
        "run Sync on it under Settings → Servers, and if this stays, System Logs name the library " +
          "it is still waiting for; after that sync, the Tracearr history import it restarted has to " +
          "read back through the archive before play history counts again)",
      );
      expect(result.reason).not.toMatch(/no sync has established|reading recent plays|not finished walking/);
    });

    it("names an unfinished import before a withdrawn marker on a mapped server", async () => {
      // After a hold's release the marker is null AND the restarted walk is
      // running: only the walk's completion re-establishes the marker there,
      // so "run a Refresh" (which runs only the forward catch-up) cannot help.
      mockServerFindMany.mockResolvedValue([importingServer("Plex")].map((s) => ({ ...s, watchHistorySyncedAt: null })));

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain(
        '"Plex" (its Tracearr history import has not finished walking back through the archive — ' +
          "it starts over after a purge, a restore or a library's first sync; this clears when the " +
          "import completes, and Settings → Servers shows its progress, or why it is paused)",
      );
      expect(result.reason).not.toMatch(/no sync has established|Refresh/);
    });

    it("names a withdrawn marker before a forward gap, with every cause it has", async () => {
      mockServerFindMany.mockResolvedValue([gappedServer("Plex", { watchHistorySyncedAt: null })]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain(
        '"Plex" (no sync has established what was played there — it has never synced, its ' +
          "history was cleared (a watch-history source change, a purge, a backup restore), or a " +
          "sync could not attribute every play; the next successful watch-history sync establishes " +
          "it — run one from Library → History → Refresh. If a user's play history could not be " +
          "read, System Logs name the user and what to change; a Refresh does not lift that one)",
      );
      expect(result.reason).not.toMatch(/reading recent plays/);
    });

    it("names an unfinished import before a forward gap", async () => {
      mockServerFindMany.mockResolvedValue([gappedServer("Plex", { tracearrBackfillComplete: false })]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toMatch(/not finished walking back through the archive/);
      expect(result.reason).not.toMatch(/reading recent plays/);
    });

    it("describes a forward gap honestly: an import reading recent plays now, or an interrupted one", async () => {
      // The importer records the floor before the first page with a new play
      // of EVERY forward walk and clears it when the walk ends, so this is
      // what a healthy realtime import looks like while it runs — refusing is
      // right (those plays are unread), calling it "interrupted" was not.
      mockServerFindMany.mockResolvedValue([gappedServer("Plex")]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain(
        '"Plex" (a Tracearr import is reading recent plays, or one was interrupted before it ' +
          "finished; this clears when that import completes — the next watch-history sync resumes " +
          "an interrupted one)",
      );
    });

    it("keeps the five-name bound with the new faults mixed in", async () => {
      mockServerFindMany.mockResolvedValue([
        heldServer("A"),
        gappedServer("B"),
        unsyncedServer("C"),
        importingServer("D"),
        heldServer("E"),
        gappedServer("F"),
        importingServer("G"),
      ]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("playCount"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.reason).toContain("7 server(s)");
      expect(result.reason).toContain("and 2 more");
      expect(result.reason).toContain('"E"');
      expect(result.reason).not.toContain('"F"');
    });

    it("does not consult watch history for rules that never read it", async () => {
      // The lookup is a DB round-trip on the hot detection path; a rule set with
      // no watchedByUser rule must not pay for it.
      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("title"));

      expect(mockServerFindMany).not.toHaveBeenCalled();
    });
  });

  describe("an Arr or Seerr refusal of a rule set that reads play activity", () => {
    // Play Count = 0 AND the given criterion. The Arr/Seerr refusal comes
    // first and keeps its reason, but detection skipping the rule set while its
    // play history is not established must still record the play-history latch
    // (`notePlayHistoryPause`): the matches it keeps may predate a play.
    function playCountAnd(field: string): LifecycleRuleGroup[] {
      return [
        {
          id: "g1",
          condition: "AND",
          rules: [
            { id: "r1", field: "playCount", operator: "equals", value: 0, condition: "AND" },
            { id: "r2", field, operator: "equals", value: "false", condition: "AND" },
          ],
          groups: [],
        },
      ] as unknown as LifecycleRuleGroup[];
    }

    it("carries playHistory while a targeted server's play history is not established, keeping its own reason", async () => {
      mockHasEnabledArrInstances.mockResolvedValue(false);
      mockServerFindMany.mockResolvedValue([heldServer("Plex")]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", playCountAnd("foundInArr"), ["s1"]);

      expect(result).toEqual({
        evaluable: false,
        permanent: false,
        playHistory: true,
        reason: expect.stringMatching(/^Rules use Arr criteria but no enabled Radarr instance exists/),
      });
      // Asked of the rule set's own servers, like the play-history refusal.
      expect(JSON.stringify(mockServerFindMany.mock.calls[0][0].where)).toContain('"s1"');
    });

    it("so does a Seerr refusal, transient or permanent", async () => {
      mockHasEnabledSeerrInstances.mockResolvedValue(false);
      mockServerFindMany.mockResolvedValue([unsyncedServer("Jellyfin")]);

      const movie = await checkLifecycleRuleEvaluability("u1", "MOVIE", playCountAnd("seerrRequested"));
      expect(movie).toEqual({
        evaluable: false,
        permanent: false,
        playHistory: true,
        reason: expect.stringMatching(/^Rules use Seerr criteria but no enabled Seerr instance exists/),
      });

      const music = await checkLifecycleRuleEvaluability("u1", "MUSIC", playCountAnd("seerrRequested"));
      expect(music).toEqual({
        evaluable: false,
        permanent: true,
        playHistory: true,
        reason: "Seerr criteria are not supported for music rules",
      });
    });

    it("carries no flag while the play history is established", async () => {
      mockHasEnabledArrInstances.mockResolvedValue(false);
      mockHasEnabledSeerrInstances.mockResolvedValue(false);
      mockServerFindMany.mockResolvedValue([]);

      const arr = await checkLifecycleRuleEvaluability("u1", "MOVIE", playCountAnd("foundInArr"));
      const seerr = await checkLifecycleRuleEvaluability("u1", "MOVIE", playCountAnd("seerrRequested"));

      if (arr.evaluable || seerr.evaluable) throw new Error("expected both refused");
      expect(arr.reason).toMatch(/^Rules use Arr criteria/);
      expect(seerr.reason).toMatch(/^Rules use Seerr criteria/);
      expect(arr).not.toHaveProperty("playHistory");
      expect(seerr).not.toHaveProperty("playHistory");
    });

    it("does not ask the play history of a refused rule set that reads no play activity", async () => {
      mockHasEnabledArrInstances.mockResolvedValue(false);
      mockServerFindMany.mockResolvedValue([unsyncedServer("Plex")]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("foundInArr"));

      expect(result).not.toHaveProperty("playHistory");
      expect(mockServerFindMany).not.toHaveBeenCalled();
    });
  });

});
