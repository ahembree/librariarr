import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import {
  runEnforcerTick,
  sessionMatchesCriteria,
  isBlackoutActive,
  _resetForTesting,
} from "@/lib/maintenance/enforcer";
import type { MediaSession } from "@/lib/media-server/types";

// ---------------------------------------------------------------------------
// Hoisted mocks — stable, no vi.resetModules / vi.doMock needed
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findMany: vi.fn() },
    blackoutSchedule: { findMany: vi.fn() },
    prerollSchedule: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Tests call runEnforcerTick() directly — no timer mocking needed.
// _resetForTesting() clears module-level state between tests.
// ---------------------------------------------------------------------------

describe("initializeMaintenanceEnforcer", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    vi.mocked(prisma.blackoutSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([]),
      terminateSession: vi.fn().mockResolvedValue(undefined),
      setPrerollPath: vi.fn().mockResolvedValue(undefined),
      clearPreroll: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof createMediaServerClient>);
  });

  it("terminates sessions immediately when maintenance is enabled and delay has elapsed", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: true,
        maintenanceDelay: 0,
        maintenanceMessage: "Down for maintenance",
        maintenanceExcludedUsers: [],
        transcodeManagerEnabled: false,
        transcodeManagerDelay: 30,
        transcodeManagerMessage: "",
        transcodeManagerCriteria: null,
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "server1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    const localTerminate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess1",
          username: "bob",
          title: "Movie A",
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).toHaveBeenCalledWith("sess1", "Down for maintenance");
  });

  it("excludes users in maintenanceExcludedUsers", async () => {
    const localTerminate = vi.fn();

    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: true,
        maintenanceDelay: 0,
        maintenanceMessage: "Down",
        maintenanceExcludedUsers: ["admin"],
        transcodeManagerEnabled: false,
        transcodeManagerDelay: 30,
        transcodeManagerMessage: "",
        transcodeManagerCriteria: null,
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "server1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess1",
          username: "admin",
          title: "Movie A",
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("does nothing when no settings have maintenance or transcode enabled", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);

    await runEnforcerTick();

    expect(createMediaServerClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test sessionMatchesCriteria logic via transcode manager path
// ---------------------------------------------------------------------------

describe("transcode manager criteria (via enforcer)", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    vi.mocked(prisma.blackoutSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  });

  it("terminates video transcoding session when videoTranscoding criteria is set", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: false,
        maintenanceDelay: 30,
        maintenanceMessage: "",
        maintenanceExcludedUsers: [],
        transcodeManagerEnabled: true,
        transcodeManagerDelay: 0,
        transcodeManagerMessage: "No transcoding",
        transcodeManagerCriteria: {
          anyTranscoding: false,
          videoTranscoding: true,
          audioTranscoding: false,
          fourKTranscoding: false,
          remoteTranscoding: false,
        },
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "s1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    const localTerminate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess-transcode",
          username: "user",
          title: "Movie",
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
          transcoding: { videoDecision: "transcode", audioDecision: "copy" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).toHaveBeenCalledWith("sess-transcode", "No transcoding");
  });

  it("does NOT terminate direct play session when videoTranscoding criteria is set", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: false,
        maintenanceDelay: 30,
        maintenanceMessage: "",
        maintenanceExcludedUsers: [],
        transcodeManagerEnabled: true,
        transcodeManagerDelay: 0,
        transcodeManagerMessage: "No transcoding",
        transcodeManagerCriteria: {
          anyTranscoding: false,
          videoTranscoding: true,
          audioTranscoding: false,
          fourKTranscoding: false,
          remoteTranscoding: false,
        },
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "s1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    const localTerminate = vi.fn();
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess-direct",
          username: "user",
          title: "Movie",
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
          transcoding: { videoDecision: "copy", audioDecision: "copy" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("does NOT terminate a 4K audio-only transcode when only fourKTranscoding is set", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: false,
        maintenanceDelay: 30,
        maintenanceMessage: "",
        maintenanceExcludedUsers: [],
        transcodeManagerEnabled: true,
        transcodeManagerDelay: 0,
        transcodeManagerMessage: "No 4K transcoding",
        transcodeManagerCriteria: {
          anyTranscoding: false,
          videoTranscoding: false,
          audioTranscoding: false,
          fourKTranscoding: true,
          remoteTranscoding: false,
        },
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "s1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    const localTerminate = vi.fn();
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess-4k-audio-only",
          username: "user",
          title: "Movie",
          mediaWidth: 3840,
          mediaHeight: 2160,
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
          // Video direct-streams, only the audio track is re-encoded.
          transcoding: { videoDecision: "copy", audioDecision: "transcode" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("terminates a 4K video transcode when fourKTranscoding is set", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([
      {
        maintenanceMode: false,
        maintenanceDelay: 30,
        maintenanceMessage: "",
        maintenanceExcludedUsers: [],
        transcodeManagerEnabled: true,
        transcodeManagerDelay: 0,
        transcodeManagerMessage: "No 4K transcoding",
        transcodeManagerCriteria: {
          anyTranscoding: false,
          videoTranscoding: false,
          audioTranscoding: false,
          fourKTranscoding: true,
          remoteTranscoding: false,
        },
        transcodeManagerExcludedUsers: [],
        userId: "user1",
        user: {
          mediaServers: [
            { id: "s1", type: "PLEX", name: "Test", url: "http://plex:32400", accessToken: "tok", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);

    const localTerminate = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createMediaServerClient).mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "sess-4k-video",
          username: "user",
          title: "Movie",
          mediaWidth: 3840,
          mediaHeight: 2160,
          player: { local: true },
          session: { bandwidth: 1000, location: "lan" },
          transcoding: { videoDecision: "transcode", audioDecision: "transcode" },
        },
      ]),
      terminateSession: localTerminate,
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    } as unknown as ReturnType<typeof createMediaServerClient>);

    await runEnforcerTick();

    expect(localTerminate).toHaveBeenCalledWith("sess-4k-video", "No 4K transcoding");
  });
});

// ---------------------------------------------------------------------------
// sessionMatchesCriteria — direct unit coverage of the criteria matrix
// ---------------------------------------------------------------------------

describe("sessionMatchesCriteria", () => {
  const NO_CRITERIA = {
    anyTranscoding: false,
    videoTranscoding: false,
    audioTranscoding: false,
    fourKTranscoding: false,
    remoteTranscoding: false,
  };

  function makeSession(overrides: {
    videoDecision?: string;
    audioDecision?: string;
    width?: number;
    height?: number;
    local?: boolean;
  } = {}): MediaSession {
    const { videoDecision, audioDecision, width, height, local = true } = overrides;
    return {
      sessionId: "s",
      userId: "u",
      username: "user",
      userThumb: "",
      title: "Movie",
      type: "movie",
      mediaWidth: width,
      mediaHeight: height,
      player: { product: "Plex", platform: "web", state: "playing", address: "1.2.3.4", local },
      session: { bandwidth: 1000, location: local ? "lan" : "wan" },
      ...(videoDecision || audioDecision
        ? {
            transcoding: {
              videoDecision: videoDecision ?? "copy",
              audioDecision: audioDecision ?? "copy",
              throttled: false,
            },
          }
        : {}),
    } as MediaSession;
  }

  const audioOnly4K = makeSession({
    videoDecision: "copy",
    audioDecision: "transcode",
    width: 3840,
    height: 2160,
  });
  const video4K = makeSession({
    videoDecision: "transcode",
    audioDecision: "copy",
    width: 3840,
    height: 2160,
  });
  const video1080p = makeSession({
    videoDecision: "transcode",
    audioDecision: "copy",
    width: 1920,
    height: 1080,
  });
  const directPlay4K = makeSession({
    videoDecision: "directplay",
    audioDecision: "directplay",
    width: 3840,
    height: 2160,
  });

  describe("fourKTranscoding", () => {
    const criteria = { ...NO_CRITERIA, fourKTranscoding: true };

    it("does not match a 4K stream transcoding audio only", () => {
      expect(sessionMatchesCriteria(audioOnly4K, criteria)).toBe(false);
    });

    it("matches a 4K stream transcoding video", () => {
      expect(sessionMatchesCriteria(video4K, criteria)).toBe(true);
    });

    it("matches on height alone (e.g. 4096x2160 DCI or 3840x1600 scope)", () => {
      const scope = makeSession({ videoDecision: "transcode", width: 3840, height: 1600 });
      const dci = makeSession({ videoDecision: "transcode", width: 4096, height: 2160 });
      expect(sessionMatchesCriteria(scope, criteria)).toBe(true);
      expect(sessionMatchesCriteria(dci, criteria)).toBe(true);
    });

    it("does not match a sub-4K video transcode", () => {
      expect(sessionMatchesCriteria(video1080p, criteria)).toBe(false);
    });

    it("does not match a 4K direct play", () => {
      expect(sessionMatchesCriteria(directPlay4K, criteria)).toBe(false);
    });

    it("does not match when the server reports no resolution", () => {
      const unknown = makeSession({ videoDecision: "transcode" });
      expect(sessionMatchesCriteria(unknown, criteria)).toBe(false);
    });
  });

  describe("other criteria still catch audio-only transcodes", () => {
    it("audioTranscoding matches the 4K audio-only stream", () => {
      expect(
        sessionMatchesCriteria(audioOnly4K, { ...NO_CRITERIA, audioTranscoding: true })
      ).toBe(true);
    });

    it("anyTranscoding matches the 4K audio-only stream", () => {
      expect(
        sessionMatchesCriteria(audioOnly4K, { ...NO_CRITERIA, anyTranscoding: true })
      ).toBe(true);
    });

    it("videoTranscoding does not match the 4K audio-only stream", () => {
      expect(
        sessionMatchesCriteria(audioOnly4K, { ...NO_CRITERIA, videoTranscoding: true })
      ).toBe(false);
    });

    it("remoteTranscoding matches any transcode from a remote player", () => {
      const remoteAudioOnly = makeSession({ audioDecision: "transcode", local: false });
      expect(
        sessionMatchesCriteria(remoteAudioOnly, { ...NO_CRITERIA, remoteTranscoding: true })
      ).toBe(true);
    });

    it("remoteTranscoding does not match a local transcode", () => {
      expect(
        sessionMatchesCriteria(video1080p, { ...NO_CRITERIA, remoteTranscoding: true })
      ).toBe(false);
    });
  });

  it("returns false when no criteria are enabled", () => {
    expect(sessionMatchesCriteria(video4K, NO_CRITERIA)).toBe(false);
  });

  it("returns false for a session with no transcoding info at all", () => {
    expect(
      sessionMatchesCriteria(makeSession({ width: 3840, height: 2160 }), {
        anyTranscoding: true,
        videoTranscoding: true,
        audioTranscoding: true,
        fourKTranscoding: true,
        remoteTranscoding: true,
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlackoutActive — recurring windows, including overnight spans
// ---------------------------------------------------------------------------

describe("isBlackoutActive (recurring)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Freezes local time and returns that moment's day-of-week. */
  function freeze(date: Date): number {
    vi.useFakeTimers();
    vi.setSystemTime(date);
    return date.getDay();
  }

  function recurring(days: number[], startTime: string, endTime: string) {
    return {
      scheduleType: "recurring",
      startDate: null,
      endDate: null,
      daysOfWeek: days,
      startTime,
      endTime,
    };
  }

  describe("same-day window (09:00 - 17:00)", () => {
    // Anchor day; the schedule targets this weekday only.
    const anchor = new Date(2026, 0, 5, 12, 0); // midday
    const anchorDay = anchor.getDay();

    it("is active inside the window", () => {
      freeze(anchor);
      expect(isBlackoutActive(recurring([anchorDay], "09:00", "17:00"))).toBe(true);
    });

    it("is inactive before the window", () => {
      freeze(new Date(2026, 0, 5, 8, 0));
      expect(isBlackoutActive(recurring([anchorDay], "09:00", "17:00"))).toBe(false);
    });

    it("is inactive after the window", () => {
      freeze(new Date(2026, 0, 5, 18, 0));
      expect(isBlackoutActive(recurring([anchorDay], "09:00", "17:00"))).toBe(false);
    });

    it("is inactive on a day that is not selected", () => {
      freeze(new Date(2026, 0, 6, 12, 0));
      expect(isBlackoutActive(recurring([anchorDay], "09:00", "17:00"))).toBe(false);
    });
  });

  describe("overnight window (22:00 - 06:00) selected on one day", () => {
    const startDay = new Date(2026, 0, 5, 23, 0).getDay();
    const days = [startDay];

    it("is active late on the selected day", () => {
      freeze(new Date(2026, 0, 5, 23, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(true);
    });

    it("is active after midnight on the FOLLOWING day", () => {
      // Regression: the day check used to be applied to `now`, so the window
      // was truncated at midnight instead of running through to 06:00.
      freeze(new Date(2026, 0, 6, 2, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(true);
    });

    it("is inactive in the small hours of the selected day itself", () => {
      // Regression: 03:00 on the start day used to match `currentMin <= endMin`
      // and fire the blackout ~19 hours early.
      freeze(new Date(2026, 0, 5, 3, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(false);
    });

    it("is inactive once the following morning's window has passed", () => {
      freeze(new Date(2026, 0, 6, 7, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(false);
    });

    it("is inactive during the selected day's working hours", () => {
      freeze(new Date(2026, 0, 5, 12, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(false);
    });

    it("is inactive two days later", () => {
      freeze(new Date(2026, 0, 7, 2, 0));
      expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(false);
    });
  });

  it("wraps the week boundary (Saturday night into Sunday morning)", () => {
    const saturday = new Date(2026, 0, 10, 23, 0);
    expect(saturday.getDay()).toBe(6);
    const days = [6];

    freeze(saturday);
    expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(true);

    freeze(new Date(2026, 0, 11, 2, 0)); // Sunday, getDay() === 0
    expect(isBlackoutActive(recurring(days, "22:00", "06:00"))).toBe(true);
  });

  it("returns false when the schedule is incomplete", () => {
    freeze(new Date(2026, 0, 5, 12, 0));
    expect(isBlackoutActive(recurring([], "09:00", "17:00"))).toBe(false);
    expect(
      isBlackoutActive({ ...recurring([1], "09:00", "17:00"), daysOfWeek: null })
    ).toBe(false);
    expect(
      isBlackoutActive({ ...recurring([1], "09:00", "17:00"), startTime: null })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blackout: block_new_only must grandfather sessions on EVERY server
// ---------------------------------------------------------------------------

describe("blackout block_new_only", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  });

  function mockTwoServerBlackout() {
    vi.mocked(prisma.blackoutSchedule.findMany).mockResolvedValue([
      {
        id: "sched1",
        userId: "user1",
        name: "Nightly",
        enabled: true,
        action: "block_new_only",
        message: "Blackout",
        delay: 30,
        excludedUsers: [],
        scheduleType: "one_time",
        startDate: new Date(Date.now() - 60_000),
        endDate: new Date(Date.now() + 60_000),
        daysOfWeek: null,
        startTime: null,
        endTime: null,
        user: {
          mediaServers: [
            { id: "sA", type: "PLEX", name: "A", url: "http://a", accessToken: "t", tlsSkipVerify: false },
            { id: "sB", type: "PLEX", name: "B", url: "http://b", accessToken: "t", tlsSkipVerify: false },
          ],
        },
      },
    ] as never);
  }

  /** Wires each server to report its own session list. */
  function mockServers(sessionsByUrl: Record<string, string[]>, terminators: Record<string, ReturnType<typeof vi.fn>>) {
    vi.mocked(createMediaServerClient).mockImplementation(((_type: unknown, url: string) => ({
      getSessions: vi.fn().mockResolvedValue(
        sessionsByUrl[url].map((sessionId) => ({
          sessionId,
          username: "bob",
          title: "Movie",
          player: { local: true },
          session: { bandwidth: 1, location: "lan" },
        }))
      ),
      terminateSession: terminators[url],
      setPrerollPath: vi.fn(),
      clearPreroll: vi.fn(),
    })) as never);
  }

  it("does not terminate pre-existing sessions on any server when the blackout starts", async () => {
    mockTwoServerBlackout();
    const terminateA = vi.fn().mockResolvedValue(undefined);
    const terminateB = vi.fn().mockResolvedValue(undefined);
    mockServers({ "http://a": ["a-existing"], "http://b": ["b-existing"] }, {
      "http://a": terminateA,
      "http://b": terminateB,
    });

    await runEnforcerTick();

    // Regression: a schedule-level snapshot key meant whichever server
    // answered first won, and the other server's live streams were killed.
    expect(terminateA).not.toHaveBeenCalled();
    expect(terminateB).not.toHaveBeenCalled();
  });

  it("terminates only sessions that appear after the blackout started, per server", async () => {
    mockTwoServerBlackout();
    const terminateA = vi.fn().mockResolvedValue(undefined);
    const terminateB = vi.fn().mockResolvedValue(undefined);

    // Tick 1: snapshot both servers.
    mockServers({ "http://a": ["a-existing"], "http://b": ["b-existing"] }, {
      "http://a": terminateA,
      "http://b": terminateB,
    });
    await runEnforcerTick();

    // Tick 2: one genuinely new session joins each server.
    mockServers({ "http://a": ["a-existing", "a-new"], "http://b": ["b-existing", "b-new"] }, {
      "http://a": terminateA,
      "http://b": terminateB,
    });
    await runEnforcerTick();

    expect(terminateA.mock.calls.map((c) => c[0])).toEqual(["a-new"]);
    expect(terminateB.mock.calls.map((c) => c[0])).toEqual(["b-new"]);
  });
});
