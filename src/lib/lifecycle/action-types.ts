// Action type constants for UI dropdowns — client-safe (no server imports)

export const MOVIE_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_RADARR", label: "Delete from Radarr" },
  { value: "UNMONITOR_DELETE_FILES_RADARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_RADARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_RADARR", label: "Delete Files Only" },
  { value: "UNMONITOR_RADARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_RADARR", label: "Change Quality Profile" },
];

export const SERIES_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_SONARR", label: "Delete from Sonarr" },
  { value: "UNMONITOR_DELETE_FILES_SONARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_SONARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_SONARR", label: "Delete Files Only" },
  { value: "UNMONITOR_SONARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_SONARR", label: "Change Quality Profile" },
];

export const MUSIC_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_LIDARR", label: "Delete from Lidarr" },
  { value: "UNMONITOR_DELETE_FILES_LIDARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_LIDARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_LIDARR", label: "Delete Files Only" },
  { value: "UNMONITOR_LIDARR", label: "Unmonitor Only" },
  { value: "CHANGE_QUALITY_PROFILE_LIDARR", label: "Change Quality Profile" },
];

/** Action types that change a Sonarr/Radarr/Lidarr item's quality profile. */
export const QUALITY_PROFILE_ACTION_TYPES = new Set<string>([
  "CHANGE_QUALITY_PROFILE_RADARR",
  "CHANGE_QUALITY_PROFILE_SONARR",
  "CHANGE_QUALITY_PROFILE_LIDARR",
]);
