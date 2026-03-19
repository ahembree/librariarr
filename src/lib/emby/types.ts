// Emby and Jellyfin share nearly identical API response shapes.
// Re-export Jellyfin types — override only if Emby diverges.
export type {
  JellyfinPublicInfo as EmbyPublicInfo,
  JellyfinLibrary as EmbyLibrary,
  JellyfinItem as EmbyItem,
  JellyfinMediaSource as EmbyMediaSource,
  JellyfinMediaStream as EmbyMediaStream,
  JellyfinSession as EmbySession,
  JellyfinItemsResponse as EmbyItemsResponse,
} from "@/lib/jellyfin/types";
