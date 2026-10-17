import { describe, it, expect } from "vitest";
import {
  validateRequest,
  validateOptionalRequest,
  serverSyncSchema,
  dashboardLayoutSchema,
  discordSettingsSchema,
  discordTestSchema,
  ruleSetUpdateSchema,
  plexLinkSchema,
  seerrInstanceUpdateSchema,
  tracearrInstanceCreateSchema,
  tracearrInstanceUpdateSchema,
  arrTestSchema,
  arrTestConnectionSchema,
  serverAddSchema,
  serverEditSchema,
  serverTestSchema,
  syncCancelSchema,
  executeQuerySchema,
} from "@/lib/validation";
import { MASKED_VALUE } from "@/lib/api/sanitize";

const RULE_MESSAGE = "Each rule must have 'field' and 'operator' string properties";

function rulesOk(rules: unknown[]): boolean {
  return ruleSetUpdateSchema.safeParse({ rules }).success;
}

function rulesMessages(rules: unknown[]): string[] {
  const r = ruleSetUpdateSchema.safeParse({ rules });
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("validateRequest / validateOptionalRequest", () => {
  const post = (body: string) => new Request("http://x/", { method: "POST", body });

  it("rejects malformed JSON and reports validation details", async () => {
    const bad = await validateRequest(post("{"), syncCancelSchema);
    expect(bad.error?.status).toBe(400);
    expect(await bad.error!.json()).toEqual({ error: "Invalid JSON in request body" });

    const invalid = await validateRequest(post("{}"), syncCancelSchema);
    expect(invalid.error?.status).toBe(400);
    const body = await invalid.error!.json();
    expect(body.error).toBe("Validation failed");
    // One "<path>: <message>" line per issue.
    expect(body.details).toEqual([expect.stringMatching(/^serverId: /)]);

    const ok = await validateRequest(post('{"serverId":"s"}'), syncCancelSchema);
    expect(ok.data).toEqual({ serverId: "s" });
  });

  it("treats an absent optional body as {}, but never a malformed one", async () => {
    expect((await validateOptionalRequest(post("  "), serverSyncSchema)).data).toEqual({});
    const bad = await validateOptionalRequest(post("nope"), serverSyncSchema);
    expect(await bad.error!.json()).toEqual({ error: "Invalid JSON in request body" });
    const strict = await validateOptionalRequest(post('{"librarykey":"1"}'), serverSyncSchema);
    expect(strict.error?.status).toBe(400);
    expect((await strict.error!.json()).error).toBe("Validation failed");
    expect((await validateOptionalRequest(post('{"libraryKey":"1"}'), serverSyncSchema)).data).toEqual({
      libraryKey: "1",
    });
  });
});

describe("dashboardLayoutSchema", () => {
  it("refuses a layout over 10,000 characters", () => {
    expect(dashboardLayoutSchema.safeParse({ layout: { a: 1 } }).success).toBe(true);
    const r = dashboardLayoutSchema.safeParse({ layout: { a: "x".repeat(10_001) } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("Layout data exceeds maximum size");
  });
});

describe("Discord webhook URL", () => {
  const ok = (webhookUrl: unknown) => discordSettingsSchema.safeParse({ webhookUrl }).success;

  it("accepts empty (clear), the mask (keep) and https Discord hosts", () => {
    expect(ok("")).toBe(true);
    expect(ok(MASKED_VALUE)).toBe(true);
    expect(ok(undefined)).toBe(true);
    expect(ok("https://discord.com/api/webhooks/1/abc")).toBe(true);
    expect(ok("https://discordapp.com/api/webhooks/1/abc")).toBe(true);
    expect(ok("https://canary.discord.com/api/webhooks/1/abc")).toBe(true);
  });

  it("refuses other hosts, plain http and unparseable URLs", () => {
    expect(ok("https://evil.example/api/webhooks")).toBe(false);
    expect(ok("https://discord.com.evil.example/x")).toBe(false);
    expect(ok("http://discord.com/api/webhooks/1/abc")).toBe(false);
    expect(ok("not a url")).toBe(false);
  });

  // Kept as "": that is how the settings page clears a saved avatar, and an
  // absent field means "leave it".
  it("keeps an empty avatar URL and validates a set one", () => {
    expect(discordTestSchema.parse({ webhookAvatarUrl: "" }).webhookAvatarUrl).toBe("");
    expect(discordSettingsSchema.parse({ webhookAvatarUrl: "" }).webhookAvatarUrl).toBe("");
    expect(discordSettingsSchema.parse({}).webhookAvatarUrl).toBeUndefined();
    expect(discordSettingsSchema.safeParse({ webhookAvatarUrl: "nope" }).success).toBe(false);
    expect(discordTestSchema.safeParse({ webhookAvatarUrl: "nope" }).success).toBe(false);
    expect(discordTestSchema.parse({ webhookAvatarUrl: "https://a.example/x.png" }).webhookAvatarUrl).toBe(
      "https://a.example/x.png",
    );
  });
});

describe("rule structure", () => {
  const rule = { field: "title", operator: "equals", value: "x" };

  it("accepts flat rules and groups with nested groups", () => {
    expect(rulesOk([rule])).toBe(true);
    expect(
      rulesOk([
        {
          condition: "OR",
          rules: [rule],
          streamQuery: { streamType: "audio" },
          groups: [{ condition: "AND", rules: [rule] }],
        },
      ]),
    ).toBe(true);
    // A null streamQuery is the same as none; non-array groups are ignored.
    expect(rulesOk([{ condition: "AND", rules: [], streamQuery: null, groups: "x" }])).toBe(true);
  });

  it.each([
    ["a group whose rules are not an array", { condition: "AND", rules: "x" }],
    ["a group with an unknown condition", { condition: "XOR", rules: [] }],
    ["a stream query with no stream type", { condition: "AND", rules: [], streamQuery: { foo: 1 } }],
    ["a stream query that is not an object", { condition: "AND", rules: [], streamQuery: "audio" }],
    ["an unknown stream type", { condition: "AND", rules: [], streamQuery: { streamType: "data" } }],
    ["a null member rule", { condition: "AND", rules: [null] }],
    ["a member rule with no operator", { condition: "AND", rules: [{ field: "title" }] }],
    ["a member rule with a non-string field", { condition: "AND", rules: [{ field: 1, operator: "equals" }] }],
    ["an invalid nested group", { condition: "AND", rules: [], groups: [{ condition: "AND", rules: [{}] }] }],
    ["a flat rule with no field", { operator: "equals" }],
    ["a flat rule with a non-string operator", { field: "title", operator: 3 }],
  ])("refuses %s", (_name, item) => {
    expect(rulesMessages([item])).toContain(RULE_MESSAGE);
  });

  it("refuses rules data over the size cap", () => {
    expect(rulesMessages([{ ...rule, value: "x".repeat(50_001) }])).toContain("Rules data exceeds maximum size");
  });
});

describe("plexLinkSchema", () => {
  it("needs a pin id or a token", () => {
    expect(plexLinkSchema.safeParse({}).success).toBe(false);
    expect(plexLinkSchema.parse({ pinId: "42" })).toEqual({ pinId: 42 });
    expect(plexLinkSchema.parse({ authToken: "t" })).toEqual({ authToken: "t" });
  });
});

describe("integration instance schemas", () => {
  it("requires http(s) URLs where a URL is given", () => {
    expect(seerrInstanceUpdateSchema.safeParse({ url: "ftp://x" }).success).toBe(false);
    expect(seerrInstanceUpdateSchema.safeParse({ url: "HTTPS://x" }).success).toBe(true);
    expect(seerrInstanceUpdateSchema.safeParse({}).success).toBe(true);
    expect(tracearrInstanceCreateSchema.safeParse({ name: "t", url: "x", apiKey: "k" }).success).toBe(false);
    expect(tracearrInstanceCreateSchema.safeParse({ name: "t", url: "http://x", apiKey: "k" }).success).toBe(true);
    expect(arrTestSchema.safeParse({ url: "sonarr:8989", apiKey: "k" }).success).toBe(false);
    expect(arrTestConnectionSchema.safeParse({ url: "sonarr:8989" }).success).toBe(false);
    expect(arrTestConnectionSchema.safeParse({}).success).toBe(true);
  });

  it("reads the echoed mask on a Tracearr update as 'keep the stored key'", () => {
    expect(tracearrInstanceUpdateSchema.parse({ apiKey: MASKED_VALUE }).apiKey).toBeUndefined();
    expect(tracearrInstanceUpdateSchema.parse({}).apiKey).toBeUndefined();
    expect(tracearrInstanceUpdateSchema.parse({ apiKey: "new" }).apiKey).toBe("new");
    expect(tracearrInstanceUpdateSchema.safeParse({ url: "x" }).success).toBe(false);
  });
});

describe("server schemas", () => {
  it("adds a server by token, or a Plex server by machine id alone", () => {
    expect(serverAddSchema.safeParse({ url: "http://p", accessToken: "t", type: "JELLYFIN" }).success).toBe(true);
    expect(serverAddSchema.safeParse({ url: "http://p", machineId: "m" }).success).toBe(true);
    expect(serverAddSchema.safeParse({ url: "http://p", machineId: "m", type: "PLEX" }).success).toBe(true);
    const jf = serverAddSchema.safeParse({ url: "http://p", machineId: "m", type: "JELLYFIN" });
    expect(jf.success).toBe(false);
    expect(jf.error?.issues[0].path).toEqual(["accessToken"]);
    expect(serverAddSchema.safeParse({ url: "http://p", machineId: "" }).error?.issues.map((i) => i.path)).toEqual([
      ["accessToken"],
    ]);
    const noScheme = serverAddSchema.safeParse({ url: "p", accessToken: "t" });
    expect(noScheme.error?.issues.map((i) => i.message)).toEqual(["URL must start with http:// or https://"]);
  });

  it("normalises the Tracearr mapping on an edit", () => {
    expect(serverEditSchema.parse({}).tracearrServerId).toBeUndefined();
    expect(serverEditSchema.parse({ tracearrServerId: null }).tracearrServerId).toBeNull();
    expect(serverEditSchema.parse({ tracearrServerId: "  " }).tracearrServerId).toBeNull();
    expect(serverEditSchema.parse({ tracearrServerId: " abc " }).tracearrServerId).toBe("abc");
  });

  it("validates edit and test URLs", () => {
    expect(serverEditSchema.safeParse({ url: "x" }).error?.issues[0].path).toEqual(["url"]);
    expect(serverEditSchema.safeParse({ externalUrl: null }).success).toBe(true);
    const ext = serverEditSchema.safeParse({ externalUrl: "plex.lan" });
    expect(ext.error?.issues[0].message).toBe("External URL must start with http:// or https://");
    expect(serverTestSchema.safeParse({ url: "x", accessToken: "t", type: "PLEX" }).error?.issues[0].path).toEqual(["url"]);
    expect(serverTestSchema.safeParse({ url: "http://x", accessToken: "t", type: "PLEX" }).success).toBe(true);
  });

  // Only the types `createMediaServerClient` builds: anything else threw
  // there and answered 500.
  it("accepts only the media server types the app can talk to", () => {
    const messages = (r: { error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
      r.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    for (const type of ["PLEX", "JELLYFIN", "EMBY"]) {
      expect(serverTestSchema.safeParse({ url: "http://x", accessToken: "t", type }).success).toBe(true);
      expect(serverAddSchema.safeParse({ url: "http://x", accessToken: "t", type }).success).toBe(true);
    }
    for (const type of ["KODI", "plex", 1]) {
      expect(messages(serverTestSchema.safeParse({ url: "http://x", accessToken: "t", type }))).toEqual([
        "type: Server type must be PLEX, JELLYFIN or EMBY",
      ]);
      expect(messages(serverAddSchema.safeParse({ url: "http://x", accessToken: "t", type }))).toEqual([
        "type: Server type must be PLEX, JELLYFIN or EMBY",
      ]);
    }
    expect(messages(serverTestSchema.safeParse({ url: "http://x", accessToken: "t" }))).toEqual([
      "type: Server type is required",
    ]);
  });
});

describe("executeQuerySchema", () => {
  const rule = { id: "r", field: "title", operator: "equals", value: "x", condition: "AND" };
  const group = (over: Record<string, unknown> = {}) => ({
    id: "g", condition: "AND", rules: [rule], groups: [], ...over,
  });
  const query = (groups: unknown[]) => ({ mediaTypes: ["MOVIE"], serverIds: [], groups });

  it("applies defaults and accepts nested groups with a stream query", () => {
    const parsed = executeQuerySchema.parse({
      query: query([group({ groups: [group({ streamQuery: { streamType: "audio", quantifier: "none" } })] })]),
    });
    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(50);
    expect(parsed.query.sortBy).toBe("title");
    expect(parsed.query.sortOrder).toBe("asc");
    expect(parsed.query.includeEpisodes).toBe(false);
  });

  it("refuses a malformed nested group", () => {
    expect(
      executeQuerySchema.safeParse({ query: query([group({ groups: [group({ condition: "XOR" })] })]) }).success,
    ).toBe(false);
    expect(
      executeQuerySchema.safeParse({ query: query([group({ streamQuery: { streamType: "data" } })]) }).success,
    ).toBe(false);
  });
});
