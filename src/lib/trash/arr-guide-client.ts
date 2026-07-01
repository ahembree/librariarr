import axios, { AxiosInstance } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry } from "@/lib/http-retry";
import type {
  ServiceType,
  ArrCustomFormat,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  ArrQualityDefinition,
  ArrNamingConfig,
  ArrLanguage,
} from "./types";

/**
 * Focused Sonarr/Radarr v3 client for the TRaSH sync feature. Kept separate
 * from the core SonarrClient/RadarrClient (which handle series/movies/tags) so
 * the guide-sync endpoints (custom formats, quality profiles, quality
 * definitions, naming config) live in one place. These endpoints are identical
 * between Sonarr and Radarr, so a single client serves both.
 */
export class GuideArrClient {
  private client: AxiosInstance;
  readonly service: ServiceType;

  constructor(baseURL: string, apiKey: string, service: ServiceType) {
    this.service = service;
    const label = service === "SONARR" ? "Sonarr" : "Radarr";
    this.client = axios.create({
      baseURL: baseURL.replace(/\/+$/, ""),
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    this.client.interceptors.request.use((config) => {
      (config as unknown as Record<string, unknown>).__startTime = Date.now();
      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error)) {
          const start = (error.config as unknown as Record<string, unknown>)?.__startTime as
            | number
            | undefined;
          const duration = start ? ` (${Date.now() - start}ms)` : "";
          logger.debug(
            label,
            `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`,
            { message: error.message },
          );
          return Promise.reject(new IntegrationError(label, error));
        }
        return Promise.reject(error);
      },
    );

    configureRetry(this.client, label, logger);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string; version?: string }> {
    try {
      const { data } = await this.client.get("/api/v3/system/status");
      const expected = this.service === "SONARR" ? "Sonarr" : "Radarr";
      if (data.appName && data.appName !== expected) {
        return { ok: false, error: `Expected ${expected} but connected to ${data.appName}` };
      }
      return { ok: true, version: data.version };
    } catch (error: unknown) {
      return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
    }
  }

  // ─── Custom formats ───

  async getCustomFormats(): Promise<ArrCustomFormat[]> {
    const { data } = await this.client.get<ArrCustomFormat[]>("/api/v3/customformat");
    return data;
  }

  async createCustomFormat(cf: ArrCustomFormat): Promise<ArrCustomFormat> {
    const { data } = await this.client.post<ArrCustomFormat>("/api/v3/customformat", cf);
    return data;
  }

  async updateCustomFormat(id: number, cf: ArrCustomFormat): Promise<ArrCustomFormat> {
    const { data } = await this.client.put<ArrCustomFormat>(
      `/api/v3/customformat/${id}`,
      { ...cf, id },
    );
    return data;
  }

  // ─── Languages (Radarr profile language resolution) ───

  async getLanguages(): Promise<ArrLanguage[]> {
    const { data } = await this.client.get<ArrLanguage[]>("/api/v3/language");
    return data;
  }

  // ─── Quality profiles ───

  async getQualityProfiles(): Promise<ArrQualityProfile[]> {
    const { data } = await this.client.get<ArrQualityProfile[]>("/api/v3/qualityprofile");
    return data;
  }

  async getQualityProfileSchema(): Promise<ArrQualityProfileSchema> {
    const { data } = await this.client.get<ArrQualityProfileSchema>(
      "/api/v3/qualityprofile/schema",
    );
    return data;
  }

  async createQualityProfile(profile: ArrQualityProfile): Promise<ArrQualityProfile> {
    const { data } = await this.client.post<ArrQualityProfile>(
      "/api/v3/qualityprofile",
      profile,
    );
    return data;
  }

  async updateQualityProfile(id: number, profile: ArrQualityProfile): Promise<ArrQualityProfile> {
    const { data } = await this.client.put<ArrQualityProfile>(
      `/api/v3/qualityprofile/${id}`,
      { ...profile, id },
    );
    return data;
  }

  // ─── Quality definitions ───

  async getQualityDefinitions(): Promise<ArrQualityDefinition[]> {
    const { data } = await this.client.get<ArrQualityDefinition[]>("/api/v3/qualitydefinition");
    return data;
  }

  async updateQualityDefinitions(defs: ArrQualityDefinition[]): Promise<ArrQualityDefinition[]> {
    const { data } = await this.client.put<ArrQualityDefinition[]>(
      "/api/v3/qualitydefinition/update",
      defs,
    );
    return data;
  }

  // ─── Naming config ───

  async getNamingConfig(): Promise<ArrNamingConfig> {
    const { data } = await this.client.get<ArrNamingConfig>("/api/v3/config/naming");
    return data;
  }

  async updateNamingConfig(config: ArrNamingConfig): Promise<ArrNamingConfig> {
    const { data } = await this.client.put<ArrNamingConfig>(
      `/api/v3/config/naming/${config.id}`,
      config,
    );
    return data;
  }
}
