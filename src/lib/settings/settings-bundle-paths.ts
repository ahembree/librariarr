/**
 * The GET routes the Settings page reads when it opens, answered together by
 * `GET /api/settings/bundle` (which runs each route's own handler, so the
 * answers are the ones the route gives). Opening Settings cost one request
 * per route — two dozen, each queued behind the browser's six connections per
 * host and each re-checking the session. Later reads (after a save, on an
 * event) still go to the route itself.
 *
 * Only routes whose GET takes no input and only reads (or creates the
 * settings row it reads) belong here.
 */
export const SETTINGS_BUNDLE_PATHS = [
  "/api/servers",
  "/api/settings/sync-schedule",
  "/api/settings/dedup",
  "/api/settings/realtime",
  "/api/tools/realtime/status",
  "/api/integrations/sonarr",
  "/api/integrations/radarr",
  "/api/integrations/lidarr",
  "/api/integrations/seerr",
  "/api/integrations/tracearr",
  "/api/settings/accent-color",
  "/api/settings/chip-colors",
  "/api/settings/log-retention",
  "/api/settings/delete-ceiling",
  "/api/settings/action-retention",
  "/api/settings/backup-schedule",
  "/api/backup",
  "/api/settings/backup-encryption-password",
  "/api/settings/lifecycle-schedule",
  "/api/settings/schedule-info",
  "/api/settings/discord",
  "/api/settings/ai",
  "/api/settings/auth",
  "/api/settings/title-preference",
] as const;

export type SettingsBundlePath = (typeof SETTINGS_BUNDLE_PATHS)[number];

/** One route's answer inside the bundle: its status and parsed JSON body. */
export interface BundledResponse {
  status: number;
  body: unknown;
}
