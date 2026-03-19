// Action type constants for UI dropdowns — client-safe (no server imports)

export const MOVIE_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_RADARR", label: "Delete from Radarr" },
  { value: "UNMONITOR_DELETE_FILES_RADARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_RADARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_RADARR", label: "Delete Files Only" },
  { value: "UNMONITOR_RADARR", label: "Unmonitor Only" },
];

export const SERIES_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_SONARR", label: "Delete from Sonarr" },
  { value: "UNMONITOR_DELETE_FILES_SONARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_SONARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_SONARR", label: "Delete Files Only" },
  { value: "UNMONITOR_SONARR", label: "Unmonitor Only" },
];

export const MUSIC_ACTION_TYPES = [
  { value: "DO_NOTHING", label: "Do Nothing" },
  { value: "DELETE_LIDARR", label: "Delete from Lidarr" },
  { value: "UNMONITOR_DELETE_FILES_LIDARR", label: "Unmonitor & Delete Files" },
  { value: "MONITOR_DELETE_FILES_LIDARR", label: "Monitor & Delete Files" },
  { value: "DELETE_FILES_LIDARR", label: "Delete Files Only" },
  { value: "UNMONITOR_LIDARR", label: "Unmonitor Only" },
];
