import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { logger } from "@/lib/logger";
import {
  runEnforcerTick,
  processPrerollSchedules,
  initializeMaintenanceEnforcer,
  initializePrerollEnforcer,
  _resetForTesting,
} from "@/lib/maintenance/enforcer";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findMany: vi.fn() },
    blackoutSchedule: { findMany: vi.fn() },
    prerollSchedule: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
    mediaItem: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({ createMediaServerClient: vi.fn() }));

type Client = ReturnType<typeof createMediaServerClient>;

const SERVER = { id: "srv1", type: "PLEX", name: "Main", url: "http://plex", accessToken: "t", tlsSkipVerify: false };

function session(sessionId: string, username = "bob", ratingKey = "1") {
  return { sessionId, username, title: "Movie", ratingKey, player: { local: true }, session: { bandwidth: 1, location: "lan" } };
}

function activeWindow() {
  return { scheduleType: "one_time", startDate: new Date(Date.now() - 60_000), endDate: new Date(Date.now() + 60_000) };
}
function pastWindow() {
  return { scheduleType: "one_time", startDate: new Date(Date.now() - 120_000), endDate: new Date(Date.now() - 60_000) };
}

function blackout(over: Record<string, unknown>) {
  return {
    id: "b1",
    userId: "u1",
    name: "Night",
    enabled: true,
    action: "terminate_immediate",
    message: "",
    delay: 0,
    excludedUsers: ["admin"],
    daysOfWeek: null,
    startTime: null,
    endTime: null,
    ...activeWindow(),
    user: { mediaServers: [SERVER] },
    ...over,
  };
}

function setBlackouts(list: unknown[]) {
  vi.mocked(prisma.blackoutSchedule.findMany).mockResolvedValue(list as never);
}

function client(over: Partial<Record<string, unknown>> = {}, initialPreroll = "") {
  // The server's preroll setting, so a clear can check what it would remove.
  let preroll = initialPreroll;
  const c = {
    getSessions: vi.fn().mockResolvedValue([]),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    getPrerollSetting: vi.fn(async () => preroll),
    setPrerollPath: vi.fn(async (path: string) => { preroll = path; }),
    clearPreroll: vi.fn(async () => { preroll = ""; }),
    ...over,
  };
  vi.mocked(createMediaServerClient).mockReturnValue(c as unknown as Client);
  return c;
}

const DEFAULT_BLACKOUT_MSG = "Stream terminated due to scheduled blackout period.";

