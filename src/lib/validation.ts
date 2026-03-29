import { z } from "zod/v4";
import { NextResponse } from "next/server";

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

export const arrInstanceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.url("Invalid URL format"),
  apiKey: z.string().min(1, "API key is required"),
  externalUrl: z
    .union([z.url("Invalid URL format"), z.literal("")])
    .optional(),
});

export const arrInstanceUpdateSchema = arrInstanceCreateSchema.partial().extend({
  enabled: z.boolean().optional(),
});

export const authSetupSchema = z.object({
  username: z.string().min(3, "Username must be at least 3 characters"),
  password: z.string().min(8, "Password must be at least 8 characters"),
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

export const actionRetentionSchema = z.object({
  actionHistoryRetentionDays: z.number().int().min(0).max(365),
});

export const accentColorSchema = z.object({
  accentColor: z.string().min(1, "Accent color is required"),
});

export const chipColorsSchema = z.object({
  chipColors: z.record(z.string(), z.record(z.string(), z.string())),
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
  webhookAvatarUrl: z.string().transform((v) => v || undefined).pipe(z.string().url().optional()),
  notifyMaintenance: z.boolean().optional(),
});

export const discordTestSchema = z.object({
  webhookUrl: discordWebhookUrlSchema,
  webhookUsername: z.string().max(80).optional(),
  webhookAvatarUrl: z.string().transform((v) => v || undefined).pipe(z.string().url().optional()),
});

export const dedupSettingsSchema = z.object({
  dedupStats: z.boolean(),
});

export const titlePreferenceSchema = z.object({
  serverId: z.string().nullable().optional(),
  field: z.string().min(1, "Field is required"),
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
  localAuthEnabled: z.boolean(),
});

export const runJobSchema = z.object({
  job: z.enum(["sync", "detection", "execution"]),
});

// ─── Tools schemas ───

export const maintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().optional(),
  delay: z.number().optional(),
  discordNotifyMaintenance: z.boolean().optional(),
  excludedUsers: z.array(z.string()).optional(),
});

export const transcodeManagerSchema = z.object({
  enabled: z.boolean().optional(),
  message: z.string().optional(),
  delay: z.number().optional(),
  criteria: z.record(z.string(), z.boolean()).optional(),
  excludedUsers: z.array(z.string()).optional(),
});

export const terminateSessionSchema = z.object({
  serverId: z.string().min(1, "Server ID is required"),
  sessionIds: z.array(z.string()).optional(),
  message: z.string().min(1, "Message is required"),
});

export const blackoutCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  scheduleType: z.enum(["one_time", "recurring"]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  action: z.enum(["terminate_immediate", "warn_then_terminate", "block_new_only"]),
  message: z.string().optional(),
  delay: z.number().min(0).optional(),
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
]).nullable().optional();

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
  addImportExclusion: z.boolean().optional(),
  searchAfterDelete: z.boolean().optional(),
  addArrTags: z.array(z.string()).optional(),
  removeArrTags: z.array(z.string()).optional(),
  collectionEnabled: z.boolean().optional(),
  collectionName: z.string().nullable().optional(),
  collectionSortName: z.string().nullable().optional(),
  collectionHomeScreen: z.boolean().optional(),
  collectionRecommended: z.boolean().optional(),
  collectionSort: z.enum(["RELEASE_DATE", "ALPHABETICAL", "DELETION_DATE"]).optional(),
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
  addImportExclusion: z.boolean().optional(),
  searchAfterDelete: z.boolean().optional(),
  addArrTags: z.array(z.string()).optional(),
  removeArrTags: z.array(z.string()).optional(),
  collectionEnabled: z.boolean().optional(),
  collectionName: z.string().nullable().optional(),
  collectionSortName: z.string().nullable().optional(),
  collectionHomeScreen: z.boolean().optional(),
  collectionRecommended: z.boolean().optional(),
  collectionSort: z.enum(["RELEASE_DATE", "ALPHABETICAL", "DELETION_DATE"]).optional(),
  discordNotifyOnAction: z.boolean().optional(),
  discordNotifyOnMatch: z.boolean().optional(),
  stickyMatches: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required").optional(),
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
  ruleSetId: z.string().min(1, "Rule set ID is required"),
  mediaItemIds: z.array(z.string()).optional(),
});

export const ruleDiffSchema = z.object({
  rules: rulesSchema,
  type: z.enum(["MOVIE", "SERIES", "MUSIC"]),
  seriesScope: z.boolean().optional(),
  serverIds: z.array(z.string()).min(1, "At least one server is required"),
});

export const ruleRunSchema = z.object({
  ruleSetId: z.string().min(1, "Rule set ID is required").optional(),
  fullReEval: z.boolean().optional(),
  processActions: z.boolean().optional(),
});

export const collectionApplySchema = z.object({
  ruleSetId: z.string().min(1, "Rule set ID is required"),
  previousCollectionEnabled: z.boolean().optional(),
  previousCollectionName: z.string().optional(),
  skipCollectionRemoval: z.boolean().optional(),
});

export const collectionSyncSchema = z.object({
  ruleSetId: z.string().min(1, "Rule set ID is required"),
});

export const exceptionCreateSchema = z.object({
  mediaItemId: z.string().min(1, "Media item ID is required"),
  reason: z.string().optional(),
});

// ─── Auth schemas ───

export const changePasswordSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8, "Password must be at least 8 characters").optional(),
  newUsername: z.string().min(3, "Username must be at least 3 characters").optional(),
});

export const plexTokenSchema = z.object({
  authToken: z.string().min(1),
});

export const plexLinkSchema = z.object({
  pinId: z.coerce.number().optional(),
  authToken: z.string().min(1).optional(),
}).refine(
  (data) => data.pinId !== undefined || data.authToken !== undefined,
  { message: "Either pinId or authToken must be provided" }
);

// ─── Integration schemas ───

export const seerrInstanceCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  apiKey: z.string().min(1, "API key is required"),
});

export const seerrInstanceUpdateSchema = z.object({
  name: z.string().optional(),
  url: z.string().refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ).optional(),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const arrTestSchema = z.object({
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  apiKey: z.string().min(1, "API key is required"),
});

// ─── Server schemas ───

export const serverAddSchema = z.object({
  name: z.string().optional(),
  url: z.string().min(1, "URL is required").refine(
    (val) => /^https?:\/\//i.test(val),
    "URL must start with http:// or https://"
  ),
  accessToken: z.string().min(1, "Access token is required"),
  machineId: z.string().optional(),
  tlsSkipVerify: z.boolean().optional(),
  type: z.string().optional(),
});

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
  serverId: z.string().min(1, "Server ID is required"),
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

