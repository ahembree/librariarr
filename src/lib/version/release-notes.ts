/**
 * Client-safe helpers for GitHub release notes (release-please bodies):
 * shared by the Settings → System changelog and the "What's new" dialog.
 */

import { compareSemver } from "./semver";

/**
 * Clean a markdown list item for display:
 * - Strip commit hash links: "([abc1234](url))" or "(abc1234)"
 * - Convert bold scopes: "**lifecycle:** msg" → "lifecycle: msg"
 * - Decode HTML entities: "&gt;" → ">"
 */
export function cleanReleaseItem(raw: string): string {
  return (
    raw
      // Remove markdown commit links: ([hash](url))
      .replace(/\s*\(\[?[a-f0-9]{7,40}\]?\([^)]*\)\)/g, "")
      // Remove bare hash refs: (hash)
      .replace(/\s*\([a-f0-9]{7,40}\)/g, "")
      // Convert **scope:** to scope:
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      // Decode common HTML entities from GitHub
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Parse a release-please body into grouped sections.
 * Handles the format: ## [version](url) (date) then ### Section headings with * items.
 */
export function parseReleaseBody(body: string): { heading: string; items: string[] }[] {
  const lines = body.split("\n");
  const sections: { heading: string; items: string[] }[] = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the version header line: ## [0.11.3](url) (date)
    if (/^##\s+\[?\d+\.\d+/.test(trimmed)) continue;

    // Section heading (### Bug Fixes, ### Features, etc.)
    const headingMatch = trimmed.match(/^#{2,3}\s+(.+)/);
    if (headingMatch) {
      current = { heading: headingMatch[1], items: [] };
      sections.push(current);
      continue;
    }

    // List item
    if ((trimmed.startsWith("* ") || trimmed.startsWith("- ")) && current) {
      current.items.push(cleanReleaseItem(trimmed.slice(2)));
    }
  }

  return sections.filter((s) => s.items.length > 0);
}


/**
 * The releases a "What's new" dialog shows after an upgrade: every note newer
 * than `lastSeenVersion` and no newer than `currentVersion`, newest first.
 * With no `lastSeenVersion` (an install upgraded from before the dialog
 * existed, so where it came from is unknown) only the current version's note.
 */
export function notesSinceVersion<T extends { version: string }>(
  notes: T[],
  lastSeenVersion: string | null,
  currentVersion: string,
): T[] {
  return notes
    .filter((note) => {
      if (compareSemver(note.version, currentVersion) > 0) return false;
      if (lastSeenVersion === null) return compareSemver(note.version, currentVersion) === 0;
      return compareSemver(note.version, lastSeenVersion) > 0;
    })
    .sort((a, b) => compareSemver(b.version, a.version));
}

/** A release-please item's conventional-commit scope ("sync: keep counts" → "sync"), if it has one. */
export function splitReleaseItemScope(item: string): { scope: string | null; text: string } {
  const match = item.match(/^([\w./-]{1,40}):\s+(.+)$/);
  return match ? { scope: match[1], text: match[2] } : { scope: null, text: item };
}

export type ReleaseSectionKind = "features" | "fixes" | "performance" | "other";

/** Which kind of change a release-please section heading lists. */
export function releaseSectionKind(heading: string): ReleaseSectionKind {
  const h = heading.toLowerCase();
  if (h.includes("feature")) return "features";
  if (h.includes("fix")) return "fixes";
  if (h.includes("perf")) return "performance";
  return "other";
}
