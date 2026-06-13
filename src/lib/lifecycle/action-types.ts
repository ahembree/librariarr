// Action type constants for UI dropdowns — client-safe (no server imports)

export const MOVIE_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_RADARR", label: "Delete from Radarr" },
  { value: "UNMONITOR_DELETE_FILES_RADARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_RADARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_RADARR", label: "Delete Files Only" },
  { value: "UNMONITOR_RADARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_RADARR", label: "Change Quality Profile" },
  { value: "SEARCH_RADARR", label: "Search for New Copy" },
];

export const SERIES_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_SONARR", label: "Delete from Sonarr" },
  { value: "UNMONITOR_DELETE_FILES_SONARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_SONARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_SONARR", label: "Delete Files Only" },
  { value: "UNMONITOR_SONARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_SONARR", label: "Change Quality Profile" },
  { value: "SEARCH_SONARR", label: "Search for New Copy" },
];

export const MUSIC_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_LIDARR", label: "Delete from Lidarr" },
  { value: "UNMONITOR_DELETE_FILES_LIDARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_LIDARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_LIDARR", label: "Delete Files Only" },
  { value: "UNMONITOR_LIDARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_LIDARR", label: "Change Quality Profile" },
  { value: "SEARCH_LIDARR", label: "Search for New Copy" },
];

/**
 * Action types whose executor acts only on the matched member ids
 * (`matchedMediaItemIds`, falling back to the action's own track for
 * track-scope music rules) — i.e. Sonarr episode-file and Lidarr track-file
 * deletes. Every OTHER destructive action operates on the WHOLE Arr record
 * (series / artist / movie) and ignores the member list, so a partially-
 * excepted member set cannot be honored by them.
 */
export const MEMBER_SCOPED_ACTION_TYPES = new Set<string>([
  "UNMONITOR_DELETE_FILES_SONARR",
  "MONITOR_DELETE_FILES_SONARR",
  "DELETE_FILES_SONARR",
  "UNMONITOR_DELETE_FILES_LIDARR",
  "MONITOR_DELETE_FILES_LIDARR",
  "DELETE_FILES_LIDARR",
]);

export function actionHonorsMemberIds(actionType: string): boolean {
  return MEMBER_SCOPED_ACTION_TYPES.has(actionType);
}

/** Whether the action removes media/files (not just monitoring/quality). */
export function isDestructiveActionType(actionType: string): boolean {
  return actionType.includes("DELETE");
}

/** Action types that change a Sonarr/Radarr/Lidarr item's quality profile. */
export const QUALITY_PROFILE_ACTION_TYPES = new Set<string>([
  "CHANGE_QUALITY_PROFILE_RADARR",
  "CHANGE_QUALITY_PROFILE_SONARR",
  "CHANGE_QUALITY_PROFILE_LIDARR",
]);

/** Human-readable labels for every action type (notifications, summaries). */
export const ACTION_LABELS: Record<string, string> = {
  DO_NOTHING: "Monitor Only",
  DELETE_RADARR: "Delete from Radarr",
  DELETE_SONARR: "Delete from Sonarr",
  DELETE_LIDARR: "Delete from Lidarr",
  UNMONITOR_RADARR: "Unmonitor in Radarr",
  UNMONITOR_SONARR: "Unmonitor in Sonarr",
  UNMONITOR_LIDARR: "Unmonitor in Lidarr",
  UNMONITOR_DELETE_FILES_RADARR: "Unmonitor & Delete Files (Radarr)",
  UNMONITOR_DELETE_FILES_SONARR: "Unmonitor & Delete Files (Sonarr)",
  UNMONITOR_DELETE_FILES_LIDARR: "Unmonitor & Delete Files (Lidarr)",
  MONITOR_DELETE_FILES_RADARR: "Monitor & Delete Files (Radarr)",
  MONITOR_DELETE_FILES_SONARR: "Monitor & Delete Files (Sonarr)",
  MONITOR_DELETE_FILES_LIDARR: "Monitor & Delete Files (Lidarr)",
  DELETE_FILES_RADARR: "Delete Files (Radarr)",
  DELETE_FILES_SONARR: "Delete Files (Sonarr)",
  DELETE_FILES_LIDARR: "Delete Files (Lidarr)",
  CHANGE_QUALITY_PROFILE_RADARR: "Change Quality Profile (Radarr)",
  CHANGE_QUALITY_PROFILE_SONARR: "Change Quality Profile (Sonarr)",
  CHANGE_QUALITY_PROFILE_LIDARR: "Change Quality Profile (Lidarr)",
  SEARCH_RADARR: "Search for New Copy (Radarr)",
  SEARCH_SONARR: "Search for New Copy (Sonarr)",
  SEARCH_LIDARR: "Search for New Copy (Lidarr)",
};

/** Format an action type for display, falling back to the raw value. */
export function formatActionLabel(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}
