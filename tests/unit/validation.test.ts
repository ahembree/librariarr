import { describe, it, expect } from "vitest";
import {
  validateRequest,
  authLoginSchema,
  serverAddSchema,
  maintenanceSchema,
  authSetupSchema,
  arrInstanceCreateSchema,
  syncScheduleSchema,
  logRetentionSchema,
  terminateSessionSchema,
} from "@/lib/validation";

/**
 * Helper: create a mock Request with JSON body.
 */
function makeRequest(body: unknown): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Helper: create a mock Request with an invalid (non-JSON) body.
 */
function makeBadRequest(body: string): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
}

describe("validateRequest", () => {
  describe("with valid input", () => {
    it("returns data on success", async () => {
      const req = makeRequest({ username: "admin", password: "secret" });
      const result = await validateRequest(req, authLoginSchema);

      expect(result.data).toEqual({ username: "admin", password: "secret" });
      expect(result.error).toBeUndefined();
    });
  });

  describe("with invalid JSON", () => {
    it("returns error with status 400 for malformed JSON", async () => {
      const req = makeBadRequest("not valid json {{{");
      const result = await validateRequest(req, authLoginSchema);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(400);

      const body = await result.error!.json();
      expect(body.error).toBe("Invalid JSON in request body");
    });

    it("returns error for empty body", async () => {
      const req = makeBadRequest("");
      const result = await validateRequest(req, authLoginSchema);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(400);
    });
  });

  describe("with validation failures", () => {
    it("returns error with status 400 for missing required fields", async () => {
      const req = makeRequest({});
      const result = await validateRequest(req, authLoginSchema);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(400);

      const body = await result.error!.json();
      expect(body.error).toBe("Validation failed");
      expect(body.details).toBeDefined();
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details.length).toBeGreaterThan(0);
    });

    it("returns error for wrong types", async () => {
      const req = makeRequest({ username: 123, password: true });
      const result = await validateRequest(req, authLoginSchema);

      expect(result.data).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error!.status).toBe(400);
    });
  });
});

describe("authLoginSchema", () => {
  it("accepts valid credentials", () => {
    const result = authLoginSchema.safeParse({
      username: "admin",
      // file deepcode ignore NoHardcodedPasswords/test: test file
      password: "password123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty username", () => {
    const result = authLoginSchema.safeParse({
      username: "",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = authLoginSchema.safeParse({
      username: "admin",
      password: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing username", () => {
    const result = authLoginSchema.safeParse({
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing password", () => {
    const result = authLoginSchema.safeParse({
      username: "admin",
    });
    expect(result.success).toBe(false);
  });
});

describe("authSetupSchema", () => {
  it("accepts valid setup data", () => {
    const result = authSetupSchema.safeParse({
      username: "admin",
      password: "securepassword",
    });
    expect(result.success).toBe(true);
  });

  it("rejects username shorter than 3 characters", () => {
    const result = authSetupSchema.safeParse({
      username: "ab",
      password: "securepassword",
    });
    expect(result.success).toBe(false);
  });

  it("rejects password shorter than 8 characters", () => {
    const result = authSetupSchema.safeParse({
      username: "admin",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("accepts username with exactly 3 characters", () => {
    const result = authSetupSchema.safeParse({
      username: "abc",
      password: "12345678",
    });
    expect(result.success).toBe(true);
  });

  it("accepts password with exactly 8 characters", () => {
    const result = authSetupSchema.safeParse({
      username: "admin",
      password: "12345678",
    });
    expect(result.success).toBe(true);
  });
});

describe("serverAddSchema", () => {
  it("accepts valid server data with required fields", () => {
    const result = serverAddSchema.safeParse({
      url: "http://plex.local:32400",
      // file deepcode ignore HardcodedNonCryptoSecret/test: Test file with hardcoded values to run validation tests
      accessToken: "abc123token",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid server data with all optional fields", () => {
    const result = serverAddSchema.safeParse({
      name: "My Plex",
      url: "http://plex.local:32400",
      accessToken: "abc123token",
      machineId: "machine-123",
      tlsSkipVerify: true,
      type: "plex",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing url", () => {
    const result = serverAddSchema.safeParse({
      accessToken: "abc123token",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty url", () => {
    const result = serverAddSchema.safeParse({
      url: "",
      accessToken: "abc123token",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing accessToken", () => {
    const result = serverAddSchema.safeParse({
      url: "http://plex.local:32400",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty accessToken", () => {
    const result = serverAddSchema.safeParse({
      url: "http://plex.local:32400",
      accessToken: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("arrInstanceCreateSchema", () => {
  it("accepts valid Arr instance data", () => {
    const result = arrInstanceCreateSchema.safeParse({
      name: "Radarr",
      url: "http://radarr:7878",
      apiKey: "radarr-api-key",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = arrInstanceCreateSchema.safeParse({
      url: "http://radarr:7878",
      apiKey: "radarr-api-key",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL", () => {
    const result = arrInstanceCreateSchema.safeParse({
      name: "Radarr",
      url: "not-a-url",
      apiKey: "radarr-api-key",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty API key", () => {
    const result = arrInstanceCreateSchema.safeParse({
      name: "Radarr",
      url: "http://radarr:7878",
      apiKey: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("maintenanceSchema", () => {
  it("accepts enabled with no optional fields", () => {
    const result = maintenanceSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("accepts disabled with no optional fields", () => {
    const result = maintenanceSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const result = maintenanceSchema.safeParse({
      enabled: true,
      message: "System maintenance in progress",
      delay: 30,
      discordNotifyMaintenance: true,
      excludedUsers: ["user1", "user2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing enabled field", () => {
    const result = maintenanceSchema.safeParse({
      message: "Maintenance",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    const result = maintenanceSchema.safeParse({
      enabled: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects excludedUsers with non-string elements", () => {
    const result = maintenanceSchema.safeParse({
      enabled: true,
      excludedUsers: [123, 456],
    });
    expect(result.success).toBe(false);
  });
});

describe("syncScheduleSchema", () => {
  it("accepts a valid cron schedule", () => {
    const result = syncScheduleSchema.safeParse({
      syncSchedule: "0 */6 * * *",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty schedule", () => {
    const result = syncScheduleSchema.safeParse({
      syncSchedule: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing schedule", () => {
    const result = syncScheduleSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("logRetentionSchema", () => {
  it("accepts valid retention days", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 30 });
    expect(result.success).toBe(true);
  });

  it("accepts minimum value (1)", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts maximum value (365)", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 365 });
    expect(result.success).toBe(true);
  });

  it("rejects zero", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects values over 365", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 366 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer values", () => {
    const result = logRetentionSchema.safeParse({ logRetentionDays: 30.5 });
    expect(result.success).toBe(false);
  });
});

describe("terminateSessionSchema", () => {
  it("accepts valid session termination with required fields", () => {
    const result = terminateSessionSchema.safeParse({
      serverId: "server-123",
      message: "Maintenance starting",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional sessionIds array", () => {
    const result = terminateSessionSchema.safeParse({
      serverId: "server-123",
      sessionIds: ["sess-1", "sess-2"],
      message: "Stopping playback",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty serverId", () => {
    const result = terminateSessionSchema.safeParse({
      serverId: "",
      message: "Stopping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = terminateSessionSchema.safeParse({
      serverId: "server-123",
      message: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing serverId", () => {
    const result = terminateSessionSchema.safeParse({
      message: "Stopping",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const result = terminateSessionSchema.safeParse({
      serverId: "server-123",
    });
    expect(result.success).toBe(false);
  });
});