beforeEach(() => {
  _resetForTesting();
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
  vi.mocked(prisma.blackoutSchedule.findMany).mockResolvedValue([]);
  vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.mediaItem.findMany).mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("blackout terminate_immediate", () => {
  it("terminates every non-excluded session with the default message, and logs a failed termination", async () => {
    setBlackouts([blackout({ excludedUsers: undefined })]);
    const c = client({
      getSessions: vi.fn().mockResolvedValue([session("s1"), session("s2", "carol")]),
      terminateSession: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gone")),
    });
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledWith("s1", DEFAULT_BLACKOUT_MSG);
    expect(c.terminateSession).toHaveBeenCalledWith("s2", DEFAULT_BLACKOUT_MSG);
    expect(vi.mocked(logger.error)).toHaveBeenCalledExactlyOnceWith(
      "Streams",
      'Failed to terminate session for "carol" on "Main" — Movie (session s2): Error: gone',
      { error: "Error: gone" },
    );
  });

  it("spares excluded users", async () => {
    setBlackouts([blackout({ message: "Bye" })]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1", "admin"), session("s2")]) });
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledTimes(1);
    expect(c.terminateSession).toHaveBeenCalledWith("s2", "Bye");
  });

  // As the maintenance loop does: an id-less session cannot be terminated.
  it("skips a session with no id", async () => {
    setBlackouts([blackout({})]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session(""), session("s2")]) });
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledExactlyOnceWith("s2", DEFAULT_BLACKOUT_MSG);
  });

  it("does nothing outside the window", async () => {
    setBlackouts([blackout(pastWindow())]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1")]) });
    await runEnforcerTick();
    expect(c.getSessions).not.toHaveBeenCalled();
  });

  it("logs a schedule that cannot be processed and carries on", async () => {
    setBlackouts([blackout({ user: null, name: "Broken" }), blackout({ id: "b2" })]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1")]) });
    await runEnforcerTick();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith("Enforcer", 'Error processing blackout schedule "Broken"', expect.any(Object));
    expect(c.terminateSession).toHaveBeenCalledTimes(1);
  });
});

describe("blackout warn_then_terminate", () => {
  it("warns first, terminates after the delay, and survives a failed warning and a failed termination", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    setBlackouts([blackout({ action: "warn_then_terminate", delay: 10, message: "Closing" })]);
    const notifySession = vi.fn().mockRejectedValue(new Error("no toast"));
    const terminateSession = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
    const c = client({
      getSessions: vi.fn().mockResolvedValue([session("s1"), session("x", "admin")]),
      notifySession,
      terminateSession,
    });

    await runEnforcerTick();
    expect(notifySession).toHaveBeenCalledWith("s1", "Closing");
    expect(c.terminateSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith("Enforcer", 'Blackout "Night": could not send warning', {
        error: "Error: no toast",
      }),
    );

    vi.setSystemTime(new Date("2030-01-01T12:00:11Z"));
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);

    // The entry survived the failure, so the next tick retries at once.
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledTimes(2);
    expect(notifySession).toHaveBeenCalledTimes(1);

    // Terminated: a session showing up again restarts the warning period.
    await runEnforcerTick();
    expect(notifySession).toHaveBeenCalledTimes(2);
  });

  it("defaults the delay to 30s, prunes vanished sessions, and drops entries when the window closes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2030-01-01T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    const schedule = blackout({
      action: "warn_then_terminate",
      delay: null,
      startDate: new Date(t0 - 60_000),
      endDate: new Date(t0 + 3_600_000),
    });
    setBlackouts([schedule]);
    const getSessions = vi.fn().mockResolvedValue([session("s1")]);
    const c = client({ getSessions });

    await runEnforcerTick(); // s1 pending
    getSessions.mockResolvedValue([]);
    await runEnforcerTick(); // s1 vanished → pruned
    getSessions.mockResolvedValue([session("s1")]);
    vi.setSystemTime(t0 + 31_000);
    await runEnforcerTick(); // s1 seen again: a fresh timer, no termination yet
    expect(c.terminateSession).not.toHaveBeenCalled();

    // Server unreachable: entry kept.
    getSessions.mockRejectedValueOnce(new Error("down"));
    await runEnforcerTick();
    vi.setSystemTime(t0 + 62_000);
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledTimes(1);

    // Re-arm, then end the window: the pending entry is dropped.
    await runEnforcerTick(); // s1 pending again from 62s
    setBlackouts([{ ...schedule, endDate: new Date(t0 + 61_000) }]);
    await runEnforcerTick();
    setBlackouts([schedule]);
    vi.setSystemTime(t0 + 93_000); // an entry kept from 62s would now be overdue
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledTimes(1);
  });
});

describe("blackout warn_then_terminate, id-less sessions", () => {
  it("neither warns nor terminates a session with no id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    setBlackouts([blackout({ action: "warn_then_terminate", delay: 10 })]);
    const notifySession = vi.fn().mockResolvedValue(undefined);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session(""), session("s2")]), notifySession });

    await runEnforcerTick();
    vi.setSystemTime(new Date("2030-01-01T12:00:11Z"));
    await runEnforcerTick();
    expect(notifySession).toHaveBeenCalledExactlyOnceWith("s2", DEFAULT_BLACKOUT_MSG);
    expect(c.terminateSession).toHaveBeenCalledExactlyOnceWith("s2", DEFAULT_BLACKOUT_MSG);
  });
});

