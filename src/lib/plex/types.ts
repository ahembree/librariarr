// Re-export canonical types so existing `@/lib/plex/types` imports still resolve.
// New code should import from `@/lib/media-server/types` instead.
export type {
  MediaLibrarySection as PlexLibrarySection,
  MediaStream as PlexMediaStream,
  MediaPart as PlexMediaPart,
  MediaInfo as PlexMedia,
  MediaTag as PlexTag,
  MediaRole as PlexRole,
  MediaMetadataItem as PlexMetadataItem,
  MediaCollection as PlexCollection,
  MediaSession as PlexSession,
} from "@/lib/media-server/types";

// --- Plex-only types (not used by Jellyfin/Emby) ---

export interface PlexPin {
  id: number;
  code: string;
  product: string;
  clientIdentifier: string;
  expiresIn: number;
  createdAt: string;
  expiresAt: string;
  authToken: string | null;
}

export interface PlexUser {
  id: number;
  uuid: string;
  email: string;
  username: string;
  authToken: string;
  thumb: string;
}

export interface PlexResource {
  name: string;
  product: string;
  productVersion: string;
  platform: string;
  platformVersion: string;
  device: string;
  clientIdentifier: string;
  provides: string;
  owned: boolean;
  accessToken: string;
  publicAddress: string;
  httpsRequired: boolean;
  connections: PlexConnection[];
}

export interface PlexConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
}

export interface PlexManagedHub {
  identifier: string;
  promotedToOwnHome: number | boolean;
  promotedToRecommended: number | boolean;
  promotedToSharedHome: number | boolean;
}
