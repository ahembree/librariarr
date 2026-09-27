import { describe, it, expect } from "vitest";
import {
  validateRequest,
  authLoginSchema,
  authSettingsSchema,
  serverAddSchema,
  maintenanceSchema,
  authSetupSchema,
  arrInstanceCreateSchema,
  seerrInstanceCreateSchema,
  seerrInstanceUpdateSchema,
  syncScheduleSchema,
  logRetentionSchema,
  terminateSessionSchema,
  syncCancelSchema,
  apiKeyCreateSchema,
  actionExecuteSchema,
  exceptionCreateSchema,
  exceptionBulkDeleteSchema,
  MAX_EXCEPTION_IDS_PER_REQUEST,
  exceptionBulkUpdateSchema,
  discordSettingsSchema,
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

  // A bare URL check accepts "radarr.lan:7878" (scheme "radarr.lan:"), which
  // stores a link the browser cannot open — nothing tests an external URL.
  it.each(["radarr.lan:7878", "localhost:7878", "ftp://radarr.lan"])(
    "rejects an external URL without http(s): %s",
    (externalUrl) => {
      for (const schema of [arrInstanceCreateSchema, seerrInstanceCreateSchema]) {
        const result = schema.safeParse({ name: "X", url: "http://x:1", apiKey: "k", externalUrl });
        expect(result.success).toBe(false);
      }
      expect(seerrInstanceUpdateSchema.safeParse({ externalUrl }).success).toBe(false);
    },
  );

  it.each(["https://radarr.example.com", "http://10.0.0.5:7878/", ""])(
    "accepts an http(s) external URL, or empty to clear it: %s",
    (externalUrl) => {
      for (const schema of [arrInstanceCreateSchema, seerrInstanceCreateSchema]) {
        const result = schema.safeParse({ name: "X", url: "http://x:1", apiKey: "k", externalUrl });
        expect(result.success).toBe(true);
      }
      expect(seerrInstanceUpdateSchema.safeParse({ externalUrl }).success).toBe(true);
    },
  );
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

  it("accepts the session ids each server type issues", () => {
    const ids = [
      "e3lqr5a10p6lsqyqtmzhjycv", // Plex Session.id
      "42", // Plex sessionKey fallback
      "2c94b1c2d9b14c33a5dfa18b0ae6d0d2", // Jellyfin / Emby
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    ];
    const result = terminateSessionSchema.safeParse({ serverId: "s1", sessionIds: ids, message: "Bye" });
    expect(result.success).toBe(true);
  });

  // The id lands in a media-server request path sent with the admin token.
  it.each([
    ["a parent-directory segment", "../System/Shutdown?x="],
    ["a lone dot segment", ".."],
    ["a slash", "a/b"],
    ["a query", "abc?x=1"],
    ["a fragment", "abc#x"],
    ["a percent-encoding", "%2e%2e"],
    ["whitespace", "a b"],
    ["an empty id", ""],
    ["an overlong id", "a".repeat(129)],
  ])("rejects a session id with %s", (_label, id) => {
    const result = terminateSessionSchema.safeParse({ serverId: "s1", sessionIds: [id], message: "Bye" });
    expect(result.success).toBe(false);
  });
});

