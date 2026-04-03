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
