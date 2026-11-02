import {
  hasArrRules,
  hasCustomFormatScoreRules,
  hasSeerrRules,
  type ArrDataMap,
  type SeerrDataMap,
} from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { fetchArrMetadataForPreview } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadataForPreview } from "@/lib/lifecycle/fetch-seerr-metadata";
import { splitProgress, type FractionReporter } from "@/lib/progress/fraction";
import type { ProgressPhase } from "@/lib/progress/types";

type LibraryType = "MOVIE" | "SERIES" | "MUSIC";

/** Which external reads a rule set needs (Seerr is never read for music). */
function needs(rules: LifecycleRule[] | LifecycleRuleGroup[], type: LibraryType) {
  return { arr: hasArrRules(rules), seerr: hasSeerrRules(rules) && type !== "MUSIC" };
}

/**
 * The one progress phase the metadata reads report through, or null when the
 * rules need neither. Both reads run at once, so they share one phase rather
 * than two the bar would flip between.
 */
export function previewMetadataPhase(
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  type: LibraryType,
): ProgressPhase | null {
  const { arr, seerr } = needs(rules, type);
  if (arr && seerr) return { key: "metadata", label: "Fetching Arr and Seerr metadata" };
  if (arr) return { key: "arr", label: "Fetching Arr metadata" };
  if (seerr) return { key: "seerr", label: "Fetching Seerr metadata" };
  return null;
}

/**
 * The Arr and Seerr data the rule editor's preview, diff and Test Media
 * evaluate against: read in parallel, through the short-lived preview caches
 * (`fetchArrMetadataForPreview`, `fetchSeerrMetadataForPreview`) — so pressing
 * Preview, then Test Media, reads each library once — and with Radarr's
 * custom-format scores only when a rule reads them. Detection and execution
 * never come through here; they always read fresh.
 */
export async function loadPreviewMetadata(
  userId: string,
  type: LibraryType,
  rules: LifecycleRule[] | LifecycleRuleGroup[],
  arrInstanceId: string | null | undefined,
  onProgress?: FractionReporter,
): Promise<{ arrData?: ArrDataMap; seerrData?: SeerrDataMap }> {
  const need = needs(rules, type);
  const reporters = onProgress ? splitProgress(onProgress, Number(need.arr) + Number(need.seerr)) : [];
  const arrReport = reporters[0];
  const seerrReport = reporters[need.arr ? 1 : 0];
  const [arrData, seerrData] = await Promise.all([
    need.arr
      ? fetchArrMetadataForPreview(userId, type, arrReport, arrInstanceId, {
          customFormatScores: hasCustomFormatScoreRules(rules),
        })
      : undefined,
    need.seerr
      ? seerrReport
        ? fetchSeerrMetadataForPreview(userId, type as "MOVIE" | "SERIES", seerrReport)
        : fetchSeerrMetadataForPreview(userId, type as "MOVIE" | "SERIES")
      : undefined,
  ]);
  return { arrData, seerrData };
}
