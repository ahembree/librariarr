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
 * (`matchedMediaItemIds`) when present — i.e. Sonarr episode-file deletes.
 * Every OTHER destructive action operates on the WHOLE Arr record (series /
 * artist / movie) and ignores the member list, so a partially-excepted
 * member set cannot be honored by them.
 */
export const MEMBER_SCOPED_ACTION_TYPES = new Set<string>([
  "UNMONITOR_DELETE_FILES_SONARR",
  "MONITOR_DELETE_FILES_SONARR",
  "DELETE_FILES_SONARR",
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
