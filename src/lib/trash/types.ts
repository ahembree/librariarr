/**
 * Type definitions for the TRaSH Guides sync feature.
 *
 * Two families of types live here:
 *  - `Trash*`  — the shape of the JSON published in the TRaSH Guides repo.
 *  - `Arr*`    — the shape of the Sonarr/Radarr v3 API payloads we read/write.
 *
 * Plus the derived catalog / status / plan types the API and UI consume.
 */

// ─── Service + resource discriminators ───

export const SERVICE_TYPES = ["SONARR", "RADARR"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const RESOURCE_TYPES = [
  "CUSTOM_FORMAT",
  "QUALITY_PROFILE",
  "QUALITY_DEFINITION",
  "NAMING",
  // Custom-format scores overlaid onto a specific quality profile (which may be
  // one the user created directly in the app, not a guide profile). Keyed by
  // the target profile's name; the selection carries the format→score mapping.
  "PROFILE_CF",
] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Synthetic trashId used for the singleton per-instance resources. */
export const NAMING_TRASH_ID = "naming";

// ─── TRaSH Guides JSON shapes ───

export interface TrashSpecification {
  name: string;
  implementation: string;
  negate?: boolean;
  required?: boolean;
  /** TRaSH stores fields as an object ({ value: ... }); the Arr API wants an array. */
  fields?: Record<string, unknown> | Array<{ name: string; value: unknown }>;
}

export interface TrashCustomFormat {
  trash_id: string;
  name: string;
  includeCustomFormatWhenRenaming?: boolean;
  /** Per-score-set default scores; `default` is the common one. */
  trash_scores?: Record<string, number>;
  specifications: TrashSpecification[];
}

export interface TrashQualityProfileItem {
  name: string;
  allowed: boolean;
  /** Present when this entry groups several base qualities under one name. */
  items?: string[];
}

export interface TrashQualityProfile {
  trash_id: string;
  name: string;
  trash_description?: string;
  trash_url?: string;
  /**
   * Which named score set (from each custom format's `trash_scores`) this
   * profile uses. Absent ⇒ the `default` set. Score-set-only formats have no
   * `default` key, so this must be honored or their scores come out as 0.
   */
  trash_score_set?: string;
  upgradeAllowed?: boolean;
  cutoff: string;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  minUpgradeFormatScore?: number;
  language?: string;
  items: TrashQualityProfileItem[];
  /** Map of custom-format display name → its trash_id. */
  formatItems?: Record<string, string>;
}

export interface TrashQualitySizeItem {
  quality: string;
  min: number;
  preferred?: number;
  max: number;
}

export interface TrashQualitySize {
  trash_id: string;
  type: string;
  qualities: TrashQualitySizeItem[];
}

/** Radarr naming JSON: { folder: {...}, file: {...} }. Sonarr adds season/series/episodes. */
export interface TrashNaming {
  folder?: Record<string, string>;
  file?: Record<string, string>;
  season?: Record<string, string>;
  series?: Record<string, string>;
  episodes?: {
    standard?: Record<string, string>;
    daily?: Record<string, string>;
    anime?: Record<string, string>;
  };
}

// ─── Arr v3 API shapes (subset we touch) ───

export interface ArrField {
  name: string;
  value: unknown;
}

export interface ArrCustomFormatSpec {
  name: string;
  implementation: string;
  negate: boolean;
  required: boolean;
  fields: ArrField[];
}

export interface ArrCustomFormat {
  id?: number;
  name: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications: ArrCustomFormatSpec[];
}

export interface ArrQualityRef {
  id: number;
  name: string;
  source?: string;
  resolution?: number;
  modifier?: string;
}

export interface ArrQualityDefinition {
  id: number;
  quality: ArrQualityRef;
  title: string;
  weight: number;
  minSize: number | null;
  maxSize: number | null;
  preferredSize?: number | null;
}

export interface ArrProfileItem {
  id?: number;
  name?: string;
  quality?: ArrQualityRef;
  items: ArrProfileItem[];
  allowed: boolean;
}

export interface ArrFormatItem {
  id?: number;
  format: number;
  name: string;
  score: number;
}

export interface ArrLanguage {
  id: number;
  name: string;
}

export interface ArrQualityProfile {
  id?: number;
  name: string;
  upgradeAllowed: boolean;
  cutoff: number;
  items: ArrProfileItem[];
  minFormatScore: number;
  cutoffFormatScore: number;
  minUpgradeFormatScore?: number;
  formatItems: ArrFormatItem[];
  language?: ArrLanguage;
}

/** The /qualityprofile/schema response is a profile template with all items/formatItems. */
export type ArrQualityProfileSchema = ArrQualityProfile;

/** /config/naming — union of Radarr + Sonarr fields. */
export interface ArrNamingConfig {
  id: number;
  renameMovies?: boolean;
  renameEpisodes?: boolean;
  replaceIllegalCharacters?: boolean;
  // Radarr
  standardMovieFormat?: string;
  movieFolderFormat?: string;
  // Sonarr
  standardEpisodeFormat?: string;
  dailyEpisodeFormat?: string;
  animeEpisodeFormat?: string;
  seriesFolderFormat?: string;
  seasonFolderFormat?: string;
  specialsFolderFormat?: string;
  [key: string]: unknown;
}

// ─── Catalog (parsed guide, cached) ───

export interface TrashCatalog {
  service: ServiceType;
  ref: string;
  customFormats: TrashCustomFormat[];
  qualityProfiles: TrashQualityProfile[];
  /** One quality-size definition per service (movie / series). */
  qualitySize: TrashQualitySize | null;
  naming: TrashNaming | null;
  fetchedAt: string;
}

// ─── Naming selection (stored on the managed resource) ───

export interface NamingSelection {
  // Radarr
  folder?: string;
  file?: string;
  // Sonarr
  series?: string;
  season?: string;
  standard?: string;
  daily?: string;
  anime?: string;
}

/** One custom-format score attached to a quality profile. */
export interface ProfileCfFormat {
  /** Guide custom-format trash_id. */
  trashId: string;
  /** Custom-format name (must match the Arr custom format to score it). */
  name: string;
  score: number;
}

/** Selection payload for a PROFILE_CF managed resource. */
export interface ProfileCfSelection {
  formats: ProfileCfFormat[];
}

// ─── Status (cross-reference guide ↔ instance ↔ managed) ───

export type ItemStatus =
  /** Not present in the Arr and not managed — can be added. */
  | "NEW"
  /** Present in the Arr but Librariarr does not manage it — needs explicit take-over. */
  | "UNMANAGED_CONFLICT"
  /** Managed and in sync with the guide. */
  | "MANAGED"
  /** Managed, but the guide changed upstream since the last sync. */
  | "MANAGED_OUTDATED"
  /** Managed row exists but the resource is missing from the Arr (deleted externally). */
  | "MANAGED_MISSING";

export interface TrashStatusItem {
  resourceType: ResourceType;
  trashId: string;
  name: string;
  description?: string;
  status: ItemStatus;
  /** true when the resource currently exists in the Arr (by name/identity). */
  existsInArr: boolean;
  /** true when a managed row exists for it. */
  managed: boolean;
  arrId?: number | null;
  managedResourceId?: string;
  lastSyncedAt?: string | null;
  /** Currently-managed naming variant selection (NAMING resources only). */
  selection?: NamingSelection | null;
}

export interface TrashStatus {
  serviceType: ServiceType;
  instanceId: string;
  instanceName: string;
  reachable: boolean;
  error?: string;
  items: TrashStatusItem[];
}

// ─── Sync plan / report (dry-run + apply) ───

export type PlanAction = "CREATE" | "UPDATE" | "NOOP" | "SKIP" | "ERROR";

export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed";
}

export interface PlanItem {
  resourceType: ResourceType;
  trashId: string;
  name: string;
  action: PlanAction;
  /** Human-readable diff of what would change (empty when NOOP). */
  diff: DiffEntry[];
  warnings: string[];
  error?: string;
  /** Only set on an applied (non-dry-run) sync. */
  applied?: boolean;
}

export interface SyncReport {
  serviceType: ServiceType;
  instanceId: string;
  dryRun: boolean;
  items: PlanItem[];
}
