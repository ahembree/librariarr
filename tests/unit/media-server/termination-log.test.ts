import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@/lib/logger";
import {
  logTermination,
  terminationFailureMessage,
  TERMINATION_SOURCE,
} from "@/lib/media-server/termination-log";
import { getCachedSessionListing } from "@/lib/media-server/session-listing-cache";

const base = {
  serverId: "srv1",
  serverName: "My Plex",
  sessionId: "s1",
  trigger: "manual",
  reason: "Going down for maintenance",
};

describe("termination logging", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs every termination under one source, whatever the trigger", () => {
    logTermination({ ...base, session: { type: "movie", title: "Arrival", year: 2016, username: "alice" } });
    logTermination({ ...base, trigger: 'blackout "Weeknights"', session: { type: "movie", title: "Dune", username: "bob" } });

    const sources = vi.mocked(logger.info).mock.calls.map((call) => call[0]);
    expect(sources).toEqual([TERMINATION_SOURCE, TERMINATION_SOURCE]);
  });

  it("names user, media, session, trigger and reason", () => {
    logTermination({
      ...base,
      trigger: "maintenance mode",
      session: {
        type: "episode",
        title: "Pilot",
        grandparentTitle: "Breaking Bad",
        seasonNumber: 1,
        episodeNumber: 1,
        username: "bob",
      },
    });

    expect(vi.mocked(logger.info).mock.calls[0][1]).toBe(
      'Terminated session for "bob" on "My Plex" — Breaking Bad S01E01 (session s1) ' +
        "(trigger: maintenance mode, reason: Going down for maintenance)"
    );
    expect(vi.mocked(logger.info).mock.calls[0][2]).toEqual({
      sessionId: "s1",
      serverId: "srv1",
      username: "bob",
      mediaTitle: "Breaking Bad S01E01",
      trigger: "maintenance mode",
      reason: "Going down for maintenance",
    });
  });

  // Every successful termination passes here, from the route and the enforcer
  // alike, so the public API's cached listing is dropped here.
  it("drops the public API's cached session listing", async () => {
    const fetchSessions = vi.fn().mockResolvedValue([]);
    await getCachedSessionListing("srv1", fetchSessions);
    await getCachedSessionListing("srv1", fetchSessions);
    expect(fetchSessions).toHaveBeenCalledTimes(1);

    logTermination({ ...base, trigger: "maintenance mode" });
    await getCachedSessionListing("srv1", fetchSessions);
    expect(fetchSessions).toHaveBeenCalledTimes(2);
  });

  it("falls back when the session was never seen", () => {
    logTermination(base);
    expect(vi.mocked(logger.info).mock.calls[0][1]).toContain('"unknown user"');
    expect(vi.mocked(logger.info).mock.calls[0][1]).toContain("unknown media");
  });

  it("treats an empty username as unknown", () => {
    logTermination({ ...base, session: { type: "movie", title: "Arrival", username: "" } });
    expect(vi.mocked(logger.info).mock.calls[0][2]).toMatchObject({ username: "unknown user" });
  });

  it("names the viewer and media on a failure too", () => {
    const msg = terminationFailureMessage(
      { ...base, session: { type: "movie", title: "Arrival", year: 2016, username: "alice" } },
      "Network error"
    );
    expect(msg).toBe(
      'Failed to terminate session for "alice" on "My Plex" — Arrival (2016) (session s1): Network error'
    );
  });

  it("keeps a failure message readable when the detail was scrubbed away", () => {
    expect(terminationFailureMessage(base, undefined)).toContain("unknown error");
  });
});