describe("authSettingsSchema", () => {
  it("accepts the empty object (no toggles changed)", () => {
    expect(authSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts localAuthEnabled alone", () => {
    expect(
      authSettingsSchema.safeParse({ localAuthEnabled: true }).success
    ).toBe(true);
    expect(
      authSettingsSchema.safeParse({ localAuthEnabled: false }).success
    ).toBe(true);
  });

  it("accepts plexLoginEnabled alone", () => {
    expect(
      authSettingsSchema.safeParse({ plexLoginEnabled: true }).success
    ).toBe(true);
    expect(
      authSettingsSchema.safeParse({ plexLoginEnabled: false }).success
    ).toBe(true);
  });

  it("accepts both toggles together", () => {
    expect(
      authSettingsSchema.safeParse({
        localAuthEnabled: true,
        plexLoginEnabled: false,
      }).success
    ).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(
      authSettingsSchema.safeParse({ localAuthEnabled: "yes" }).success
    ).toBe(false);
    expect(
      authSettingsSchema.safeParse({ plexLoginEnabled: 1 }).success
    ).toBe(false);
  });
});

describe("apiKeyCreateSchema", () => {
  const valid = { name: "Home Assistant", scopes: ["media:read"], expiresAt: null };

  it("accepts a never-expiring key", () => {
    expect(apiKeyCreateSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["UTC", "2030-01-01T00:00:00.000Z"],
    ["an offset", "2030-01-01T08:00:00+02:00"],
  ])("accepts an expiry in %s", (_label, expiresAt) => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, expiresAt }).success).toBe(true);
  });

  it.each([
    ["a date without a time", "2030-01-01"],
    ["a time without a zone (ambiguous)", "2030-01-01T00:00:00"],
    ["free text", "tomorrow"],
    ["a number", 1893456000000],
  ])("rejects an expiry that is %s", (_label, expiresAt) => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, expiresAt }).success).toBe(false);
  });

  it("requires expiresAt to be present (null means never)", () => {
    const { expiresAt: _omit, ...rest } = valid;
    void _omit;
    expect(apiKeyCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("trims the name before checking its length", () => {
    const parsed = apiKeyCreateSchema.safeParse({ ...valid, name: "  Dash  " });
    expect(parsed.success && parsed.data.name).toBe("Dash");
    expect(apiKeyCreateSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...valid, name: `  ${"x".repeat(64)}  ` }).success).toBe(true);
    expect(apiKeyCreateSchema.safeParse({ ...valid, name: "x".repeat(65) }).success).toBe(false);
  });

  it.each([
    ["a newline", "Dash\nboard"],
    ["a tab", "Dash\tboard"],
    ["a right-to-left override", "Dash\u202Eboard"],
    ["a right-to-left isolate", "Dash\u2067board"],
    ["a zero-width space", "Dash\u200Bboard"],
    ["a byte-order mark", "Dash\uFEFFboard"],
    ["a line separator", "Dash\u2028board"],
  ])("rejects a name containing %s", (_label, name) => {
    const parsed = apiKeyCreateSchema.safeParse({ ...valid, name });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toMatch(/control characters, direction overrides or invisible/);
  });

  it("rejects a name with nothing visible in it", () => {
    const parsed = apiKeyCreateSchema.safeParse({ ...valid, name: "\u200D\u200D" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe("Name must contain a visible character");
  });

  it.each([
    ["punctuation, accents and emoji", "Café dashboard (v2) — 📺"],
    ["an emoji built with a zero-width joiner", "🏳️‍🌈 Pride"],
    ["a family emoji", "👨‍👩‍👧 Home"],
    ["a non-Latin script", "Домашний сервер"],
  ])("accepts %s in the name", (_label, name) => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, name }).success).toBe(true);
  });

  it("accepts only registry scopes, at least one", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, scopes: [] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...valid, scopes: ["media:write"] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...valid, scopes: ["*"] }).success).toBe(false);
    expect(
      apiKeyCreateSchema.safeParse({ ...valid, scopes: ["lifecycle:execute", "streams:write"] }).success,
    ).toBe(true);
  });
});