describe("blackout block_new_only", () => {
  it("skips a new session with no id", async () => {
    setBlackouts([blackout({ action: "block_new_only" })]);
    const getSessions = vi.fn().mockResolvedValue([session("old")]);
    const c = client({ getSessions });

    await runEnforcerTick(); // snapshot {old}
    getSessions.mockResolvedValue([session("old"), session("", "carol", "2"), session("new")]);
    await runEnforcerTick();
    expect(c.terminateSession).toHaveBeenCalledExactlyOnceWith("new", DEFAULT_BLACKOUT_MSG);
  });

  it("re-snapshots after the window closes and logs a failed termination; excluded users are spared", async () => {
    const schedule = blackout({ action: "block_new_only" });
    setBlackouts([schedule]);
    const getSessions = vi.fn().mockResolvedValue([session("old")]);
    const terminateSession = vi.fn().mockRejectedValue(new Error("nope"));
    client({ getSessions, terminateSession });

    await runEnforcerTick(); // snapshot {old}
    getSessions.mockResolvedValue([session("old"), session("new"), session("vip", "admin")]);
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledTimes(1);
    expect(terminateSession).toHaveBeenCalledWith("new", DEFAULT_BLACKOUT_MSG);
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);

    // Window closes: snapshot dropped. When it reopens, "new" is grandfathered.
    setBlackouts([{ ...schedule, ...pastWindow() }]);
    await runEnforcerTick();
    setBlackouts([schedule]);
    await runEnforcerTick();
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledTimes(1);
  });

  it("forgets snapshots of a deleted schedule", async () => {
    const schedule = blackout({ action: "block_new_only" });
    setBlackouts([schedule]);
    const getSessions = vi.fn().mockResolvedValue([session("a")]);
    const terminateSession = vi.fn().mockResolvedValue(undefined);
    client({ getSessions, terminateSession });

    await runEnforcerTick(); // snapshot {a}
    setBlackouts([]);
    await runEnforcerTick(); // schedule deleted → snapshot gone
    getSessions.mockResolvedValue([session("a"), session("b")]);
    setBlackouts([schedule]);
    await runEnforcerTick(); // fresh snapshot {a, b}
    expect(terminateSession).not.toHaveBeenCalled();
  });
});

describe("maintenance loop edge cases", () => {
  function maintenance(over: Record<string, unknown> = {}) {
    return {
      maintenanceMode: true,
      maintenanceDelay: null,
      maintenanceMessage: "",
      maintenanceExcludedUsers: [],
      transcodeManagerEnabled: false,
      transcodeManagerDelay: null,
      transcodeManagerMessage: "",
      transcodeManagerCriteria: null,
      transcodeManagerExcludedUsers: [],
      transcodeManagerExemptHardware: null,
      userId: "u1",
      user: { mediaServers: [SERVER] },
      ...over,
    };
  }

  it("skips id-less sessions, uses the default message and delay, and logs a failed termination", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2030-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenance()] as never);
    const terminateSession = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue(undefined);
    const getSessions = vi.fn().mockResolvedValue([session(""), session("s1")]);
    client({ getSessions, terminateSession });

    await runEnforcerTick();
    expect(terminateSession).not.toHaveBeenCalled();
    vi.setSystemTime(t0 + 30_000);
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledWith("s1", "Server is in maintenance mode.");
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1);
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledTimes(2);
  });

  it("prunes a vanished session and drops maintenance entries when maintenance is turned off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2030-01-01T00:00:00Z").getTime();
    vi.setSystemTime(t0);
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenance({ maintenanceDelay: 10 })] as never);
    // A blackout entry is pending at the same time: the maintenance prune must skip it.
    setBlackouts([
      blackout({
        action: "warn_then_terminate",
        delay: 600,
        excludedUsers: [],
        startDate: new Date(t0 - 60_000),
        endDate: new Date(t0 + 3_600_000),
      }),
    ]);
    const getSessions = vi.fn().mockResolvedValue([session("s1")]);
    const terminateSession = vi.fn().mockResolvedValue(undefined);
    client({ getSessions, terminateSession });

    await runEnforcerTick(); // maint + blackout pending
    getSessions.mockResolvedValue([]);
    await runEnforcerTick(); // s1 gone → maint entry pruned
    getSessions.mockResolvedValue([session("s1")]);
    vi.setSystemTime(t0 + 11_000);
    await runEnforcerTick(); // fresh grace period, no termination
    expect(terminateSession).not.toHaveBeenCalled();

    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    vi.setSystemTime(t0 + 12_000);
    await runEnforcerTick(); // maintenance off → maint entries dropped
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenance({ maintenanceDelay: 10 })] as never);
    vi.setSystemTime(t0 + 22_000); // an entry kept from 11s would now be overdue
    await runEnforcerTick(); // fresh timer again
    expect(terminateSession).not.toHaveBeenCalled();

    // Neither maintenance prune touched the blackout's entry (re-armed at 11s,
    // when s1 came back): with maintenance off it fires exactly 600s later,
    // where an entry restarted at 12s or 22s would still be waiting.
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    vi.setSystemTime(t0 + 611_000);
    await runEnforcerTick();
    expect(terminateSession).toHaveBeenCalledExactlyOnceWith("s1", DEFAULT_BLACKOUT_MSG);
  });

  it("logs a failed tick and lets the next one run", async () => {
    vi.mocked(prisma.appSettings.findMany).mockRejectedValueOnce(new Error("db down"));
    await runEnforcerTick();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith("Enforcer", "Error in enforcer", { error: "Error: db down" });
    await runEnforcerTick();
    expect(prisma.appSettings.findMany).toHaveBeenCalledTimes(2);
  });

  it("ignores a tick that starts while one is still running", async () => {
    let release!: (v: never[]) => void;
    vi.mocked(prisma.appSettings.findMany).mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    const first = runEnforcerTick();
    await runEnforcerTick();
    expect(prisma.appSettings.findMany).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });
});

