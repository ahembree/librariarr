import { API_SCOPE_INFO, API_SCOPES, type ApiScope } from "./scopes";
import { API_DESTRUCTIVE_PER_HOUR, API_DESTRUCTIVE_PER_REQUEST, FULL_LISTING_REQUEST_COST } from "./limits";

const PER_REQUEST = API_DESTRUCTIVE_PER_REQUEST;
const PER_HOUR = API_DESTRUCTIVE_PER_HOUR;
const BUDGET_429 = `Every API key together has deleted or unprotected ${PER_HOUR} items in the last hour; wait \`Retry-After\` seconds`;

/**
 * The OpenAPI 3.1 description of `/api/v1`, built from one operation table.
 *
 * The table is the documentation twin of the route files: every entry names
 * the same method, path and scope the file's `withApiKey` wrapper does, and
 * `tests/unit/api-keys/openapi.test.ts` asserts the two agree over every file
 * on disk — an endpoint added, removed or re-scoped without this table is a
 * failing test, not a stale spec. Descriptions are kept short; the docs page
 * (`docs/…/advanced/api.mdx`) is the prose.
 *
 * Client-safe: no Node imports.
 */

type Method = "get" | "post" | "put" | "delete";

interface Param {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  required?: boolean;
}

interface Operation {
  method: Method;
  path: string;
  /** `null` = any valid key (introspection). */
  scope: ApiScope | null;
  summary: string;
  description?: string;
  tag: string;
  query?: Param[];
  body?: { description: string; schema: Record<string, unknown>; required?: boolean };
  responses?: Record<string, string>;
  /** The response is not JSON. */
  binary?: string;
}

const LIST_PAGING: Param[] = [
  { name: "page", description: "1-based page number.", schema: { type: "integer", minimum: 1, default: 1 } },
  {
    name: "limit",
    description:
      `Rows per page (0 = everything, which counts as ${FULL_LISTING_REQUEST_COST} requests against the key's budget).`,
    schema: { type: "integer", minimum: 0 },
  },
  { name: "offset", description: "Skip this many rows; overrides `page`.", schema: { type: "integer", minimum: 0 } },
  { name: "sortBy", description: "Field to sort by." },
  { name: "sortOrder", description: "Sort direction.", schema: { type: "string", enum: ["asc", "desc"] } },
];

const LIBRARY_FILTERS: Param[] = [
  { name: "search", description: "Title search." },
  { name: "startsWith", description: "First letter, or `#` for titles not starting with a letter." },
  { name: "serverId", description: "Limit to one media server." },
  { name: "resolution", description: "Pipe-separated values, e.g. `4K|1080P`." },
  { name: "genre", description: "Pipe-separated values." },
  { name: "yearConditions", description: "Pipe-separated `op:value` pairs, e.g. `gte:2020|lte:2024`." },
  { name: "yearLogic", description: "How multiple `yearConditions` combine.", schema: { type: "string", enum: ["and", "or"] } },
];

const MEDIA_TYPE = { type: "string", enum: ["MOVIE", "SERIES", "MUSIC"] };

/**
 * `GET /media/history`'s `sortBy` values. A copy of `HISTORY_SORT_KEYS` in
 * `src/lib/media/history-sort.ts` rather than an import: the docs build runs
 * this module directly (`scripts/generate-openapi.ts`), so it imports nothing
 * beyond `scopes`/`limits`, while history-sort carries the route's SQL and the
 * resolution helpers. `tests/unit/api-keys/openapi.test.ts` holds the two
 * lists equal.
 */
export const OPENAPI_HISTORY_SORT_KEYS = [
  "watchedAt",
  "serverUsername",
  "serverName",
  "deviceName",
  "platform",
  "title",
  "type",
  "year",
  "resolution",
  "dynamicRange",
  "videoCodec",
  "audioCodec",
  "duration",
  "fileSize",
  "percentComplete",
  "isTranscode",
  "player",
  "streamResolution",
] as const;