describe("bounds on write inputs the public API reaches", () => {
  it("terminateSessionSchema caps the message and the session list", () => {
    const base = { serverId: "s1", message: "x".repeat(500) };
    expect(terminateSessionSchema.safeParse(base).success).toBe(true);
    expect(terminateSessionSchema.safeParse({ ...base, message: "x".repeat(501) }).success).toBe(false);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `sess-${i}`);
    expect(terminateSessionSchema.safeParse({ ...base, sessionIds: ids(200) }).success).toBe(true);
    expect(terminateSessionSchema.safeParse({ ...base, sessionIds: ids(201) }).success).toBe(false);
  });

  it("exception schemas cap the reason and the id list", () => {
    expect(exceptionCreateSchema.safeParse({ mediaItemId: "m1", reason: "x".repeat(1000) }).success).toBe(true);
    expect(exceptionCreateSchema.safeParse({ mediaItemId: "m1", reason: "x".repeat(1001) }).success).toBe(false);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `e-${i}`);
    expect(exceptionBulkUpdateSchema.safeParse({ ids: ids(2), reason: "x".repeat(1001) }).success).toBe(false);
    expect(exceptionBulkDeleteSchema.safeParse({ ids: ["x".repeat(201)] }).success).toBe(false);
    expect(exceptionBulkDeleteSchema.safeParse({ ids: ids(MAX_EXCEPTION_IDS_PER_REQUEST + 1) }).success).toBe(false);
  });

  // The Exceptions page sends every exception id of a grouped row: a long show
  // on two servers is well past a thousand, and the old cap of 1,000 made
  // such a row impossible to remove or re-word from the UI.
  it("exception bulk schemas take a whole grouped row of the Exceptions page", () => {
    const ids = Array.from({ length: 1600 }, (_, i) => `e-${i}`);
    expect(exceptionBulkDeleteSchema.safeParse({ ids }).success).toBe(true);
    expect(exceptionBulkUpdateSchema.safeParse({ ids, reason: "r" }).success).toBe(true);
  });

  // Each of these goes straight into a DB lookup; a key could otherwise send
  // an arbitrarily long string.
  it("caps the id strings the public API's writes reach", () => {
    const long = "x".repeat(201);
    expect(syncCancelSchema.safeParse({ serverId: long }).success).toBe(false);
    expect(syncCancelSchema.safeParse({ serverId: "s1" }).success).toBe(true);
    expect(terminateSessionSchema.safeParse({ serverId: long }).success).toBe(false);
    expect(exceptionCreateSchema.safeParse({ mediaItemId: long }).success).toBe(false);
    expect(actionExecuteSchema.safeParse({ ruleSetId: long }).success).toBe(false);
    expect(actionExecuteSchema.safeParse({ ruleSetId: "r1", mediaItemIds: [long] }).success).toBe(false);
  });

  it("actionExecuteSchema caps the media item list, leaving omission as execute-all", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m-${i}`);
    expect(actionExecuteSchema.safeParse({ ruleSetId: "r1", mediaItemIds: ids(1000) }).success).toBe(true);
    expect(actionExecuteSchema.safeParse({ ruleSetId: "r1", mediaItemIds: ids(1001) }).success).toBe(false);
    expect(actionExecuteSchema.safeParse({ ruleSetId: "r1" }).success).toBe(true);
  });
});

describe("apiKeyCreateSchema.currentPassword", () => {
  const valid = { name: "Home Assistant", scopes: ["media:read"], expiresAt: null };

  it("is optional, bounded like a login password, and never trimmed", () => {
    expect(apiKeyCreateSchema.safeParse(valid).success).toBe(true);
    const parsed = apiKeyCreateSchema.safeParse({ ...valid, currentPassword: " hunter2 " });
    expect(parsed.success && parsed.data.currentPassword).toBe(" hunter2 ");
    expect(apiKeyCreateSchema.safeParse({ ...valid, currentPassword: "x".repeat(200) }).success).toBe(true);
    expect(apiKeyCreateSchema.safeParse({ ...valid, currentPassword: "x".repeat(201) }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...valid, currentPassword: 123 }).success).toBe(false);
  });
});

describe("discordSettingsSchema.notifyApiKeys", () => {
  it("is an optional boolean", () => {
    expect(discordSettingsSchema.safeParse({}).success).toBe(true);
    expect(discordSettingsSchema.safeParse({ notifyApiKeys: false }).success).toBe(true);
    expect(discordSettingsSchema.safeParse({ notifyApiKeys: "no" }).success).toBe(false);
  });
});
