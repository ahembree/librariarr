import type { ChipColorMap, ChipColorCategory } from "@/lib/theme/chip-colors";

// ─── Server types ───

export interface PlexConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

export interface PlexServer {
  name: string;
  clientIdentifier: string;
  connections: PlexConnection[];
}

export interface MediaServer {
  id: string;
  name: string;
  url: string;
  type: string;
  machineId: string | null;
  tlsSkipVerify: boolean;
  enabled: boolean;
  /**
   * Tracearr `server_id` this server's watch history is pulled from, or null
   * for the server's own (native) history. Only the id is stored — which
   * Tracearr instance owns it is resolved by looking the id up in the enabled
   * instances' server lists.
   */
  tracearrServerId: string | null;
  createdAt: string;
  libraries: {
    id: string;
    key: string;
    title: string;
    type: string;
    enabled: boolean;
    lastSyncedAt: string | null;
    _count: { mediaItems: number };
  }[];
  syncJobs: {
    id: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    itemsProcessed: number;
    totalItems: number;
    currentLibrary: string | null;
    error: string | null;
  }[];
}

export interface ArrInstance {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  externalUrl: string | null;
  enabled: boolean;
  createdAt: string;
}

export type SeerrInstance = ArrInstance;

/**
 * A configured Tracearr connection. `apiKey` always arrives masked
 * (`MASKED_VALUE` from `sanitize()`); the edit form echoes it back untouched
 * and `tracearrInstanceUpdateSchema` maps the mask to "keep the stored key".
 */
export interface TracearrInstance {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  createdAt: string;
}

/**
 * One media server a Tracearr instance monitors, from
 * `GET /api/integrations/tracearr/[id]/servers`. Mirrors `TracearrServerStatus`
 * in `src/lib/tracearr/tracearr-client.ts` — declared locally because this file
 * is the settings surface's own vocabulary (like `MediaServer` above, which
 * mirrors the Prisma model rather than importing it).
 */
export interface TracearrServerStatus {
  id: string;
  name: string;
  type: "plex" | "jellyfin" | "emby";
  online: boolean;
  activeStreams: number;
}

/**
 * Per-instance fetch state for the server list behind the watch-history-source
 * dropdown. `error` is kept distinct from an empty `servers` array on purpose:
 * "we couldn't ask Tracearr" and "Tracearr monitors nothing" must not render
 * the same way, or a transient failure looks like a configuration fact.
 */
export interface TracearrServerListState {
  loading: boolean;
  error: string | null;
  servers: TracearrServerStatus[];
}

// ─── Schedule types ───

export interface ScheduleInfo {
  scheduledJobTime: string;
  timezone: string;
  sync: { nextRun: string | null; lastRun: string | null };
  detection: { nextRun: string | null; lastRun: string | null };
  execution: { nextRun: string | null; lastRun: string | null };
}

// ─── Settings / System types ───

export interface AuthInfo {
  plexConnected: boolean;
  localUsername: string | null;
  hasPassword: boolean;
  localAuthEnabled: boolean;
  plexLoginEnabled: boolean;
  /** True when SSO is currently usable and is hiding the local form on the
   *  login page (regardless of the localAuthEnabled DB value). */
  localAuthHiddenBySso?: boolean;
  displayName: string;
}

export interface UpdateInfo {
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  checkedAt: string;
}

export interface SystemInfo {
  appVersion: string;
  latestMigration: string;
  databaseSize: string;
  stats: { mediaItems: number; enabledLibraries: number; totalLibraries: number; servers: number };
  updateInfo?: UpdateInfo;
}

export interface ImageCacheStats {
  fileCount: number;
  totalSize: number;
}

export interface ReleaseNote {
  version: string;
  name: string | null;
  body: string;
  url: string;
  publishedAt: string;
  isCurrent: boolean;
  isLatest: boolean;
}

export interface TestResult {
  ok: boolean;
  error?: string;
  appName?: string;
  version?: string;
  /** Tracearr only: how many media servers the instance monitors. */
  serverCount?: number;
}

export interface BackupEntry {
  filename: string;
  createdAt: string;
  size: number;
  tables?: Record<string, number>;
  encrypted: boolean;
  configOnly?: boolean;
}

// ─── Constants ───

export const SCHEDULE_OPTIONS = [
  { value: "MANUAL", label: "Manual only" },
  { value: "EVERY_6H", label: "Every 6 hours" },
  { value: "EVERY_12H", label: "Every 12 hours" },
  { value: "DAILY", label: "Daily" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "CUSTOM", label: "Custom (cron)" },
];

export const PRESET_VALUES = SCHEDULE_OPTIONS.filter((o) => o.value !== "CUSTOM").map((o) => o.value);

// Re-export chip color types for tab use
export type { ChipColorMap, ChipColorCategory };
