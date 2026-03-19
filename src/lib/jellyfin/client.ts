import { JellyfinCompatClient } from "@/lib/media-server/jellyfin-base";
import type { MediaServerClientOptions } from "@/lib/media-server/client";

export class JellyfinClient extends JellyfinCompatClient {
  protected get logPrefix(): string {
    return "Jellyfin";
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `MediaBrowser Client="Librariarr", Device="Server", DeviceId="librariarr", Version="1.0.0", Token="${this.token}"`,
    };
  }

  constructor(
    baseURL: string,
    token: string,
    options?: MediaServerClientOptions
  ) {
    super(baseURL, token, options);
  }
}