export const API_OPERATIONS: readonly Operation[] = [
  {
    method: "get",
    path: "/me",
    scope: null,
    tag: "Key",
    summary: "The calling key",
    description: "Its id, name, prefix, scopes (only ones this version grants), expiry, creation and last use. Works with any valid key.",
  },
  {
    method: "get",
    path: "/openapi.json",
    scope: null,
    tag: "Key",
    summary: "This OpenAPI document",
    description: "Works with any valid key.",
  },
  {
    method: "get",
    path: "/system/info",
    scope: "system:read",
    tag: "System",
    summary: "App version, database size and counts",
  },
  { method: "get", path: "/servers", scope: "servers:read", tag: "Servers and syncs", summary: "Media servers with their libraries and latest sync (tokens masked; addresses, machine ids and owner omitted)" },
  { method: "get", path: "/sync/status", scope: "servers:read", tag: "Servers and syncs", summary: "Running and recent sync jobs (server addresses and machine ids omitted, errors redacted)" },
  {
    method: "post",
    path: "/servers/{id}/sync",
    scope: "sync:write",
    tag: "Servers and syncs",
    summary: "Sync one server",
    body: {
      description: "Optionally one library.",
      schema: { type: "object", properties: { libraryKey: { type: "string", maxLength: 200 } } },
    },
    responses: { "409": "A sync is already running for this server" },
  },
  {
    method: "post",
    path: "/sync/cancel",
    scope: "sync:write",
    tag: "Servers and syncs",
    summary: "Stop a server's running or queued sync",
    body: { description: "", required: true, schema: { type: "object", required: ["serverId"], properties: { serverId: { type: "string" } } } },
  },
  {
    method: "post",
    path: "/jobs/sync",
    scope: "sync:write",
    tag: "Servers and syncs",
    summary: "Queue a sync of every enabled server",
    description: "The Settings “Run now” job. Servers already syncing are skipped.",
    responses: { "202": "Queued: `{ queued: true, jobs }`, `jobs` being how many servers were queued", "500": "A sync could not be queued" },
  },
  { method: "get", path: "/media/movies", scope: "media:read", tag: "Library", summary: "Movies", query: [...LIST_PAGING, ...LIBRARY_FILTERS] },
  {
    method: "get",
    path: "/media/series",
    scope: "media:read",
    tag: "Library",
    summary: "Episodes",
    query: [...LIST_PAGING, ...LIBRARY_FILTERS, { name: "seriesKey", description: "One show." }, { name: "seasonNumber", description: "One season.", schema: { type: "integer" } }],
  },
  {
    method: "get",
    path: "/media/series/grouped",
    scope: "media:read",
    tag: "Library",
    summary: "Shows, with episode and watched counts",
    query: [...LIST_PAGING, { name: "search", description: "Title search." }, { name: "startsWith", description: "First letter, or `#`." }, { name: "serverId", description: "Limit to one media server." }],
  },
  {
    method: "get",
    path: "/media/series/seasons",
    scope: "media:read",
    tag: "Library",
    summary: "Seasons of one show",
    query: [{ name: "seriesKey", description: "From the grouped listing.", required: true }],
  },
  {
    method: "get",
    path: "/media/music",
    scope: "media:read",
    tag: "Library",
    summary: "Tracks",
    query: [...LIST_PAGING, ...LIBRARY_FILTERS, { name: "parentTitle", description: "Artist." }, { name: "albumTitle", description: "Album." }],
  },
  { method: "get", path: "/media/music/grouped", scope: "media:read", tag: "Library", summary: "Artists" },
  {
    method: "get",
    path: "/media/music/albums",
    scope: "media:read",
    tag: "Library",
    summary: "Albums of one artist",
    query: [{ name: "parentTitle", description: "Artist.", required: true }],
  },
  {
    method: "get",
    path: "/media/search",
    scope: "media:read",
    tag: "Library",
    summary: "Search by title",
    query: [{ name: "q", description: "Search text.", required: true }, { name: "type", description: "Library type.", schema: MEDIA_TYPE, required: true }],
  },
  {
    method: "get",
    path: "/media/recently-added",
    scope: "media:read",
    tag: "Library",
    summary: "Newest additions",
    query: [{ name: "limit", description: "1–50.", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } }, { name: "type", description: "Library type.", schema: MEDIA_TYPE }, { name: "serverId", description: "Limit to one media server." }],
  },
  { method: "get", path: "/media/stats", scope: "media:read", tag: "Library", summary: "Library totals and breakdowns", query: [{ name: "serverId", description: "Limit to one media server." }] },
  {
    method: "get",
    path: "/media/history",
    scope: "media:read",
    tag: "Library",
    summary: "Play history",
    description:
      "One row per play, newest first by default, with `pagination.totalCount` and the distinct `usernames`, `deviceNames` and `platforms` for filter pickers. `sortBy=title` sorts by the displayed title (the show or artist, then season and episode for episodes, then the title); `resolution`/`streamResolution` by the resolution label from lowest to highest; `type` by its label (Movie, Music, Series). Values without one sort last in either direction.",
    query: [
      { name: "page", description: "1-based page number.", schema: { type: "integer", minimum: 1, default: 1 } },
      { name: "limit", description: "Rows per page, 1–200.", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      { name: "search", description: "Matches the title or the show/artist." },
      { name: "startsWith", description: "First letter of the sort title, or `#` for titles not starting with a letter." },
      { name: "serverId", description: "Limit to one media server." },
      { name: "type", description: "Pipe-separated library types, e.g. `MOVIE|SERIES`.", schema: { type: "string" } },
      { name: "username", description: "Pipe-separated media-server usernames." },
      { name: "deviceName", description: "Pipe-separated device names." },
      { name: "platform", description: "Pipe-separated platforms." },
      { name: "resolution", description: "Pipe-separated file resolutions. A label — `4K`, `1080P`, `720P`, `480P`, `SD` or `Other`, in any case — matches every file shown under it (`2160` and `4k` are both `4K`, `1024p` is `1080P`, a missing or unrecognised resolution is `Other`); any other value matches the stored resolution, ignoring case." },
      { name: "dynamicRange", description: "Pipe-separated dynamic ranges, e.g. `HDR10|Dolby Vision`." },
      { name: "videoCodec", description: "Pipe-separated video codecs." },
      { name: "audioCodec", description: "Pipe-separated audio codecs." },
      { name: "sortBy", description: "Field to sort by; anything else sorts by `watchedAt`.", schema: { type: "string", enum: [...OPENAPI_HISTORY_SORT_KEYS], default: "watchedAt" } },
      { name: "sortOrder", description: "Sort direction.", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } },
    ],
  },
  { method: "get", path: "/media/{id}", scope: "media:read", tag: "Library", summary: "One item with streams, external ids and file details (file path and server addresses omitted)" },
  {
    method: "get",
    path: "/media/{id}/plays",
    scope: "media:read",
    tag: "Library",
    summary: "One item's plays",
    query: [{ name: "page", description: "1-based page number.", schema: { type: "integer", minimum: 1 } }, { name: "limit", description: "At most 200.", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "serverId", description: "Limit to one media server." }],
  },
  {
    method: "get",
    path: "/media/{id}/image",
    scope: "media:read",
    tag: "Library",
    summary: "Artwork",
    binary: "image/webp",
    query: [{ name: "type", description: "Which artwork; poster by default.", schema: { type: "string", enum: ["art", "parent", "season"] } }, { name: "w", description: "Width.", schema: { type: "integer", enum: [400, 640, 800] } }],
  },
  { method: "get", path: "/lifecycle/rules", scope: "lifecycle:read", tag: "Lifecycle", summary: "Rule sets" },
  { method: "get", path: "/lifecycle/rules/matches", scope: "lifecycle:read", tag: "Lifecycle", summary: "Current matches per rule set", description: `Each match carries the item snapshot detection stored, without its file path. Not paged: every read counts as ${FULL_LISTING_REQUEST_COST} requests.` },
  {
    method: "get",
    path: "/lifecycle/actions",
    scope: "lifecycle:read",
    tag: "Lifecycle",
    summary: "Actions by status",
    description: `A series action's \`mediaItem.title\` is the show, or \`<Show> SxxExx\` when it acts on a single episode, and its \`parentTitle\` is null. Each action's \`error\` is redacted of internal addresses and paths. Not paged: every read counts as ${FULL_LISTING_REQUEST_COST} requests.`,
    query: [{ name: "status", description: "Which actions.", schema: { type: "string", enum: ["PENDING", "COMPLETED", "FAILED", "ALL"], default: "PENDING" } }],
  },
  {
    method: "get",
    path: "/lifecycle/exceptions",
    scope: "lifecycle:read",
    tag: "Lifecycle",
    summary: "Exceptions",
    description: `Not paged: every read counts as ${FULL_LISTING_REQUEST_COST} requests.`,
    query: [{ name: "type", description: "Library type, or ALL.", schema: { type: "string", enum: ["MOVIE", "SERIES", "MUSIC", "ALL"] } }],
  },
  { method: "get", path: "/lifecycle/stats", scope: "lifecycle:read", tag: "Lifecycle", summary: "Deletion statistics" },
  {
    method: "post",
    path: "/lifecycle/exceptions",
    scope: "lifecycle:write",
    tag: "Lifecycle",
    summary: "Exclude an item from every rule",
    body: {
      description: "",
      required: true,
      schema: {
        type: "object",
        required: ["mediaItemId"],
        properties: {
          mediaItemId: { type: "string" },
          reason: { type: "string", maxLength: 1000 },
          scope: { type: "string", enum: ["individual", "series", "artist", "album"], default: "individual" },
        },
      },
    },
  },
  {
    method: "post",
    path: "/jobs/detection",
    scope: "lifecycle:write",
    tag: "Lifecycle",
    summary: "Queue lifecycle detection for every enabled rule set",
    responses: { "202": "Queued: `{ queued: true, jobs: 1 }`" },
  },
  {
    method: "delete",
    path: "/lifecycle/exceptions",
    scope: "lifecycle:execute",
    tag: "Lifecycle",
    summary: "Remove exceptions",
    description:
      `Removing an exception lets the rules match the item again, which can lead to its deletion — hence the destructive scope. ` +
      `At most ${PER_REQUEST} per request, and each removal counts against the API's ${PER_HOUR}-an-hour deletion budget.`,
    body: { description: "", required: true, schema: { type: "object", required: ["ids"], additionalProperties: false, properties: { ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: PER_REQUEST } } } },
    responses: { "429": BUDGET_429 },
  },
  {
    method: "delete",
    path: "/lifecycle/exceptions/{id}",
    scope: "lifecycle:execute",
    tag: "Lifecycle",
    summary: "Remove one exception",
    description: `Counts against the API's ${PER_HOUR}-an-hour deletion budget.`,
    responses: { "429": BUDGET_429 },
  },
  {
    method: "post",
    path: "/lifecycle/actions/execute",
    scope: "lifecycle:execute",
    tag: "Lifecycle",
    summary: "Run a rule set's action now on named matches",
    description:
      `Acts only on the listed items that are current matches of the rule set; name every item (there is no "every match"). ` +
      `At most ${PER_REQUEST} items per request. When the action deletes (Sonarr, Radarr or Lidarr), the items count against the ` +
      `${PER_HOUR}-an-hour deletion budget every key shares. The rule set must be enabled with actions turned on. ` +
      `Refused whole — nothing runs — when an item is excepted, when an item changed identity since it matched (409: run detection again), ` +
      `when the rule set reads play activity and a server it targets has no established play history (409), ` +
      `or when a limit would be exceeded. One execution runs per rule set at a time: an overlapping call is refused (409) rather than repeating the deletions.`,
    body: {
      description: "",
      required: true,
      schema: {
        type: "object",
        required: ["ruleSetId", "mediaItemIds"],
        additionalProperties: false,
        properties: { ruleSetId: { type: "string" }, mediaItemIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: PER_REQUEST } },
      },
    },
    responses: {
      "200": "`{ executed, failed, errors }`",
      "409": "An execution is already running for this rule set, an item changed identity since it matched (a re-match on the media server), or the rule set reads play activity while a server it targets has no established play history; nothing was executed",
      "429": BUDGET_429,
    },
  },
  {
    method: "post",
    path: "/jobs/execution",
    scope: "lifecycle:execute",
    tag: "Lifecycle",
    summary: "Queue lifecycle execution of every due pending action",
    description:
      `A run queued here is held — nothing deleted, every action left pending for the schedule or the Pending page — ` +
      `when it would delete more than ${PER_REQUEST} items or exceed the ${PER_HOUR}-an-hour deletion budget.`,
    responses: { "202": "Queued: `{ queued: true, jobs: 1 }`" },
  },
  { method: "get", path: "/tools/sessions", scope: "streams:read", tag: "Streams", summary: "Active playback sessions on every enabled server", description: "Who is watching what, on which player and from which address. The path of the file being played is omitted." },
  { method: "get", path: "/tools/maintenance", scope: "streams:read", tag: "Streams", summary: "Maintenance mode status" },
  {
    method: "post",
    path: "/tools/sessions/terminate",
    scope: "streams:write",
    tag: "Streams",
    summary: "Stop playback",
    description: "Omit `sessionIds` to stop every stream on the server; `serverId` may be `all`. Session ids are the `sessionId` values `/tools/sessions` returns (letters, digits, `-` and `_`).",
    body: {
      description: "",
      required: true,
      schema: {
        type: "object",
        required: ["serverId", "message"],
        properties: { serverId: { type: "string" }, sessionIds: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, maxItems: 200 }, message: { type: "string", minLength: 1, maxLength: 500 } },
      },
    },
  },
  {
    method: "put",
    path: "/tools/maintenance",
    scope: "streams:write",
    tag: "Streams",
    summary: "Turn maintenance mode on or off",
    description: "`message` and `delay` keep their current values when left out. Any other field is refused.",
    body: {
      description: "",
      required: true,
      schema: {
        type: "object",
        required: ["enabled"],
        additionalProperties: false,
        properties: { enabled: { type: "boolean" }, message: { type: "string", maxLength: 500 }, delay: { type: "integer", minimum: 0, maximum: 3600 } },
      },
    },
  },
];

