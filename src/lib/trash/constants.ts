import type { ServiceType } from "./types";

/**
 * Source repository for the guide JSON. Overridable via env so an operator can
 * point at a fork or an internal mirror. Defaults to the upstream guides repo.
 */
const TRASH_REPO = process.env.TRASH_GUIDES_REPO || "TRaSH-Guides/Guides";
export const TRASH_REF = process.env.TRASH_GUIDES_REF || "master";

/** A full commit id: what a catalog build pins every request to. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** GitHub commits API — resolves `TRASH_REF` (a branch, by default) to the commit it names now. */
export function commitUrl(): string {
  return `https://api.github.com/repos/${TRASH_REPO}/commits/${encodeURIComponent(TRASH_REF)}`;
}

/** GitHub tree API — one request lists every file in the repo at `ref`. */
export function treeUrl(ref: string = TRASH_REF): string {
  return `https://api.github.com/repos/${TRASH_REPO}/git/trees/${ref}?recursive=1`;
}

/** raw.githubusercontent CDN — used for individual file contents at `ref`. */
export function rawUrl(path: string, ref: string = TRASH_REF): string {
  return `https://raw.githubusercontent.com/${TRASH_REPO}/${ref}/${path}`;
}

/** Directory prefixes under docs/json/<service> for each resource kind. */
export function servicePaths(service: ServiceType) {
  const svc = service === "SONARR" ? "sonarr" : "radarr";
  return {
    customFormats: `docs/json/${svc}/cf/`,
    cfGroups: `docs/json/${svc}/cf-groups/`,
    qualityProfiles: `docs/json/${svc}/quality-profiles/`,
    qualitySize: `docs/json/${svc}/quality-size/`,
    naming: `docs/json/${svc}/naming/`,
  };
}

/** Catalog cache: guide content changes rarely, so cache for hours. */
const CATALOG_CACHE_PREFIX = "trash-catalog:";
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Bump when the parsed catalog shape changes so a running process doesn't serve
// a stale cached catalog missing new fields (e.g. cfGroups / categories).
const CATALOG_SCHEMA_VERSION = 2;

export function catalogCacheKey(service: ServiceType): string {
  return `${CATALOG_CACHE_PREFIX}v${CATALOG_SCHEMA_VERSION}:${TRASH_REPO}@${TRASH_REF}:${service}`;
}

/** Bounded concurrency when fetching many small raw files. */
export const FETCH_CONCURRENCY = 12;
