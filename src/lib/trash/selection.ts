import type { ResourceType, ServiceType, TrashCatalog } from "./types";

/** The naming variants each app applies (see `applyNaming`). */
const NAMING_KEYS: Record<ServiceType, readonly string[]> = {
  RADARR: ["file", "folder"],
  SONARR: ["series", "season", "standard", "daily", "anime"],
};

const QUALITY_PROFILE_KEYS = ["scoreSet", "resetUnmatchedScores", "resetExcept"];

function namingVariants(catalog: TrashCatalog, key: string): Record<string, string> | undefined {
  const n = catalog.naming;
  if (!n) return undefined;
  switch (key) {
    case "standard":
    case "daily":
    case "anime":
      return n.episodes?.[key];
    default:
      return n[key as "file" | "folder" | "series" | "season"];
  }
}

/**
 * Why a managed resource's `selection` doesn't fit its resource type, or null
 * when it does. The request schema accepts any of the three selection shapes
 * for any row, so without this a quality profile could store naming keys, or a
 * Radarr naming row Sonarr keys — which the sync then applies as nothing at all
 * while recording the row as in sync.
 */
export function selectionError(
  resourceType: ResourceType,
  service: ServiceType,
  selection: unknown,
  catalog: TrashCatalog,
): string | null {
  if (selection == null) return null;
  if (typeof selection !== "object" || Array.isArray(selection)) return "Invalid selection.";
  const sel = selection as Record<string, unknown>;
  const keys = Object.keys(sel);

  switch (resourceType) {
    case "CUSTOM_FORMAT":
    case "QUALITY_DEFINITION":
      return keys.length ? "This resource takes no options." : null;

    case "QUALITY_PROFILE": {
      const unknown = keys.filter((k) => !QUALITY_PROFILE_KEYS.includes(k));
      if (unknown.length) return `Unknown quality-profile options: ${unknown.join(", ")}.`;
      const scoreSet = sel.scoreSet;
      if (typeof scoreSet === "string" && !catalog.customFormats.some((c) => scoreSet in (c.trash_scores ?? {}))) {
        return `Score set "${scoreSet}" is not in the guide.`;
      }
      return null;
    }

    case "NAMING": {
      const allowed = NAMING_KEYS[service];
      const unknown = keys.filter((k) => !allowed.includes(k));
      if (unknown.length) {
        return `These naming formats don't apply to ${service === "SONARR" ? "Sonarr" : "Radarr"}: ${unknown.join(", ")}.`;
      }
      for (const k of keys) {
        const variant = sel[k];
        if (typeof variant !== "string" || !namingVariants(catalog, k)?.[variant]) {
          return `Naming variant "${String(variant)}" for "${k}" is not in the guide.`;
        }
      }
      return null;
    }

    case "PROFILE_CF":
      return Array.isArray(sel.formats) && keys.length === 1
        ? null
        : "Profile custom formats need a list of formats.";

    default:
      return "Unknown resource type.";
  }
}
