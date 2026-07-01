import type { ServiceType, ResourceType } from "./types";

/**
 * Source repository for the guide JSON. Overridable via env so an operator can
 * point at a fork or an internal mirror. Defaults to the upstream guides repo.
 */
export const TRASH_REPO = process.env.TRASH_GUIDES_REPO || "TRaSH-Guides/Guides";
export const TRASH_REF = process.env.TRASH_GUIDES_REF || "master";

/** GitHub tree API — one request lists every file in the repo. */
export function treeUrl(): string {
  return `https://api.github.com/repos/${TRASH_REPO}/git/trees/${TRASH_REF}?recursive=1`;
}

/** raw.githubusercontent CDN — used for individual file contents. */
export function rawUrl(path: string): string {
  return `https://raw.githubusercontent.com/${TRASH_REPO}/${TRASH_REF}/${path}`;
}

/** Directory prefixes under docs/json/<service> for each resource kind. */
export function servicePaths(service: ServiceType) {
  const svc = service === "SONARR" ? "sonarr" : "radarr";
  return {
    customFormats: `docs/json/${svc}/cf/`,
    qualityProfiles: `docs/json/${svc}/quality-profiles/`,
    qualitySize: `docs/json/${svc}/quality-size/`,
    naming: `docs/json/${svc}/naming/`,
  };
}

/** Catalog cache: guide content changes rarely, so cache for hours. */
export const CATALOG_CACHE_PREFIX = "trash-catalog:";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function catalogCacheKey(service: ServiceType): string {
  return `${CATALOG_CACHE_PREFIX}${TRASH_REPO}@${TRASH_REF}:${service}`;
}

/** Bounded concurrency when fetching many small raw files. */
export const FETCH_CONCURRENCY = 12;

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  CUSTOM_FORMAT: "Custom Format",
  QUALITY_PROFILE: "Quality Profile",
  QUALITY_DEFINITION: "Quality Definition",
  NAMING: "Naming Scheme",
};
