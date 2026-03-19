import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before imports
vi.mock("@/lib/db", () => ({
  prisma: {
    syncJob: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    appSettings: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    logEntry: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    lifecycleAction: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

vi.mock("@/lib/sync/sync-server", () => ({
  syncMediaServer: vi.fn(),
}));

vi.mock("@/lib/lifecycle/processor", () => ({
  processLifecycleRules: vi.fn(),
  executeLifecycleActions: vi.fn(),
}));

vi.mock("@/lib/backup/backup-service", () => ({
  createBackup: vi.fn(),
  getBackupPassphrase: vi.fn(),
  pruneBackups: vi.fn(),
}));

import { getSystemTimezone, presetToCron } from "@/lib/scheduler/scheduler";

// ---------------------------------------------------------------------------
// getSystemTimezone
// ---------------------------------------------------------------------------

describe("getSystemTimezone", () => {
  const origTZ = process.env.TZ;

  beforeEach(() => {
    if (origTZ !== undefined) {
      process.env.TZ = origTZ;
    } else {
      delete process.env.TZ;
    }
  });

  it("returns TZ env var when set", () => {
    process.env.TZ = "America/New_York";
    expect(getSystemTimezone()).toBe("America/New_York");
  });

  it("falls back to Intl timezone when TZ is not set", () => {
    delete process.env.TZ;
    const tz = getSystemTimezone();
    // Should be a valid IANA timezone string
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// presetToCron
// ---------------------------------------------------------------------------

describe("presetToCron", () => {
  it("returns null for MANUAL preset", () => {
    expect(presetToCron("MANUAL", "03:00")).toBeNull();
  });

  it("returns null for unknown preset", () => {
    expect(presetToCron("UNKNOWN_PRESET", "03:00")).toBeNull();
  });

  it("converts DAILY to correct cron", () => {
    expect(presetToCron("DAILY", "03:30")).toBe("30 3 * * *");
  });

  it("converts DAILY at midnight", () => {
    expect(presetToCron("DAILY", "00:00")).toBe("0 0 * * *");
  });

  it("converts EVERY_12H to two runs 12 hours apart", () => {
    const result = presetToCron("EVERY_12H", "02:15");
    expect(result).toBe("15 2,14 * * *");
  });

  it("converts EVERY_12H wrapping around midnight", () => {
    const result = presetToCron("EVERY_12H", "14:00");
    expect(result).toBe("0 14,2 * * *");
  });

  it("converts EVERY_6H to four runs 6 hours apart", () => {
    const result = presetToCron("EVERY_6H", "00:00");
    expect(result).toBe("0 0,6,12,18 * * *");
  });

  it("converts EVERY_6H with offset", () => {
    const result = presetToCron("EVERY_6H", "03:45");
    expect(result).toBe("45 3,9,15,21 * * *");
  });

  it("converts WEEKLY to Monday", () => {
    const result = presetToCron("WEEKLY", "05:00");
    expect(result).toBe("0 5 * * 1");
  });
});
