import { z } from "zod/v4";
import { NextResponse } from "next/server";
import { MAX_QUERY_ACTION_ITEMS } from "@/lib/query/constants";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import { API_SCOPES } from "@/lib/api-keys/scopes";
import { API_DESTRUCTIVE_PER_REQUEST } from "@/lib/api-keys/limits";
import { apiKeyNameProblem } from "@/lib/api-keys/name-rules";
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  passwordByteLength,
} from "@/lib/auth/password-rules";

/**
 * Parse and validate request JSON against a Zod schema.
 * Returns { data } on success or { error: NextResponse } on failure.
 */
export async function validateRequest<T extends z.ZodType>(
  request: Request,
  schema: T
): Promise<
  | { data: z.infer<T>; error?: never }
  | { data?: never; error: NextResponse }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      error: NextResponse.json(
        { error: "Invalid JSON in request body" },
        { status: 400 }
      ),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`
    );
    return {
      error: NextResponse.json(
        { error: "Validation failed", details: issues },
        { status: 400 }
      ),
    };
  }

  return { data: result.data };
}

// ─── Reusable schemas ───

/**
 * A browser-facing base URL for an integration's "Open in …" links; "" clears
 * it. Restricted to http(s): a bare `z.url()` accepts `seerr.lan:5055` (it
 * parses with `seerr.lan:` as the scheme), and the stored value then builds a
 * link the browser cannot open — nothing tests it the way a connection URL is.
 */
const externalLinkUrlSchema = z
  .union([
    z.url({ protocol: /^https?$/, error: "External URL must start with http:// or https://" }),
    z.literal(""),
  ])
  .optional();

export const arrInstanceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.url("Invalid URL format"),
  apiKey: z.string().min(1, "API key is required"),
  externalUrl: externalLinkUrlSchema,
});

export const arrInstanceUpdateSchema = arrInstanceCreateSchema.partial().extend({
  enabled: z.boolean().optional(),
});

// A new login password: at least 8 characters, and at most the 72 bytes bcrypt
// actually reads (see `src/lib/auth/password-rules.ts`).
const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT_MESSAGE)
  .refine((value) => passwordByteLength(value) <= MAX_PASSWORD_BYTES, PASSWORD_TOO_LONG_MESSAGE);

export const authSetupSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: newPasswordSchema,
});

export const authLoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// ─── Settings schemas ───

export const syncScheduleSchema = z.object({
  syncSchedule: z.string().min(1, "Schedule is required"),
});

export const lifecycleScheduleSchema = z.object({
  lifecycleDetectionSchedule: z.string().optional(),
  lifecycleExecutionSchedule: z.string().optional(),
});

export const logRetentionSchema = z.object({
  logRetentionDays: z.number().int().min(1).max(365),
});

/**
 * `null` disables the ceiling (the default). A positive integer sets it; zero
 * and negatives are rejected rather than silently meaning "block everything",
 * which would disable lifecycle deletion entirely.
 */
export const deleteCeilingSchema = z.object({
  maxAutoDeleteItems: z
    .number()
    .int()
    .min(1, "The limit must be at least 1 — leave it empty to disable it")
    .max(1_000_000)
    .nullable(),
});

export const actionRetentionSchema = z.object({
  actionHistoryRetentionDays: z.number().int().min(0).max(365),
});

export const accentColorSchema = z.object({
  accentColor: z.string().min(1, "Accent color is required"),
});

const chipHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Must be a 6-digit hex color (#rrggbb)");

export const chipColorsSchema = z.object({
  chipColors: z.record(
    z.string().min(1).max(64),
    z.record(z.string().min(1).max(64), chipHexSchema),
  ),
});

export const columnPreferencesSchema = z.object({
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  columns: z.array(z.unknown()).max(50),
});

export const cardDisplayPreferencesSchema = z.object({
  preferences: z.record(
    z.string(),
    z.object({
      badges: z.record(z.string(), z.boolean()),
      metadata: z.record(z.string(), z.boolean()),
      servers: z.boolean(),
    }),
  ),
});

export const dashboardLayoutSchema = z.object({
  layout: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length <= 10_000,
    "Layout data exceeds maximum size"
  ),
});

const discordWebhookUrlSchema = z
  .string()
  .refine(
    (val) => {
      if (val === "") return true; // Allow empty string to clear
      if (val === MASKED_VALUE) return true; // The masked placeholder echoed back = keep saved
      try {
        const parsed = new URL(val);
        return (
          (parsed.hostname === "discord.com" ||
            parsed.hostname === "discordapp.com" ||
            parsed.hostname.endsWith(".discord.com")) &&
          parsed.protocol === "https:"
        );
      } catch {
        return false;
      }
    },
    "Must be a valid Discord webhook URL (https://discord.com/...)"
  )
  .optional();

export const discordSettingsSchema = z.object({
  webhookUrl: discordWebhookUrlSchema,
  webhookUsername: z.string().max(80).optional(),
  webhookAvatarUrl: z.string().optional().transform((v) => v || undefined).pipe(z.string().url().optional()),
  notifyMaintenance: z.boolean().optional(),
  notifyApiKeys: z.boolean().optional(),
});

export const discordTestSchema = z.object({
  webhookUrl: discordWebhookUrlSchema,
  webhookUsername: z.string().max(80).optional(),
  webhookAvatarUrl: z.string().optional().transform((v) => v || undefined).pipe(z.string().url().optional()),
});

export const dedupSettingsSchema = z.object({
  dedupStats: z.boolean(),
});

export const realtimeSettingsSchema = z.object({
  realtimeSync: z.boolean(),
});

export const titlePreferenceSchema = z.object({
  serverId: z.string().nullable().optional(),
  field: z.enum(["title", "artwork"]),
});

export const backupScheduleSchema = z.object({
  backupSchedule: z.string().optional(),
  backupRetentionCount: z.number().int().min(1).max(100).optional(),
});

export const scheduledJobTimeSchema = z.object({
  scheduledJobTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be in HH:MM format (24-hour)"),
});

export const backupEncryptionPasswordSchema = z.object({
  backupEncryptionPassword: z.string().min(8, "Password must be at least 8 characters").nullable(),
});

export const backupCreateSchema = z.object({
  passphrase: z.string().min(8, "Passphrase must be at least 8 characters").optional(),
  includeMediaData: z.boolean().optional(),
});

export const backupRestoreSchema = z.object({
  filename: z.string().min(1, "Filename is required"),
  passphrase: z.string().optional(),
});

export const authSettingsSchema = z.object({
  localAuthEnabled: z.boolean().optional(),
  plexLoginEnabled: z.boolean().optional(),
});

export const runJobSchema = z.object({
  job: z.enum(["sync", "detection", "execution"]),
});

// ─── Tools schemas ───

export const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().optional(),
  delay: z.number().int().min(0).max(3600).optional(),
  discordNotifyMaintenance: z.boolean().optional(),
  excludedUsers: z.array(z.string()).optional(),
});

export const transcodeManagerSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().optional(),
  delay: z.number().int().min(0).max(3600).optional(),
  criteria: z.record(z.string(), z.boolean()).optional(),
  excludedUsers: z.array(z.string()).optional(),
  exemptHardware: z.boolean().optional(),
});

// Bounded because the public API reaches this: the message is pushed to every
// targeted player, and an unbounded list is an unbounded amount of work.
// Session ids are opaque tokens (Plex: alphanumeric; Jellyfin/Emby: hex) that
// end up in a media-server request path sent with the server's admin token, so
// anything that could be read as more than one path segment is refused here.
// The Jellyfin/Emby client encodes them as well (`sessionPath`).
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Invalid session id");

export const terminateSessionSchema = z.object({
  serverId: z.string().min(1, "Server ID is required").max(200),
  sessionIds: z.array(sessionIdSchema).max(200, "At most 200 sessions per request").optional(),
  message: z
    .string()
    .min(1, "Message is required")
    .max(500, "Message must be 500 characters or fewer"),
});

// Note: cross-field rules (one_time needs dates; recurring needs days + HH:mm
// times) are enforced in the blackout/preroll route handlers, which return
// specific user-facing messages. Keep this schema permissive so those messages
// surface instead of a generic "Validation failed".
export const blackoutCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  scheduleType: z.enum(["one_time", "recurring"]),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  action: z.enum(["terminate_immediate", "warn_then_terminate", "block_new_only"]),
  message: z.string().optional(),
  // Bounded + integer to match the maintenance/transcode delays: an unbounded
  // value makes warn_then_terminate effectively never fire, and a non-integer
  // would 500 on write to the Int column.
  delay: z.number().int().min(0).max(3600).optional(),
  enabled: z.boolean().optional(),
  excludedUsers: z.array(z.string()).optional(),
});

export const blackoutUpdateSchema = blackoutCreateSchema.partial();

export const prerollPathSchema = z.object({
  path: z.string(),
});

export const prerollValidatePathSchema = z.object({
  path: z.string().min(1, "Path is required"),
});

export const prerollPresetCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  path: z.string().min(1, "Path is required"),
});

export const prerollPresetUpdateSchema = prerollPresetCreateSchema.partial();

export const prerollScheduleCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  prerollPath: z.string().min(1, "Preroll path is required"),
  scheduleType: z.enum(["one_time", "recurring", "seasonal"]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

export const prerollScheduleUpdateSchema = prerollScheduleCreateSchema.partial();

// ─── Lifecycle schemas ───

/** Validates that rule objects have the required structure (field, operator for flat rules;
 *  condition, rules array for groups). Prevents malformed rules from silently producing
 *  empty WHERE clauses that match everything. */
const VALID_STREAM_QUERY_TYPES = new Set(["audio", "video", "subtitle"]);

function validateRuleStructure(rules: Record<string, unknown>[]): boolean {
  for (const item of rules) {
    if ("rules" in item) {
      // RuleGroup format: must have condition and rules array
      if (!Array.isArray(item.rules)) return false;
      if (item.condition !== "AND" && item.condition !== "OR") return false;
      // Validate streamQuery property if present
      if ("streamQuery" in item && item.streamQuery != null) {
        const sq = item.streamQuery as Record<string, unknown>;
        if (typeof sq !== "object" || !("streamType" in sq)) return false;
        if (!VALID_STREAM_QUERY_TYPES.has(sq.streamType as string)) return false;
      }
      for (const rule of item.rules as Record<string, unknown>[]) {
        if (typeof rule !== "object" || rule === null) return false;
        if (!("field" in rule) || !("operator" in rule)) return false;
        if (typeof rule.field !== "string" || typeof rule.operator !== "string") return false;
      }
      if ("groups" in item && Array.isArray(item.groups)) {
        if (!validateRuleStructure(item.groups as Record<string, unknown>[])) return false;
      }
    } else {
      // Flat Rule format: must have field and operator
      if (!("field" in item) || !("operator" in item)) return false;
      if (typeof item.field !== "string" || typeof item.operator !== "string") return false;
    }
  }
  return true;
}

const rulesSchema = z.array(z.record(z.string(), z.unknown())).min(1, "Rules are required").max(100).refine(
  (val) => JSON.stringify(val).length <= 50_000,
  "Rules data exceeds maximum size"
).refine(
  validateRuleStructure,
  "Each rule must have 'field' and 'operator' string properties"
);

const actionTypeEnum = z.enum([
  "DO_NOTHING",
  "DELETE_RADARR", "DELETE_SONARR", "DELETE_LIDARR",
  "UNMONITOR_RADARR", "UNMONITOR_SONARR", "UNMONITOR_LIDARR",
  "UNMONITOR_DELETE_FILES_RADARR", "UNMONITOR_DELETE_FILES_SONARR", "UNMONITOR_DELETE_FILES_LIDARR",
  "MONITOR_DELETE_FILES_RADARR", "MONITOR_DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_LIDARR",
  "DELETE_FILES_RADARR", "DELETE_FILES_SONARR", "DELETE_FILES_LIDARR",
  "CHANGE_QUALITY_PROFILE_RADARR", "CHANGE_QUALITY_PROFILE_SONARR", "CHANGE_QUALITY_PROFILE_LIDARR",
  "SEARCH_RADARR", "SEARCH_SONARR", "SEARCH_LIDARR",
]).nullable().optional();

// Shared sort modes for a Plex collection's item ordering.
const collectionSortEnum = z.enum(["RELEASE_DATE", "ALPHABETICAL", "ACTION_DATE"]);

export const ruleSetCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  rules: rulesSchema,
  seriesScope: z.boolean().optional(),
  enabled: z.boolean().optional(),
  actionEnabled: z.boolean().optional(),
  actionType: actionTypeEnum,
  actionDelayDays: z.number().int().min(0).max(365).optional(),
  arrInstanceId: z.string().nullable().optional(),
  targetQualityProfileId: z.number().int().nullable().optional(),
  addImportExclusion: z.boolean().optional(),
  searchAfterAction: z.boolean().optional(),
  addArrTags: z.array(z.string()).optional(),
  removeArrTags: z.array(z.string()).optional(),
  collectionId: z.string().nullable().optional(),
  discordNotifyOnAction: z.boolean().optional(),
  discordNotifyOnMatch: z.boolean().optional(),
  stickyMatches: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required"),
});

export const ruleSetUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  rules: rulesSchema.optional(),
  seriesScope: z.boolean().optional(),
  enabled: z.boolean().optional(),
  actionEnabled: z.boolean().optional(),
  actionType: actionTypeEnum,
  actionDelayDays: z.number().int().min(0).max(365).optional(),
  arrInstanceId: z.string().nullable().optional(),
  targetQualityProfileId: z.number().int().nullable().optional(),
  addImportExclusion: z.boolean().optional(),
  searchAfterAction: z.boolean().optional(),
  addArrTags: z.array(z.string()).optional(),
  removeArrTags: z.array(z.string()).optional(),
  collectionId: z.string().nullable().optional(),
  discordNotifyOnAction: z.boolean().optional(),
  discordNotifyOnMatch: z.boolean().optional(),
  stickyMatches: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required").optional(),
});

// Collection (reusable Plex collection definition) CRUD.
export const collectionCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  sortName: z.string().nullable().optional(),
  homeScreen: z.boolean().optional(),
  recommended: z.boolean().optional(),
  sort: collectionSortEnum.optional(),
});

export const collectionUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  sortName: z.string().nullable().optional(),
  homeScreen: z.boolean().optional(),
  recommended: z.boolean().optional(),
  sort: collectionSortEnum.optional(),
});

export const rulePreviewSchema = z.object({
  rules: rulesSchema,
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  seriesScope: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required"),
});

export const ruleTestItemSchema = z.object({
  rules: rulesSchema,
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  seriesScope: z.boolean().optional(),
  mediaItemId: z.string().min(1, "Media item ID is required"),
  serverIds: z.array(z.string()).min(1, "At least one server is required"),
});

export const actionExecuteSchema = z.object({
  ruleSetId: z.string().min(1, "Rule set ID is required").max(200),
  // Omitted = execute every match. An EMPTY list is refused rather than read the
  // same way: a caller mapping an empty selection to ids would otherwise run
  // the rule set's action against every match it holds.
  mediaItemIds: z
    .array(z.string().min(1).max(200))
    .min(1, "Pass at least one media item id, or omit mediaItemIds to execute every match")
    .max(1000, "At most 1000 media item ids per request; omit mediaItemIds to execute every match")
    .optional(),
});

export const ruleDiffSchema = z.object({
  rules: rulesSchema,
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  seriesScope: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required"),
  /** The editor's unsaved action config; the stored one when absent. */
  actionEnabled: z.boolean().optional(),
  actionType: z.string().nullable().optional(),
});

export const ruleRunSchema = z.object({
  ruleSetId: z.string().min(1, "Rule set ID is required").optional(),
  fullReEval: z.boolean().optional(),
  processActions: z.boolean().optional(),
});

export const collectionSyncSchema = z.object({
  collectionId: z.string().min(1, "Collection ID is required"),
});

// Bounded because the public API reaches these: a reason is free text stored
// per row.
const exceptionReasonSchema = z.string().max(1000, "Reason must be 1000 characters or fewer");
// The Exceptions page removes or re-words a grouped row in one request — every
// episode or track of a show or artist, on every server — so a long show held
// on two servers is well past a thousand ids, and a cap of 1,000 made such a
// row impossible to remove from the UI. Both uses are a single
// deleteMany/updateMany. A key never reaches this cap: the public API's DELETE
// validates `apiExceptionDeleteSchema` (API_DESTRUCTIVE_PER_REQUEST ids) first,
// and PATCH is not exposed to keys.
export const MAX_EXCEPTION_IDS_PER_REQUEST = 100_000;
const exceptionIdsSchema = z
  .array(z.string().min(1).max(200))
  .min(1, "At least one ID is required")
  .max(MAX_EXCEPTION_IDS_PER_REQUEST, `At most ${MAX_EXCEPTION_IDS_PER_REQUEST} IDs per request`);

export const exceptionCreateSchema = z.object({
  mediaItemId: z.string().min(1, "Media item ID is required").max(200),
  reason: exceptionReasonSchema.optional(),
  scope: z
    .enum(["individual", "series", "artist", "album"])
    .default("individual"),
});

export const exceptionUpdateSchema = z.object({
  reason: exceptionReasonSchema.optional(),
});

export const exceptionBulkDeleteSchema = z.object({
  ids: exceptionIdsSchema,
});

export const exceptionBulkUpdateSchema = z.object({
  ids: exceptionIdsSchema,
  reason: exceptionReasonSchema.optional(),
});

// ─── Auth schemas ───

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: newPasswordSchema.optional(),
  newUsername: z.string().min(3, "Username must be at least 3 characters").optional(),
});

export const plexTokenSchema = z.object({
  authToken: z.string().min(1),
});

/**
 * `POST /api/auth/reauth/password` — the account's current password, to renew
 * a recent sign-in in place. Bounded like the API-key confirmation; never
 * trimmed.
 */
export const reauthPasswordSchema = z.object({
  password: z.string().min(1).max(200),
});

/**
 * `POST /api/auth/reauth/oidc` — a per-attempt nonce from the browser. It
 * rides in the OIDC `state` and comes back on the popup's report, so the page
 * waiting on an attempt ignores a report from any other popup or tab.
 */
export const reauthOidcStartSchema = z.object({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export const plexLinkSchema = z.object({
  pinId: z.coerce.number().optional(),
  authToken: z.string().min(1).optional(),
}).refine(
  (data) => data.pinId !== undefined || data.authToken !== undefined,
  { message: "Either pinId or authToken must be provided" }
);

// ─── API key schemas ───

/**
 * Issue an API key for the public `/api/v1` API. `expiresAt` is an ISO
 * timestamp, or null for a key that never expires; "in the future" is checked
 * by the route, against the server clock. Implied read scopes are added by the
 * route (`normalizeScopes`), so a client may send just the write scope.
 */
export const apiKeyCreateSchema = z.object({
  // Rules shared with the settings form (see `name-rules.ts`).
  name: z
    .string()
    .trim()
    .superRefine((name, ctx) => {
      const problem = apiKeyNameProblem(name);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1, "Choose at least one scope")
    .max(API_SCOPES.length, "Too many scopes"),
  expiresAt: z.iso
    .datetime({ offset: true, error: "Expiration must be an ISO 8601 date-time" })
    .nullable(),
  /**
   * The account's current password, required by the route when the account
   * has one: a key outlives the browser session that mints it, so minting is
   * confirmed by something a stolen cookie does not carry. Bounded like a
   * login password; never trimmed.
   */
  currentPassword: z.string().max(200).optional(),
});

/**
 * `PUT /api/v1/tools/maintenance` — what a `streams:write` key may change:
 * maintenance on or off, its message and its delay. Who is exempt and whether
 * Discord is told stay Settings-only (`maintenanceSchema`), so a leaked key
 * cannot silence the notification that would reveal it. Strict, so a client
 * sending those fields gets a 400 rather than a silent partial update.
 */
export const apiMaintenanceSchema = z.strictObject({
  enabled: z.boolean(),
  message: z.string().max(500, "Message must be 500 characters or fewer").optional(),
  delay: z.number().int().min(0).max(3600).optional(),
});

/**
 * `POST /api/v1/lifecycle/actions/execute` — a key must NAME every item it acts
 * on. The app's own route reads a missing `mediaItemIds` as "every match" (the
 * Pending page's Execute All, behind a confirmation dialog); through the API
 * that one omission would run the rule set's action on its whole match list.
 * At most `API_DESTRUCTIVE_PER_REQUEST` ids, whatever the action. Strict.
 */
export const apiActionExecuteSchema = z.strictObject({
  ruleSetId: z.string().min(1, "Rule set ID is required").max(200),
  mediaItemIds: z
    .array(z.string().min(1).max(200), { error: "mediaItemIds is required: name every item to act on" })
    .min(1, "mediaItemIds is required: name every item to act on")
    .max(
      API_DESTRUCTIVE_PER_REQUEST,
      `At most ${API_DESTRUCTIVE_PER_REQUEST} media item ids per API request`,
    ),
});

/**
 * `DELETE /api/v1/lifecycle/exceptions` — removing an exception lets the rules
 * match the item again, so a key may remove at most
 * `API_DESTRUCTIVE_PER_REQUEST` per request (the app's own route takes a whole
 * grouped row of the Exceptions page at once).
 */
export const apiExceptionDeleteSchema = z.strictObject({
  ids: z
    .array(z.string().min(1).max(200))
    .min(1, "At least one ID is required")
    .max(API_DESTRUCTIVE_PER_REQUEST, `At most ${API_DESTRUCTIVE_PER_REQUEST} IDs per API request`),
});

// ─── SSO schemas ───

export const ssoConfigSchema = z.object({
  ssoEnabled: z.boolean().optional(),
  ssoMode: z.enum(["OIDC", "FORWARD_AUTH"]).optional(),
  oidcIssuer: z
    .union([
      z.string().refine(
        (val) => /^https?:\/\//i.test(val),
        "Issuer must start with http:// or https://"
      ),
      z.literal(""),
    ])
    .nullable()
    .optional(),
  oidcClientId: z.string().nullable().optional(),
  oidcClientSecret: z.string().nullable().optional(),
  oidcScopes: z
    .string()
    .min(1)
    .refine(
      (val) => val.split(/\s+/).some((s) => s.toLowerCase() === "openid"),
      "Scopes must include 'openid'"
    )
    .optional(),
  oidcUsernameClaim: z.string().min(1).optional(),
  forwardAuthUserHeader: z.string().min(1).optional(),
  forwardAuthEmailHeader: z.string().min(1).optional(),
  forwardAuthNameHeader: z.string().min(1).optional(),
});

export const ssoTestSchema = z.object({
  oidcIssuer: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "Issuer must start with http:// or https://"
  ),
});

export const ssoLinkSchema = z.object({
  ssoSubject: z.string().min(1, "SSO subject is required"),
  ssoProvider: z.string().optional(),
});

// ─── Integration schemas ───

export const seerrInstanceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  apiKey: z.string().min(1, "API key is required"),
  /** Browser-facing URL for "Open in Seerr" links; "" clears it. */
  externalUrl: externalLinkUrlSchema,
});

export const seerrInstanceUpdateSchema = z.object({
  name: z.string().optional(),
  url: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ).optional(),
  apiKey: z.string().optional(),
  externalUrl: externalLinkUrlSchema,
  enabled: z.boolean().optional(),
});

export const tracearrInstanceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  apiKey: z.string().min(1, "API key is required"),
});

/**
 * The API key is returned to the client masked (`MASKED_VALUE`), and the
 * settings form echoes whatever it was given straight back. Stripping the mask
 * here — rather than in each route — means a save that did not touch the key
 * field arrives as `apiKey: undefined`, which every write path already reads as
 * "keep the stored value".
 */
export const tracearrInstanceUpdateSchema = z.object({
  name: z.string().optional(),
  url: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ).optional(),
  apiKey: z.string().optional().transform((val) =>
    val === undefined || val === MASKED_VALUE ? undefined : val
  ),
  enabled: z.boolean().optional(),
});

export const arrTestSchema = z.object({
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  apiKey: z.string().min(1, "API key is required"),
});

// For re-testing a saved instance: both fields optional (fall back to stored
// values), but if provided the URL must be a well-formed http(s) string.
// Internal/LAN addresses are intentionally allowed — Arr/Seerr commonly run on
// the same host or a private network.
export const arrTestConnectionSchema = z.object({
  url: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ).optional(),
  apiKey: z.string().optional(),
});

// ─── Server schemas ───

/**
 * `POST /api/servers`. A Plex server picked from discovery sends its
 * `machineId` and no `accessToken`: the route looks the token up on plex.tv
 * itself (behind a recent sign-in), so an owned server's token — which can be
 * the Plex account's own token — never reaches the browser.
 */
export const serverAddSchema = z.object({
  name: z.string().optional(),
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  accessToken: z.string().min(1, "Access token is required").optional(),
  machineId: z.string().optional(),
  tlsSkipVerify: z.boolean().optional(),
  type: z.string().optional(),
}).refine(
  (data) => data.accessToken !== undefined || (!!data.machineId && (data.type ?? "PLEX") === "PLEX"),
  { message: "Access token is required", path: ["accessToken"] }
);

export const serverEditSchema = z.object({
  url: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ).optional(),
  externalUrl: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "External URL must start with http:// or https://"
  ).nullable().optional(),
  accessToken: z.string().optional(),
  tlsSkipVerify: z.boolean().optional(),
  enabled: z.boolean().optional(),
  deleteData: z.boolean().optional(),
  /**
   * Tracearr `server_id` (uuid) to pull this server's watch history from.
   * `null` unlinks and reverts to the server's native history; omitted leaves
   * the mapping untouched — the three states are distinguishable because the
   * write path checks `!== undefined` before writing. An empty string is
   * normalised to null so the settings `<select>`'s "None" option works.
   */
  tracearrServerId: z.string().nullable().optional().transform((val) =>
    val === undefined ? undefined : val === null || val.trim() === "" ? null : val.trim()
  ),
});

export const serverLibraryUpdateSchema = z.object({
  libraries: z.array(z.object({
    key: z.string(),
    enabled: z.boolean(),
  })),
});

export const serverTestSchema = z.object({
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  accessToken: z.string().min(1, "Access token is required"),
  type: z.string().min(1, "Server type is required"),
  tlsSkipVerify: z.boolean().optional(),
});

// ─── Media / Requests schemas ───

export const arrActionSchema = z.object({
  action: z.string().min(1, "Action is required"),
  instanceId: z.string().min(1, "Instance ID is required"),
  arrItemId: z.coerce.number(),
  type: z.enum(["radarr", "sonarr", "lidarr"]),
});

export const syncCancelSchema = z.object({
  serverId: z.string().min(1, "Server ID is required").max(200),
});

// --- Query Builder ---

const queryRuleSchema: z.ZodType = z.object({
  id: z.string(),
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  condition: z.enum(["AND", "OR"]),
  negate: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const queryGroupSchema: z.ZodType = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string().optional(),
    condition: z.enum(["AND", "OR"]),
    operator: z.enum(["AND", "OR"]).optional(),
    rules: z.array(queryRuleSchema).max(50),
    groups: z.array(queryGroupSchema).max(10),
    enabled: z.boolean().optional(),
    negate: z.boolean().optional(),
    streamQuery: z.object({
      streamType: z.enum(["audio", "video", "subtitle"]),
      quantifier: z.enum(["any", "none", "all"]).optional(),
    }).optional(),
  })
);

export const queryDefinitionSchema = z.object({
  mediaTypes: z.array(z.enum(["MOVIE", "SERIES", "MUSIC"])).max(3),
  serverIds: z.array(z.string()).max(20),
  groups: z.array(queryGroupSchema).max(20),
  sortBy: z.string().min(1).default("title"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
  includeEpisodes: z.boolean().optional().default(false),
  arrServerIds: z.object({
    radarr: z.string().optional(),
    sonarr: z.string().optional(),
    lidarr: z.string().optional(),
  }).optional(),
  seerrInstanceId: z.string().optional(),
});

export const executeQuerySchema = z.object({
  query: queryDefinitionSchema,
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(0).max(200).optional().default(50),
});

// Ad-hoc lifecycle action triggered on selected query results (no rule set).
export const queryActionSchema = z.object({
  query: queryDefinitionSchema,
  mediaItemIds: z
    .array(z.string())
    .min(1, "At least one item is required")
    .max(MAX_QUERY_ACTION_ITEMS, `You can act on at most ${MAX_QUERY_ACTION_ITEMS} items in a single action`),
  // Optional per-run id shared by all batches of one selection, so the server can
  // memoize the deletion-safety re-query across batches instead of re-running the
  // whole-library query (+ Arr/Seerr fetch) per batch. Client-generated; used only
  // as a cache-key component, so it's constrained to a safe, bounded charset.
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "invalid runId").optional(),
  actionType: z.string().min(1),
  arrInstanceId: z.string().nullable().optional(),
  targetQualityProfileId: z.number().int().nullable().optional(),
  addImportExclusion: z.boolean().optional().default(false),
  searchAfterAction: z.boolean().optional().default(false),
  addArrTags: z.array(z.string()).optional().default([]),
  removeArrTags: z.array(z.string()).optional().default([]),
});

export const savedQueryCreateSchema = z.object({
  name: z.string().min(1).max(100),
  query: queryDefinitionSchema,
});

export const savedQueryUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  query: queryDefinitionSchema.optional(),
});

// ─── Watch History schemas ───

export const watchHistorySyncSchema = z.object({
  serverId: z.string().optional(),
});

export const syncByTypeSchema = z.object({
  libraryType: z.enum(["MOVIE", "SERIES", "MUSIC"]),
});


// ─── TRaSH Guide Sync schemas ───

const trashServiceType = z.enum(["SONARR", "RADARR"]);
const trashResourceType = z.enum([
  "CUSTOM_FORMAT",
  "QUALITY_PROFILE",
  "QUALITY_DEFINITION",
  "NAMING",
  "PROFILE_CF",
]);

const namingSelectionSchema = z
  .object({
    folder: z.string().optional(),
    file: z.string().optional(),
    series: z.string().optional(),
    season: z.string().optional(),
    standard: z.string().optional(),
    daily: z.string().optional(),
    anime: z.string().optional(),
  })
  .strict();

/** Custom-format score assignments attached to a quality profile. */
const profileCfSelectionSchema = z
  .object({
    formats: z
      .array(
        z.object({
          trashId: z.string().min(1),
          name: z.string().min(1),
          score: z.number().int().min(-100000).max(100000),
        }),
      )
      .max(500),
  })
  .strict();

/**
 * Per-profile options for a QUALITY_PROFILE managed resource: which guide score
 * set to use, and whether to reset custom-format scores the profile doesn't
 * manage (with exact-name and regex exceptions). Mirrors Recyclarr's
 * `quality_profiles` block (`score_set`, `reset_unmatched_scores`).
 */
const qualityProfileSelectionSchema = z
  .object({
    scoreSet: z.string().min(1).max(100).optional(),
    resetUnmatchedScores: z.boolean().optional(),
    resetExcept: z.array(z.string().min(1).max(200)).max(500).optional(),
  })
  .strict();

// A managed resource's optional selection is either a naming variant choice, a
// profile custom-format mapping, or per-profile quality-profile options,
// depending on its resourceType. Ordering matters for the union: the
// quality-profile schema comes before naming because both accept an empty
// object, but only naming should never carry the QP-only keys.
const trashSelectionSchema = z.union([
  profileCfSelectionSchema,
  qualityProfileSelectionSchema,
  namingSelectionSchema,
]);

/** Opt a set of guide resources into Librariarr management (the consent gate). */
export const trashAssignSchema = z.object({
  serviceType: trashServiceType,
  instanceId: z.string().min(1, "instanceId is required"),
  items: z
    .array(
      z.object({
        resourceType: trashResourceType,
        trashId: z.string().min(1),
        name: z.string().min(1),
        selection: trashSelectionSchema.optional(),
      }),
    )
    .min(1, "At least one item is required")
    // The full guide has a few hundred resources; cap well above that so a
    // "select all" is fine but a malformed/hostile payload can't drive an
    // unbounded upsert loop.
    .max(1000, "Too many items in one request"),
});

/** Update an existing managed resource's selection (naming variants or profile CFs). */
export const trashAssignmentUpdateSchema = z.object({
  selection: trashSelectionSchema,
});

/** Run a sync or a dry-run/preview. `items` only affects dry-run previews. */
export const trashSyncSchema = z.object({
  serviceType: trashServiceType,
  instanceId: z.string().min(1, "instanceId is required"),
  dryRun: z.boolean().optional(),
  items: z
    .array(
      z.object({
        resourceType: trashResourceType,
        trashId: z.string().min(1),
        selection: trashSelectionSchema.optional(),
      }),
    )
    .max(1000, "Too many items in one request")
    .optional(),
});

// ─── AI analysis schemas ───

/** Supported AI backends. "openai-compatible" covers OpenAI, Ollama, LM Studio,
 *  OpenRouter, Groq, vLLM, LocalAI, etc.; "anthropic" is the native Claude API. */
export const AI_PROVIDERS = ["openai-compatible", "anthropic"] as const;

const aiBaseUrlSchema = z
  .union([z.url("Invalid URL format"), z.literal("")])
  .optional();

/** Update the AI assistant configuration (all fields optional — partial update). */
export const aiSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(AI_PROVIDERS).optional(),
  baseUrl: aiBaseUrlSchema,
  // apiKey may arrive as the sanitize() mask when the form echoes it back
  // unchanged; the route skips persisting that placeholder. An empty string
  // explicitly clears the saved key (local models often need none).
  apiKey: z.string().max(400).optional(),
  model: z.string().max(200).optional(),
});

/** Test an AI connection with the given config (unset secrets fall back to the
 *  saved values so the admin can re-test without re-entering the key). */
export const aiTestSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  baseUrl: aiBaseUrlSchema,
  apiKey: z.string().max(400).optional(),
  model: z.string().min(1, "Model is required").max(200),
});

/** A single turn in the AI chat conversation, as sent from the client. Only
 *  user/assistant roles are accepted — the server injects the system prompt. */
const aiChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000),
});

/** Ask the AI assistant a question about the media library. */
export const aiChatSchema = z.object({
  messages: z
    .array(aiChatMessageSchema)
    .min(1, "At least one message is required")
    .max(40, "Conversation is too long"),
});
