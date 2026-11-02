import type { AxiosInstance } from "axios";
import { NO_RETRY } from "@/lib/http-retry";
import { apiKeyHeaders, createIntegrationHttp } from "@/lib/integrations/http";

export interface ArrTag {
  id: number;
  label: string;
}

export interface ArrQualityProfileRef {
  id: number;
  name: string;
}

export interface ArrMediaManagementConfig {
  recycleBin: string | null;
  recycleBinCleanupDays: number;
}

type ArrAppName = "Radarr" | "Sonarr" | "Lidarr";

/**
 * The requests Radarr, Sonarr and Lidarr answer identically — Radarr and
 * Sonarr under `/api/v3`, Lidarr under `/api/v1`. Each client adds its own
 * media endpoints on top.
 */
export abstract class ArrClientBase {
  protected readonly client: AxiosInstance;

  protected constructor(
    private readonly appName: ArrAppName,
    private readonly apiVersion: "v3" | "v1",
    baseURL: string,
    apiKey: string,
  ) {
    this.client = createIntegrationHttp(appName, baseURL, apiKeyHeaders(apiKey), { timeout: 15000 });
  }

  /** `/api/<version><path>` for this app. */
  protected api(path: string): string {
    return `/api/${this.apiVersion}${path}`;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; appName?: string; version?: string }> {
    try {
      const response = await this.client.get(this.api("/system/status"), { ...NO_RETRY });
      const { appName, version } = response.data;
      if (appName && appName !== this.appName) {
        return { ok: false, error: `Expected ${this.appName} but connected to ${appName}`, appName, version };
      }
      return { ok: true, appName, version };
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Connection failed";
      return { ok: false, error: msg };
    }
  }

  async getTags(): Promise<ArrTag[]> {
    const { data } = await this.client.get<ArrTag[]>(this.api("/tag"));
    return data;
  }

  async createTag(label: string): Promise<ArrTag> {
    const { data } = await this.client.post<ArrTag>(this.api("/tag"), { label });
    return data;
  }

  async deleteTag(id: number): Promise<void> {
    await this.client.delete(this.api(`/tag/${id}`));
  }

  async getQualityProfiles(): Promise<ArrQualityProfileRef[]> {
    const { data } = await this.client.get<ArrQualityProfileRef[]>(this.api("/qualityprofile"));
    return data;
  }

  async getLanguages(): Promise<{ id: number; name: string }[]> {
    const { data } = await this.client.get<{ id: number; name: string }[]>(this.api("/language"));
    return data;
  }

  /**
   * Only caller is the rule editor's recycle-bin check, which the Save button
   * waits on — a probe, so it reports the first failure (NO_RETRY) instead of
   * holding Save through four timeouts.
   */
  async getMediaManagementConfig(): Promise<ArrMediaManagementConfig> {
    const { data } = await this.client.get<ArrMediaManagementConfig>(
      this.api("/config/mediamanagement"),
      { ...NO_RETRY },
    );
    return data;
  }

  /**
   * Removes tags from many records in one request through the app's bulk
   * editor (`PUT /api/<v>/<resource>/editor` with `applyTags: "remove"`),
   * rather than a GET and a PUT per record. Sent in slices so one write never
   * carries a whole library: a write is not retried (see `configureRetry`),
   * and a smaller one is less likely to outlive the timeout.
   */
  protected async removeTagsWithEditor(
    resource: "movie" | "series" | "artist",
    idsKey: "movieIds" | "seriesIds" | "artistIds",
    ids: number[],
    tagIds: number[],
  ): Promise<void> {
    if (ids.length === 0 || tagIds.length === 0) return;
    for (let i = 0; i < ids.length; i += EDITOR_BATCH_SIZE) {
      await this.client.put(this.api(`/${resource}/editor`), {
        [idsKey]: ids.slice(i, i + EDITOR_BATCH_SIZE),
        tags: tagIds,
        applyTags: "remove",
      });
    }
  }
}

/** Records per bulk-editor request (see `removeTagsWithEditor`). */
const EDITOR_BATCH_SIZE = 500;
