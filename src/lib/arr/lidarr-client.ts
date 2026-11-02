import { ArrClientBase } from "@/lib/arr/arr-client-base";

export interface LidarrArtist {
  id: number;
  artistName: string;
  foreignArtistId: string;
  qualityProfileId: number;
  metadataProfileId: number;
  monitored: boolean;
  path: string;
  tags: number[];
  ratings?: {
    value: number;
    votes: number;
  };
  statistics?: {
    albumCount: number;
    trackCount: number;
    trackFileCount: number;
    sizeOnDisk: number;
  };
  added?: string;
  // Lidarr artist status: continuing | ended | deleted
  status?: string;
}

interface LidarrAlbum {
  id: number;
  title: string;
}

export interface LidarrTrack {
  id: number;
  albumId: number;
  trackFileId: number;
  title: string;
  hasFile: boolean;
  trackNumber?: string;
  absoluteTrackNumber?: number;
  /** Disc number within the release. */
  mediumNumber?: number;
  /** MusicBrainz release-track id. */
  foreignTrackId?: string;
  /** MusicBrainz recording id. */
  foreignRecordingId?: string;
}

export class LidarrClient extends ArrClientBase {
  constructor(baseURL: string, apiKey: string) {
    super("Lidarr", "v1", baseURL, apiKey);
  }

  async getArtists(): Promise<LidarrArtist[]> {
    const { data } = await this.client.get<LidarrArtist[]>("/api/v1/artist");
    return data;
  }

  async getArtistById(id: number): Promise<LidarrArtist> {
    const { data } = await this.client.get<LidarrArtist>(
      `/api/v1/artist/${id}`
    );
    return data;
  }

  async getArtistByMusicBrainzId(mbId: string): Promise<LidarrArtist | null> {
    // Server-side lookup by MusicBrainz id (mirrors Radarr's ?tmdbId= and
    // Sonarr's ?tvdbId=). Avoids fetching the entire artist library per call.
    const { data } = await this.client.get<LidarrArtist[]>("/api/v1/artist", {
      params: { mbId },
    });
    // Lidarr filters by foreignArtistId — and, for an artist MusicBrainz has
    // merged, by its old ids too, answering with the artist under its NEW id.
    // So a single answer is the artist even when its id differs. Several
    // answers mean the filter was ignored (an older version returning the
    // whole library): only an exact id is trusted then, never `data[0]`.
    const exact = data.find((a) => a.foreignArtistId === mbId);
    if (exact) return exact;
    return data.length === 1 ? data[0] : null;
  }

  async deleteArtist(
    id: number,
    deleteFiles: boolean = true,
    addImportListExclusion: boolean = false
  ): Promise<void> {
    await this.client.delete(`/api/v1/artist/${id}`, {
      params: { deleteFiles, addImportListExclusion },
    });
  }

  /**
   * PUTs `artist` over the record. Pass `current` — the record just read —
   * to skip re-reading it first; without it the record is fetched by id.
   */
  async updateArtist(id: number, artist: Partial<LidarrArtist>, current?: LidarrArtist): Promise<LidarrArtist> {
    const base = current ?? (await this.getArtistById(id));
    const { data } = await this.client.put<LidarrArtist>(
      `/api/v1/artist/${id}`,
      { ...base, ...artist }
    );
    return data;
  }

  /** Removes `tagIds` from every artist in `artistIds` in one bulk-editor request. */
  async removeTagsFromArtists(artistIds: number[], tagIds: number[]): Promise<void> {
    await this.removeTagsWithEditor("artist", "artistIds", artistIds, tagIds);
  }

  async deleteTrackFiles(trackFileIds: number[]): Promise<void> {
    if (trackFileIds.length === 0) return;
    await this.client.delete("/api/v1/trackfile/bulk", {
      data: { trackFileIds },
    });
  }

  async getAlbums(artistId: number): Promise<LidarrAlbum[]> {
    const { data } = await this.client.get<LidarrAlbum[]>("/api/v1/album", {
      params: { artistId },
    });
    return data;
  }

  async getTracks(artistId: number): Promise<LidarrTrack[]> {
    const { data } = await this.client.get<LidarrTrack[]>("/api/v1/track", {
      params: { artistId },
    });
    return data;
  }

  async triggerArtistSearch(artistId: number): Promise<void> {
    await this.client.post("/api/v1/command", {
      name: "ArtistSearch",
      artistId,
    });
  }
}
