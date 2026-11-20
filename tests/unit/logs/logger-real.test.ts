import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The real logger is exercised here; only its DB client is replaced.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { logEntry: { create: createMock } } }));

import { logger, apiLogger, dbLogger, logLine, MAX_LOG_MESSAGE_LENGTH } from "@/lib/logger";

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

  // Messages carry text the app did not write (a media title, an identity
  // provider's `error` parameter on an unauthenticated callback).
  it("writes a message with line breaks as one line, on the console and in the row", async () => {
    await apiLogger.warn("Auth", 'OIDC provider returned error: x\n[2026-01-01T00:00:00.000Z] [Auth] Local login: "admin"\r\n\u2028end');
    const expected = 'OIDC provider returned error: x [2026-01-01T00:00:00.000Z] [Auth] Local login: "admin" end';
    expect(warn).toHaveBeenCalledWith(expect.any(String), expected, "");
    expect(createMock).toHaveBeenCalledWith({
      data: { level: "WARN", category: "API", source: "Auth", message: expected, meta: undefined },
    });
  });

  it("cuts an over-long message and leaves meta alone", async () => {
    await logger.info("Sync", "x".repeat(MAX_LOG_MESSAGE_LENGTH + 500), { note: "line one\nline two" });
    const message = createMock.mock.calls[0][0].data.message as string;
    expect(message).toHaveLength(MAX_LOG_MESSAGE_LENGTH + 1);
    expect(message.endsWith("…")).toBe(true);
    expect(createMock.mock.calls[0][0].data.meta).toEqual({ note: "line one\nline two" });
  });

  // The TRaSH sync names every custom format it applied; a refused execution
  // every id. A cap low enough to cut those cut the record itself.
  it("keeps a long line the app wrote on purpose whole", async () => {
    const applied = Array.from({ length: 300 }, (_, i) => `Custom Format ${i}=updated`).join(", ");
    expect(applied.length).toBeGreaterThan(6000);
    await logger.info("TrashSync", `Applied sync to RADARR "Movies": ${applied}`);
    expect(createMock.mock.calls[0][0].data.message).toBe(`Applied sync to RADARR "Movies": ${applied}`);
    expect(MAX_LOG_MESSAGE_LENGTH).toBeGreaterThanOrEqual(32_000);
  });

  // A catch block logging the `message` of something that was not an Error.
  it("logs a message that is not a string instead of throwing", async () => {
    const notAString = undefined as unknown as string;
    await expect(logger.warn("X", notAString)).resolves.toBeUndefined();
    await logger.error("X", { toString: () => "an object" } as unknown as string);
    await logger.info("X", 42 as unknown as string);
    expect(createMock.mock.calls.map(([arg]) => arg.data.message)).toEqual(["", "an object", "42"]);
    expect(logLine(null)).toBe("");
  });

  it("logLine leaves an ordinary message untouched", () => {
    expect(logLine('Local login: "admin" — ünïcödé ✓')).toBe('Local login: "admin" — ünïcödé ✓');
    expect(logLine("tab\there\u0000nul\u009fc1")).toBe("tab here nul c1");
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