const ERROR_RESPONSES: Record<string, string> = {
  "400": "Bad request: invalid body or parameters, a key in the URL, or two different keys in the headers",
  "401": "No key, an unknown or deleted key, or an expired key (`WWW-Authenticate: Bearer`)",
  "403": "The key lacks the required scope; `requiredScope` names it",
  "429": "Rate limited; wait `Retry-After` seconds",
};

function errorResponse(description: string) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

/** `get /media/{id}/image` → `getMediaByIdImage`. */
export function operationId(method: Method, path: string): string {
  const words = path.replace(/\{(\w+)\}/g, "by-$1").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return method + words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    description: "A Librariarr id, as returned by the listing endpoints.",
    schema: { type: "string" },
  }));
}

interface OpenApiDocumentOptions {
  /**
   * Make `baseUrl` a template the reader fills in (`{baseUrl}` with a default),
   * for a document published away from any instance — the docs site — where
   * "Try it out" should run against whatever address the reader types.
   */
  serverVariables?: Record<string, { default: string; description?: string }>;
}

/** The OpenAPI document for `/api/v1`, served at `baseUrl` (`""` for the relative `/api/v1`). */
export function buildOpenApiDocument(
  baseUrl: string,
  version: string,
  options: OpenApiDocumentOptions = {},
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    const responses: Record<string, unknown> = {};
    for (const [status, description] of Object.entries(op.responses ?? {})) {
      responses[status] = status.startsWith("2")
        ? { description, content: { "application/json": { schema: { type: "object" } } } }
        : errorResponse(description);
    }
    if (!Object.keys(responses).some((s) => s.startsWith("2"))) {
      responses["200"] = op.binary
        ? { description: "OK", content: { [op.binary]: { schema: { type: "string", format: "binary" } } } }
        : { description: "OK", content: { "application/json": { schema: { type: "object" } } } };
    }
    for (const [status, description] of Object.entries(ERROR_RESPONSES)) responses[status] ??= errorResponse(description);
    if (op.path.includes("{")) responses["404"] ??= errorResponse("Not found");

    const scopeLine = op.scope ? `Scope: \`${op.scope}\`.` : "Any valid key.";
    paths[op.path] ??= {};
    paths[op.path][op.method] = {
      operationId: operationId(op.method, op.path),
      tags: [op.tag],
      summary: op.summary,
      description: [scopeLine, op.description].filter(Boolean).join(" "),
      "x-scope": op.scope,
      parameters: [
        ...pathParams(op.path),
        ...(op.query ?? []).map((q) => ({
          name: q.name,
          in: "query",
          required: q.required ?? false,
          description: q.description,
          schema: q.schema ?? { type: "string" },
        })),
      ],
      ...(op.body && {
        requestBody: {
          required: op.body.required ?? false,
          ...(op.body.description && { description: op.body.description }),
          content: { "application/json": { schema: op.body.schema } },
        },
      }),
      responses,
      security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    };
  }

  const scopeTable = API_SCOPES.map((s) => `- \`${s}\` — ${API_SCOPE_INFO[s].description}`).join("\n");

  return {
    openapi: "3.1.0",
    info: {
      title: "Librariarr API",
      version,
      description: [
        "The public API for third-party applications. Every request is authenticated with an API key issued under Settings → Authentication → API Keys, sent as `Authorization: Bearer <key>` or `X-Api-Key: <key>` — never in the URL, where it is refused.",
        "Each operation names the scope its key needs (`x-scope`). A read-only key holds every read scope.",
        "",
        "Scopes:",
        scopeTable,
        "",
        `Rate limits: 600 requests per minute per key (a \`limit=0\` listing, and any read of a listing without paging, counts as ${FULL_LISTING_REQUEST_COST}). Errors are \`{ error }\`, sometimes with \`details\`.`,
        "",
        `Deletion limits: a request can delete (or remove the exception of) at most ${PER_REQUEST} items, and every key together at most ${PER_HOUR} an hour. Every item must be named; nothing acts on "all matches".`,
      ].join("\n"),
    },
    servers: [
      {
        url: `${baseUrl}/api/v1`,
        ...(options.serverVariables && { variables: options.serverVariables }),
      },
    ],
    tags: ["Key", "Library", "Servers and syncs", "Lifecycle", "Streams", "System"].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "`Authorization: Bearer lbr_…`" },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-Api-Key" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            details: { type: "array", items: { type: "string" }, description: "Validation failures" },
            requiredScope: { type: "string" },
          },
        },
      },
    },
  };
}
