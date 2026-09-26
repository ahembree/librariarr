/**
 * The permissions an API key can hold — the single registry the `/api/v1`
 * guard, the key-management routes, the validation schema and the settings UI
 * all read, so a scope cannot mean one thing to the server and another on
 * screen.
 *
 * Client-safe: no Node imports.
 *
 * Every `/api/v1` handler names exactly one scope (see `withApiKey`), and
 * `tests/unit/api-keys/v1-routes.test.ts` holds every GET to a `read` scope and
 * every other method to a `write` scope — which is what makes a key without a
 * write scope unable to change anything, structurally rather than by review.
 */

export const API_SCOPES = [
  "media:read",
  "servers:read",
  "sync:write",
  "lifecycle:read",
  "lifecycle:write",
  "lifecycle:execute",
  "streams:read",
  "streams:write",
  "system:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiScopeInfo {
  label: string;
  description: string;
  access: "read" | "write";
  /**
   * Read scopes this write scope is useless without. Added to the key when it
   * is created (see `normalizeScopes`) rather than implied at check time, so
   * the stored list is exactly what the key can do.
   */
  implies?: readonly ApiScope[];
  /** Can destroy data — deleting media through Sonarr/Radarr/Lidarr. */
  destructive?: boolean;
}

export const API_SCOPE_INFO: Record<ApiScope, ApiScopeInfo> = {
  "media:read": {
    label: "Read library",
    description:
      "Browse and search movies, series and music; item details, artwork, library stats and watch history.",
    access: "read",
  },
  "servers:read": {
    label: "Read servers",
    description:
      "List media servers and their libraries, and read sync status. Server tokens are never returned.",
    access: "read",
  },
  "sync:write": {
    label: "Run syncs",
    description: "Start and cancel library syncs.",
    access: "write",
    implies: ["servers:read"],
  },
  "lifecycle:read": {
    label: "Read lifecycle",
    description:
      "Rule sets, matches, pending and completed actions, exceptions and deletion stats.",
    access: "read",
  },
  "lifecycle:write": {
    label: "Manage lifecycle",
    description: "Run lifecycle detection and add or remove exceptions.",
    access: "write",
    implies: ["lifecycle:read"],
  },
  "lifecycle:execute": {
    label: "Execute lifecycle actions",
    description:
      "Run pending lifecycle actions. This can delete media through Sonarr, Radarr and Lidarr.",
    access: "write",
    implies: ["lifecycle:read"],
    destructive: true,
  },
  "streams:read": {
    label: "Read streams",
    description: "Active playback sessions and maintenance mode status.",
    access: "read",
  },
  "streams:write": {
    label: "Control streams",
    description: "Terminate playback sessions and turn maintenance mode on or off.",
    access: "write",
    implies: ["streams:read"],
  },
  "system:read": {
    label: "Read system info",
    description: "App version, database and library counts.",
    access: "read",
  },
};

/** Scopes grouped the way the settings UI lays them out. */
export const API_SCOPE_GROUPS: ReadonlyArray<{ label: string; scopes: readonly ApiScope[] }> = [
  { label: "Library", scopes: ["media:read"] },
  { label: "Servers & sync", scopes: ["servers:read", "sync:write"] },
  { label: "Lifecycle", scopes: ["lifecycle:read", "lifecycle:write", "lifecycle:execute"] },
  { label: "Streams", scopes: ["streams:read", "streams:write"] },
  { label: "System", scopes: ["system:read"] },
];

/** What a "Read-only" key is issued with: every read scope, nothing else. */
export const READ_ONLY_SCOPES: readonly ApiScope[] = API_SCOPES.filter(
  (s) => API_SCOPE_INFO[s].access === "read",
);

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/**
 * Expand implied read scopes, drop duplicates, and return the result in
 * registry order — the canonical form every key is stored in.
 */
export function normalizeScopes(scopes: readonly ApiScope[]): ApiScope[] {
  const granted = new Set<ApiScope>();
  for (const scope of scopes) {
    granted.add(scope);
    for (const implied of API_SCOPE_INFO[scope].implies ?? []) granted.add(implied);
  }
  return API_SCOPES.filter((s) => granted.has(s));
}

/**
 * True when none of the scopes can change anything. Unknown strings (a scope
 * a newer version stored and this one does not know) are treated as write, so
 * an unrecognised grant can never be presented as harmless.
 */
export function isReadOnlyScopeSet(scopes: readonly string[]): boolean {
  return scopes.every((s) => isApiScope(s) && API_SCOPE_INFO[s].access === "read");
}

/** True when any scope can destroy data. */
export function hasDestructiveScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => isApiScope(s) && API_SCOPE_INFO[s].destructive === true);
}
