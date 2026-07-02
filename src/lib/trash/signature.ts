import { hashDefinition } from "./hash";
import type {
  ServiceType,
  TrashCustomFormat,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
  NamingSelection,
  QualityProfileSelection,
} from "./types";

/**
 * Stable content hashes of the *guide* definition for each resource kind. Stored
 * as `lastSyncHash` at sync time; a mismatch on a later status check means the
 * guide changed upstream (the "update available" flag).
 */

export function trashCfHash(cf: TrashCustomFormat): string {
  return hashDefinition({
    name: cf.name,
    include: cf.includeCustomFormatWhenRenaming ?? false,
    specifications: cf.specifications,
  });
}

/**
 * Content hash of a managed quality profile. Beyond the guide profile's own
 * fields it folds in (a) the *resolved scores* of every custom format the profile
 * references — these live in the separate CF catalog, so a guide score re-tune
 * (the most common upstream change) would otherwise be invisible — and (b) the
 * per-profile `selection` (score-set override / reset-unmatched options), so a
 * local option change flips the profile to "update available" too. Both call
 * sites (status check and sync write) pass the same catalog + selection, so the
 * stored and recomputed hashes stay consistent.
 */
export function trashProfileHash(
  p: TrashQualityProfile,
  cfMapByTrashId?: Map<string, TrashCustomFormat>,
  selection?: QualityProfileSelection | null,
): string {
  const referencedScores: Record<string, Record<string, number>> = {};
  if (cfMapByTrashId) {
    for (const trashId of Object.values(p.formatItems ?? {})) {
      const cf = cfMapByTrashId.get(trashId);
      if (cf?.trash_scores) referencedScores[trashId] = cf.trash_scores;
    }
  }
  return hashDefinition({
    name: p.name,
    cutoff: p.cutoff,
    upgradeAllowed: p.upgradeAllowed ?? true,
    minFormatScore: p.minFormatScore ?? 0,
    cutoffFormatScore: p.cutoffFormatScore ?? 0,
    minUpgradeFormatScore: p.minUpgradeFormatScore ?? 1,
    scoreSet: p.trash_score_set ?? "default",
    language: p.language ?? null,
    items: p.items,
    formatItems: p.formatItems ?? {},
    referencedScores,
    selection: selection ?? null,
  });
}

export function trashQualitySizeHash(qs: TrashQualitySize): string {
  return hashDefinition(qs.qualities);
}

/** Naming depends on the user's chosen variants, so the hash folds in the selection. */
export function namingSelectionHash(
  trash: TrashNaming,
  selection: NamingSelection,
  service: ServiceType,
): string {
  const strings: Record<string, string | undefined> =
    service === "RADARR"
      ? {
          file: selection.file ? trash.file?.[selection.file] : undefined,
          folder: selection.folder ? trash.folder?.[selection.folder] : undefined,
        }
      : {
          series: selection.series ? trash.series?.[selection.series] : undefined,
          season: selection.season ? trash.season?.[selection.season] : undefined,
          standard: selection.standard ? trash.episodes?.standard?.[selection.standard] : undefined,
          daily: selection.daily ? trash.episodes?.daily?.[selection.daily] : undefined,
          anime: selection.anime ? trash.episodes?.anime?.[selection.anime] : undefined,
        };
  return hashDefinition(strings);
}