describe("preroll edge cases", () => {
  function prerollSchedule(over: Record<string, unknown> = {}) {
    return {
      id: "p1",
      userId: "u1",
      name: "Holiday",
      prerollPath: "/pre.mp4",
      priority: 0,
      enabled: true,
      daysOfWeek: null,
      startTime: null,
      endTime: null,
      ...activeWindow(),
      user: { id: "u1", mediaServers: [SERVER] },
      ...over,
    };
  }

  it("clears the preroll when the user's schedules are all outside their window", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule()] as never);
    const c = client();
    await processPrerollSchedules();
    expect(c.setPrerollPath).toHaveBeenCalledWith("/pre.mp4");

    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule(pastWindow())] as never);
    await processPrerollSchedules();
    expect(c.clearPreroll).toHaveBeenCalledTimes(1);

    // Cached as cleared: nothing more to do.
    await processPrerollSchedules();
    expect(c.clearPreroll).toHaveBeenCalledTimes(1);
  });

  it("leaves a preroll set by hand alone when no schedule is active", async () => {
    // After a restart the enforcer has no record of what it set. Clearing then
    // wiped whatever preroll the server had, including one set in Plex itself.
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule(pastWindow())] as never);
    const c = client({}, "/my-own-intro.mp4");
    await processPrerollSchedules();
    expect(c.clearPreroll).not.toHaveBeenCalled();
  });

  it("after a restart still clears a preroll one of the schedules set", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule(pastWindow())] as never);
    const c = client({}, "/pre.mp4");
    await processPrerollSchedules();
    expect(c.clearPreroll).toHaveBeenCalledTimes(1);
  });

  it("groups several schedules of one user and applies the first active one", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([
      prerollSchedule({ id: "a", prerollPath: "/old.mp4", ...pastWindow() }),
      prerollSchedule({ id: "b", prerollPath: "/now.mp4" }),
    ] as never);
    const c = client();
    await processPrerollSchedules();
    expect(c.setPrerollPath).toHaveBeenCalledTimes(1);
    expect(c.setPrerollPath).toHaveBeenCalledWith("/now.mp4");
  });

  it("tolerates a server that cannot clear once the last schedule is gone", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule()] as never);
    client();
    await processPrerollSchedules();

    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ mediaServers: [SERVER] } as never);
    vi.mocked(createMediaServerClient).mockImplementation(() => {
      throw new Error("bad url");
    });
    await processPrerollSchedules();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith("Enforcer", "Preroll: could not clear on server", { error: "Error: bad url" });

    // Recorded as cleared regardless, so it is not retried.
    await processPrerollSchedules();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("records the clear even when the user no longer exists", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([prerollSchedule()] as never);
    client();
    await processPrerollSchedules();
    vi.mocked(prisma.prerollSchedule.findMany).mockResolvedValue([]);
    await processPrerollSchedules();
    await processPrerollSchedules();
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("logs a failed run and does not overlap runs", async () => {
    vi.mocked(prisma.prerollSchedule.findMany).mockRejectedValueOnce(new Error("db"));
    await processPrerollSchedules();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith("Enforcer", "Error processing preroll schedules", { error: "Error: db" });

    let release!: (v: never[]) => void;
    vi.mocked(prisma.prerollSchedule.findMany).mockReturnValueOnce(new Promise((r) => (release = r)) as never);
    const first = processPrerollSchedules();
    await processPrerollSchedules();
    expect(prisma.prerollSchedule.findMany).toHaveBeenCalledTimes(2);
    release([]);
    await first;
  });
});

