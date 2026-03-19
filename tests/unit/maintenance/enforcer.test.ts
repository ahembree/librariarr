import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetSessions = vi.fn().mockResolvedValue([]);
const mockTerminateSession = vi.fn().mockResolvedValue(undefined);
const mockSetPrerollPath = vi.fn().mockResolvedValue(undefined);
const mockClearPreroll = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    blackoutSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    prerollSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    getSessions: mockGetSessions,
    terminateSession: mockTerminateSession,
    setPrerollPath: mockSetPrerollPath,
    clearPreroll: mockClearPreroll,
  })),
}));

// ---------------------------------------------------------------------------
// The enforcer uses module-level `let initialized = false` to guard
// against double-init. We need a fresh module for each test that calls
// initializeMaintenanceEnforcer. For the interval-based tests we manually
// trigger the callback captured by our fake setInterval.
// ---------------------------------------------------------------------------

describe("initializeMaintenanceEnforcer", () => {
  let intervalCallback: (() => Promise<void>) | null = null;
  let realSetInterval: typeof globalThis.setInterval;

  beforeEach(() => {
    vi.restoreAllMocks();
    intervalCallback = null;
    realSetInterval = globalThis.setInterval;

    // Capture the callback passed to setInterval
    vi.stubGlobal("setInterval", (cb: () => Promise<void>, _ms: number) => {
      intervalCallback = cb;
      return 999 as unknown as ReturnType<typeof setInterval>;
    });

    mockGetSessions.mockResolvedValue([]);
    mockTerminateSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
  });

  it("terminates sessions immediately when maintenance is enabled and delay has elapsed", async () => {
    // Need a fresh module to reset `initialized`
    vi.resetModules();

    // Re-apply mocks after resetModules
    vi.doMock("@/lib/db", () => ({
      prisma: {
        appSettings: {
          findMany: vi.fn().mockResolvedValue([
            {
              maintenanceMode: true,
              maintenanceDelay: 0, // immediate
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
          ]),
        },
        blackoutSchedule: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        prerollSchedule: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        user: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      },
    }));

    const localGetSessions = vi.fn().mockResolvedValue([
      {
        sessionId: "sess1",
        username: "bob",
        title: "Movie A",
        player: { local: true },
        session: { bandwidth: 1000, location: "lan" },
      },
    ]);
    const localTerminate = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/media-server/factory", () => ({
      createMediaServerClient: vi.fn(() => ({
        getSessions: localGetSessions,
        terminateSession: localTerminate,
        setPrerollPath: vi.fn(),
        clearPreroll: vi.fn(),
      })),
    }));

    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");

    initializeMaintenanceEnforcer();
    expect(intervalCallback).not.toBeNull();

    // First call: session is first-seen, pending termination added
    await intervalCallback!();
    // With delay 0, the session should be terminated on the first check
    // since firstSeen = now and now - firstSeen >= 0
    expect(localTerminate).toHaveBeenCalledWith("sess1", "Down for maintenance");
  });

  it("excludes users in maintenanceExcludedUsers", async () => {
    vi.resetModules();

    vi.doMock("@/lib/db", () => ({
      prisma: {
        appSettings: {
          findMany: vi.fn().mockResolvedValue([
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
          ]),
        },
        blackoutSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        prerollSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      },
    }));

    const localTerminate = vi.fn();

    vi.doMock("@/lib/media-server/factory", () => ({
      createMediaServerClient: vi.fn(() => ({
        getSessions: vi.fn().mockResolvedValue([
          {
            sessionId: "sess1",
            username: "admin", // excluded
            title: "Movie A",
            player: { local: true },
            session: { bandwidth: 1000, location: "lan" },
          },
        ]),
        terminateSession: localTerminate,
        setPrerollPath: vi.fn(),
        clearPreroll: vi.fn(),
      })),
    }));

    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");

    initializeMaintenanceEnforcer();
    await intervalCallback!();

    expect(localTerminate).not.toHaveBeenCalled();
  });

  it("does nothing when no settings have maintenance or transcode enabled", async () => {
    vi.resetModules();

    vi.doMock("@/lib/db", () => ({
      prisma: {
        appSettings: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        blackoutSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        prerollSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      },
    }));

    vi.doMock("@/lib/media-server/factory", () => ({
      createMediaServerClient: vi.fn(),
    }));

    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { createMediaServerClient } = await import("@/lib/media-server/factory");
    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");

    initializeMaintenanceEnforcer();
    await intervalCallback!();

    expect(createMediaServerClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test sessionMatchesCriteria logic via transcode manager path
// ---------------------------------------------------------------------------

describe("transcode manager criteria (via enforcer)", () => {
  let intervalCallback: (() => Promise<void>) | null = null;
  let realSetInterval: typeof globalThis.setInterval;

  beforeEach(() => {
    intervalCallback = null;
    realSetInterval = globalThis.setInterval;
    vi.stubGlobal("setInterval", (cb: () => Promise<void>, _ms: number) => {
      intervalCallback = cb;
      return 999 as unknown as ReturnType<typeof setInterval>;
    });
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
  });

  it("terminates video transcoding session when videoTranscoding criteria is set", async () => {
    vi.resetModules();

    vi.doMock("@/lib/db", () => ({
      prisma: {
        appSettings: {
          findMany: vi.fn().mockResolvedValue([
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
          ]),
        },
        blackoutSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        prerollSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      },
    }));

    const localTerminate = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/media-server/factory", () => ({
      createMediaServerClient: vi.fn(() => ({
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
      })),
    }));

    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");
    initializeMaintenanceEnforcer();
    await intervalCallback!();

    expect(localTerminate).toHaveBeenCalledWith("sess-transcode", "No transcoding");
  });

  it("does NOT terminate direct play session when videoTranscoding criteria is set", async () => {
    vi.resetModules();

    vi.doMock("@/lib/db", () => ({
      prisma: {
        appSettings: {
          findMany: vi.fn().mockResolvedValue([
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
          ]),
        },
        blackoutSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        prerollSchedule: { findMany: vi.fn().mockResolvedValue([]) },
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      },
    }));

    const localTerminate = vi.fn();

    vi.doMock("@/lib/media-server/factory", () => ({
      createMediaServerClient: vi.fn(() => ({
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
      })),
    }));

    vi.doMock("@/lib/logger", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initializeMaintenanceEnforcer } = await import("@/lib/maintenance/enforcer");
    initializeMaintenanceEnforcer();
    await intervalCallback!();

    expect(localTerminate).not.toHaveBeenCalled();
  });
});
