import type { AxiosInstance } from "axios";
import { apiKeyHeaders, createIntegrationHttp } from "@/lib/integrations/http";
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

  constructor(baseURL: string, apiKey: string, service: ServiceType) {
    const label = service === "SONARR" ? "Sonarr" : "Radarr";
    this.client = createIntegrationHttp(label, baseURL, apiKeyHeaders(apiKey), { timeout: 20000 });
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
