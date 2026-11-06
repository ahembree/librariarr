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
    watchHistorySyncedAt: null,
    tracearrServerId: null,
    tracearrBackfillComplete: false,
  };
}

/** A Tracearr-mapped server whose archive walk has not reached the far end. */
function importingServer(name: string) {
  return {
    name,
    watchHistorySyncedAt: new Date("2025-07-10T12:00:00.000Z"),
    tracearrServerId: "trc-1",
    tracearrBackfillComplete: false,
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

  describe("per-episode and per-track criteria at series or artist scope", () => {
    it("skips a series- or artist-scoped rule set using one, transiently and before any lookup", async () => {
      mockHasEnabledArrInstances.mockResolvedValue(false);
      for (const [type, member] of [["SERIES", "episode"], ["MUSIC", "track"]] as const) {
        const result = await checkLifecycleRuleEvaluability("u1", type, groupsWith("resolution"), ["s1"], null, true);
        expect(result).toEqual({
          evaluable: false,
          // An edit resolves it: matches and actions are left in place (held).
          permanent: false,
          reason: expect.stringMatching(new RegExp(`^This rule set uses per-${member} criteria \\(Resolution\\)`)),
        });
      }
      expect(mockHasEnabledArrInstances).not.toHaveBeenCalled();
      expect(mockServerFindMany).not.toHaveBeenCalled();
    });

    it("reads an omitted scope as on, the rule set default", async () => {
      const result = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("year"));
      expect(result.evaluable).toBe(false);
    });

    it("evaluates the same rules with the scope off, and on a movie rule set", async () => {
      expect(await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("resolution"), ["s1"], null, false)).toEqual({ evaluable: true });
      expect(await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("audioCodec"), ["s1"], null, false)).toEqual({ evaluable: true });
      expect(await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("resolution"), ["s1"], null, true)).toEqual({ evaluable: true });
    });

    it("evaluates show-level criteria with the scope on", async () => {
      expect(await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("title"), ["s1"], null, true)).toEqual({ evaluable: true });
    });

    it("skips one whose genre, content rating or studio is read at series scope: episodes carry their own", async () => {
      for (const field of ["genre", "contentRating", "studio", "labels", "isWatchlisted"]) {
        const result = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith(field), ["s1"], null, true);
        expect(result.evaluable, field).toBe(false);
      }
    });

    it("skips one whose action acts on the whole show while its scope is off, with the reason", async () => {
      const deleteSeries = { actionEnabled: true, actionType: "DELETE_SONARR", addArrTags: [], removeArrTags: [], searchAfterAction: false };
      const result = await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("resolution"), ["s1"], null, false, deleteSeries);
      expect(result).toEqual({
        evaluable: false,
        permanent: false,
        reason: expect.stringMatching(/^This rule set's action \("Delete from Sonarr"\) acts on the whole show but follows per-episode criteria \(Resolution\) with series scope off/),
      });
      // An action on the matched episodes only, or the action turned off, is evaluated.
      for (const action of [
        { ...deleteSeries, actionType: "DELETE_FILES_SONARR" },
        { ...deleteSeries, actionEnabled: false },
      ]) {
        expect(await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("resolution"), ["s1"], null, false, action)).toEqual({ evaluable: true });
      }
      // Left out, only the scope is judged.
      expect(await checkLifecycleRuleEvaluability("u1", "SERIES", groupsWith("resolution"), ["s1"], null, false)).toEqual({ evaluable: true });
    });
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
    if (series.evaluable) throw new Error("expected not evaluable");
    expect(series.reason).toMatch(/no enabled Sonarr instance/);
    const music = await checkLifecycleRuleEvaluability("u1", "MUSIC", groupsWith("foundInArr"));
    if (music.evaluable) throw new Error("expected not evaluable");
    expect(music.reason).toMatch(/no enabled Lidarr instance/);
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
      expect(result.reason).toContain('"Plex"');
      expect(result.reason).toMatch(/Tracearr history import has not finished/);
    });

    it("is evaluable once every Tracearr server has finished importing", async () => {
      mockServerFindMany.mockResolvedValue([]);

      await expect(
        checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser")),
      ).resolves.toEqual({ evaluable: true });
    });

    it("looks for an unestablished history whether or not the server is Tracearr-mapped (an UNLINK too)", async () => {
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
      // A Tracearr mapping is required only by the import clause — never at the
      // top level, or an unlinked server would be filtered out before the OR
      // is considered.
      expect(where).toEqual({
        userId: "u1",
        enabled: true,
        OR: [
          { watchHistorySyncedAt: null },
          { tracearrServerId: { not: null }, tracearrBackfillComplete: false },
        ],
      });
    });

    it("refuses a server whose history has never been established", async () => {
      // The state a null default has to cover: a brand-new server, and one
      // whose history was destroyed by a purge or a restore. A "cleared at"
      // marker could not express either — its null read as healthy, so absence
      // of evidence presented itself as evidence of absence.
      mockServerFindMany.mockResolvedValue([unsyncedServer("Living Room")]);

      const result = await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("watchedByUser"));

      if (result.evaluable) throw new Error("expected not evaluable");
      expect(result.permanent).toBe(false);
      expect(result.reason).toMatch(/^Rules read play activity but 1 server\(s\) have no established play history yet/);
      expect(result.reason).toContain('"Living Room"');
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
      // The first five are named, the rest only counted.
      expect(result.reason).toContain('"Server 4"');
      expect(result.reason).not.toContain('"Server 5"');
    });

    it("does not consult watch history for rules that never read it", async () => {
      // The lookup is a DB round-trip on the hot detection path; a rule set with
      // no watchedByUser rule must not pay for it.
      await checkLifecycleRuleEvaluability("u1", "MOVIE", groupsWith("title"));

      expect(mockServerFindMany).not.toHaveBeenCalled();
    });
  });
});
