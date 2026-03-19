import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { runEnforcerTick, _resetForTesting } from "@/lib/maintenance/enforcer";

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
});