describe("one session poll per server per tick", () => {
  const maintenanceOn = {
    maintenanceMode: true,
    maintenanceDelay: 0,
    maintenanceMessage: "Maintenance",
    maintenanceExcludedUsers: ["vip"],
    transcodeManagerEnabled: false,
    transcodeManagerDelay: null,
    transcodeManagerMessage: "",
    transcodeManagerCriteria: null,
    transcodeManagerExcludedUsers: [],
    transcodeManagerExemptHardware: null,
    userId: "u1",
    user: { mediaServers: [SERVER] },
  };

  it("asks each server for its sessions once, however many loops read them", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenanceOn] as never);
    setBlackouts([
      blackout({ id: "b1", excludedUsers: [] }),
      blackout({ id: "b2", action: "warn_then_terminate", delay: 60, excludedUsers: [] }),
      blackout({ id: "b3", action: "block_new_only", excludedUsers: [] }),
    ]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1", "vip")]) });

    await runEnforcerTick();

    expect(c.getSessions).toHaveBeenCalledTimes(1);
    expect(createMediaServerClient).toHaveBeenCalledTimes(1);
    // Maintenance spares the VIP; the first blackout stops the stream.
    expect(c.terminateSession).toHaveBeenCalledExactlyOnceWith("s1", DEFAULT_BLACKOUT_MSG);
  });

  it("never stops a session twice in one tick, or lets a later loop count it", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenanceOn] as never);
    setBlackouts([
      blackout({ id: "b1", excludedUsers: [] }),
      blackout({ id: "b2", action: "block_new_only", excludedUsers: [] }),
    ]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1"), session("s2", "vip")]) });

    await runEnforcerTick();

    // s1: stopped by maintenance and by nothing else; s2: by the first blackout.
    expect(c.terminateSession.mock.calls).toEqual([
      ["s1", "Maintenance"],
      ["s2", DEFAULT_BLACKOUT_MSG],
    ]);
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();

    // The block_new_only snapshot taken that tick grandfathered neither:
    // both were already stopped, so if s1's device comes back with the same
    // session and title, it is a new stream.
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([]);
    setBlackouts([blackout({ id: "b2", action: "block_new_only", excludedUsers: [] })]);
    c.terminateSession.mockClear();
    await runEnforcerTick();
    expect(c.terminateSession.mock.calls).toEqual([
      ["s1", DEFAULT_BLACKOUT_MSG],
      ["s2", DEFAULT_BLACKOUT_MSG],
    ]);
  });

  it("treats a server that could not be asked as unreachable in every loop of the tick", async () => {
    vi.mocked(prisma.appSettings.findMany).mockResolvedValue([maintenanceOn] as never);
    setBlackouts([blackout({ id: "b1", excludedUsers: [] })]);
    const c = client({ getSessions: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });

    await runEnforcerTick();

    expect(c.getSessions).toHaveBeenCalledTimes(1);
    expect(c.terminateSession).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      "Enforcer",
      'Blackout "Night": could not reach server',
      { error: "Error: ECONNREFUSED" },
    );
  });

  it("polls afresh on the next tick", async () => {
    setBlackouts([blackout({ id: "b1", excludedUsers: ["bob"] })]);
    const c = client({ getSessions: vi.fn().mockResolvedValue([session("s1")]) });

    await runEnforcerTick();
    await runEnforcerTick();

    expect(c.getSessions).toHaveBeenCalledTimes(2);
  });
});

describe("initializers", () => {
  it("start one 30s interval each, only once", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setInterval");
    initializeMaintenanceEnforcer();
    initializeMaintenanceEnforcer();
    initializePrerollEnforcer();
    initializePrerollEnforcer();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([30000, 30000]);

    await vi.advanceTimersByTimeAsync(30000);
    expect(prisma.appSettings.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.prerollSchedule.findMany).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
    spy.mockRestore();
  });
});
