import { appCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/logger";

const GITHUB_REPO = "ahembree/librariarr";
const CACHE_KEY = "version:latest";
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

/**
 * Pre-warm the version check cache. Called by the background scheduler.
 */
export async function warmVersionCache(): Promise<void> {
  await checkForUpdate();
}
