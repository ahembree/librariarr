import { JellyfinCompatClient, ITEM_FIELDS } from "@/lib/media-server/jellyfin-base";
import type { MediaServerClientOptions } from "@/lib/media-server/client";
import type { MediaMetadataItem, WatchHistoryEntry } from "@/lib/media-server/types";
import type { JellyfinItem } from "@/lib/jellyfin/types";

export class EmbyClient extends JellyfinCompatClient {
  protected get logPrefix(): string {
    return "Emby";
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      "X-Emby-Token": this.token,
    };
  }

  constructor(
    baseURL: string,
    token: string,
    options?: MediaServerClientOptions
  ) {
    super(baseURL, token, options);
  }

  /** Emby spec: GET /Users/{UserId}/Items/{Id} */
  async getItemMetadata(ratingKey: string): Promise<MediaMetadataItem> {
    const userId = await this.getUserId();
    const response = await this.client.get<JellyfinItem>(
      `/Users/${userId}/Items/${ratingKey}`,
      {
        params: { Fields: ITEM_FIELDS },
      }
    );
    return this.normalizeItem(response.data);
  }

  /** Emby spec: GET /Users/{UserId}/Items/{Id} (per-user watch data) */
  async getWatchHistory(ratingKey: string): Promise<WatchHistoryEntry[]> {
    try {
      const usersRes = await this.client.get<
        Array<{ Id: string; Name: string }>
      >("/Users");
      const users = usersRes.data || [];

      const entries: WatchHistoryEntry[] = [];

      for (const user of users) {
        try {
          const itemRes = await this.client.get<JellyfinItem>(
            `/Users/${user.Id}/Items/${ratingKey}`
          );
          const userData = itemRes.data.UserData;
          if (userData && userData.PlayCount > 0) {
            for (let i = 0; i < userData.PlayCount; i++) {
              entries.push({
                username: user.Name,
                watchedAt:
                  i === 0 && userData.LastPlayedDate
                    ? new Date(userData.LastPlayedDate).toISOString()
                    : null,
              });
            }
          }
        } catch {
          // Skip users where we can't access the item
        }
      }

      return entries.sort((a, b) => {
        if (!a.watchedAt && !b.watchedAt) return 0;
        if (!a.watchedAt) return 1;
        if (!b.watchedAt) return -1;
        return (
          new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime()
        );
      });
    } catch {
      return [];
    }
  }
}
