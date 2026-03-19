import type { MediaServerType } from "@/generated/prisma/client";
import type {
  MediaServerClient,
  MediaServerClientOptions,
} from "./client";
import { PlexClient } from "@/lib/plex/client";
import { JellyfinClient } from "@/lib/jellyfin/client";
import { EmbyClient } from "@/lib/emby/client";

export function createMediaServerClient(
  type: MediaServerType,
  url: string,
  token: string,
  options?: MediaServerClientOptions
): MediaServerClient {
  switch (type) {
    case "PLEX":
      return new PlexClient(url, token, options);
    case "JELLYFIN":
      return new JellyfinClient(url, token, options);
    case "EMBY":
      return new EmbyClient(url, token, options);
    default:
      throw new Error(`Unsupported media server type: ${type}`);
  }
}
