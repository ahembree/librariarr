import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real logger is exercised here; only its DB client is replaced.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { logEntry: { create: createMock } } }));

import { logger, apiLogger, dbLogger } from "@/lib/logger";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("logger (real module)", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({});
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes INFO to console.log and persists it under the BACKEND category", async () => {
    await logger.info("Sync", "started", { serverId: "s1" });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[.+\] \[Sync\]$/), "started", { serverId: "s1" });
    expect(createMock).toHaveBeenCalledWith({
      data: { level: "INFO", category: "BACKEND", source: "Sync", message: "started", meta: { serverId: "s1" } },
    });
  });

  it("routes WARN and ERROR to their console methods and records the category per logger", async () => {
    await apiLogger.warn("Route", "slow");
    await dbLogger.error("Prisma", "boom", { code: "P1001" });
    expect(warn).toHaveBeenCalledWith(expect.any(String), "slow", "");
    expect(error).toHaveBeenCalledWith(expect.any(String), "boom", { code: "P1001" });
    expect(createMock).toHaveBeenNthCalledWith(1, {
      data: { level: "WARN", category: "API", source: "Route", message: "slow", meta: undefined },
    });
    expect(createMock).toHaveBeenNthCalledWith(2, {
      data: { level: "ERROR", category: "DB", source: "Prisma", message: "boom", meta: { code: "P1001" } },
    });
  });

  it("skips DEBUG entirely (console and DB) unless LOG_DEBUG is true", async () => {
    vi.stubEnv("LOG_DEBUG", "false");
    await logger.debug("X", "hidden");
    expect(debug).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("prints and persists DEBUG when LOG_DEBUG is true", async () => {
    vi.stubEnv("LOG_DEBUG", "true");
    await apiLogger.debug("X", "shown");
    await apiLogger.debug("X", "with meta", { a: 1 });
    expect(debug).toHaveBeenLastCalledWith(expect.any(String), "with meta", { a: 1 });
    expect(debug).toHaveBeenNthCalledWith(1, expect.any(String), "shown", "");
    expect(createMock).toHaveBeenCalledWith({
      data: { level: "DEBUG", category: "API", source: "X", message: "shown", meta: undefined },
    });
  });

  it("swallows a failed DB write", async () => {
    createMock.mockRejectedValue(new Error("db down"));
    await expect(logger.error("X", "msg")).resolves.toBeUndefined();
    await flush();
    // The write was attempted and failed without a second report or an
    // unhandled rejection (which would fail the run).
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
