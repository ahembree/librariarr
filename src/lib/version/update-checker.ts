import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";

const GITHUB_REPO = "ahembree/librariarr";
const CACHE_KEY = "version:latest";
const CHANGELOG_CACHE_KEY = "version:changelog";
const CACHE_TTL_MS = 3_600_000; // 1 hour
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  checkedAt: string;
}

/**
 * Compare two semver strings (major.minor.patch).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Check GitHub Releases for the latest version and compare against current.
 * Results are cached for 1 hour via appCache. Never throws.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  if (currentVersion === "unknown") {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseName: null,
      checkedAt: new Date().toISOString(),
    };
  }

  return appCache.getOrSet<UpdateCheckResult>(
    CACHE_KEY,
    async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );

        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": `Librariarr/${currentVersion}`,
            },
            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        if (!response.ok) {
          logger.debug(
            "VersionCheck",
            `GitHub API returned ${response.status}`,
          );
          return {
            currentVersion,
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: null,
            releaseName: null,
            checkedAt: new Date().toISOString(),
          };
        }

        const data = await response.json();
        const tagName: string = data.tag_name ?? "";
        const latestVersion = tagName.replace(/^v/, "");
        const releaseUrl: string | null = data.html_url ?? null;
        const releaseName: string | null = data.name ?? null;

        const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;

        return {
          currentVersion,
          latestVersion,
          updateAvailable,
          releaseUrl,
          releaseName,
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        logger.debug("VersionCheck", "Failed to check for updates", {
          error: String(error),
        });
        return {
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          releaseUrl: null,
          releaseName: null,
          checkedAt: new Date().toISOString(),
        };
      }
    },
    CACHE_TTL_MS,
  );
}

// ─── Changelog / Release Notes ───

export interface ReleaseNote {
  version: string;
  name: string | null;
  body: string;
  url: string;
  publishedAt: string;
  isCurrent: boolean;
  isLatest: boolean;
}

/**
 * Strip the commit hash suffix from a changelog line for dedup comparison.
 * Handles both formats:
 *   "fix failure bugs (12c2d85)" → "fix failure bugs"
 *   "fix failure bugs ([12c2d85](https://github.com/...))" → "fix failure bugs"
 */
function lineWithoutHash(line: string): string {
  return line
    .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\(?[^)]*\)?\)\s*$/, "")
    .trim();
}

/**
 * Remove duplicate changelog entries that differ only in commit hash.
 * Preserves the first occurrence of each unique line.
 */
export function deduplicateReleaseBody(body: string): string {
  const lines = body.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Keep non-list lines (headers, blank lines) as-is
    if (!trimmed.startsWith("* ") && !trimmed.startsWith("- ")) {
      result.push(line);
      continue;
    }
    const normalized = lineWithoutHash(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(line);
  }

  return result.join("\n");
}

/**
 * Fetch changelog/release notes from GitHub Releases.
 * Returns up to 10 release notes: any newer versions, the current version,
 * and recent prior versions. Results are cached for 1 hour.
 */
export async function fetchChangelog(): Promise<ReleaseNote[]> {
  const currentVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  if (currentVersion === "unknown") return [];

  return appCache.getOrSet<ReleaseNote[]>(
    CHANGELOG_CACHE_KEY,
    async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );

        const response = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=25`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": `Librariarr/${currentVersion}`,
            },
            signal: controller.signal,
          },
        );

        clearTimeout(timeout);

        if (!response.ok) {
          logger.debug(
            "Changelog",
            `GitHub API returned ${response.status}`,
          );
          return [];
        }

        const releases = await response.json();
        if (!Array.isArray(releases)) return [];

        const notes: ReleaseNote[] = [];

        for (const release of releases) {
          if (release.draft) continue;

          const tag: string = release.tag_name ?? "";
          const version = tag.replace(/^v/, "");
          if (!version) continue;

          const cmp = compareSemver(version, currentVersion);

          notes.push({
            version,
            name: release.name ?? null,
            body: deduplicateReleaseBody(release.body ?? ""),
            url: release.html_url ?? "",
            publishedAt: release.published_at ?? release.created_at ?? "",
            isCurrent: cmp === 0,
            isLatest: false,
          });
        }

        // Sort newest first
        notes.sort((a, b) => compareSemver(b.version, a.version));

        // Mark the latest (first after sorting)
        if (notes.length > 0) {
          notes[0].isLatest = true;
        }

        // Keep all newer versions + enough older ones to total 10
        return notes.slice(0, 10);
      } catch (error) {
        logger.debug("Changelog", "Failed to fetch changelog", {
          error: String(error),
        });
        return [];
      }
    },
    CACHE_TTL_MS,
  );
}

/**
 * Pre-warm the version check cache. Called by the background scheduler.
 */
export async function warmVersionCache(): Promise<void> {
  await checkForUpdate();
}
