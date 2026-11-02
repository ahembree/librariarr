import { compareSemver } from "@/lib/version/semver";

/** The running version, or null in a build that carries none (development). */
export function installedVersion(): string | null {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  return version && version !== "unknown" ? version.replace(/^v/, "") : null;
}

/**
 * Whether the "What's new" dialog is owed: the running version is newer than
 * the one whose dialog was last closed. A fresh install stores its own version
 * at setup, so it never sees one; an install upgraded from before the dialog
 * existed (`lastSeenVersion` null) sees the running version's notes once.
 */
export function whatsNewDue(lastSeenVersion: string | null, currentVersion: string | null): boolean {
  if (!currentVersion) return false;
  if (lastSeenVersion === null) return true;
  return compareSemver(currentVersion, lastSeenVersion) > 0;
}
