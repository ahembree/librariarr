/**
 * Action-configuration validation shared by the rule-set create and update
 * routes. The UI constrains these combinations, but the API must too — a
 * mis-paired action configuration is a "wrong system" hazard for the
 * deletion pipeline (e.g. a MOVIE rule set carrying DELETE_SONARR, or an
 * arrInstanceId pointing at an instance of the wrong family / another
 * record that doesn't exist).
 */
import { prisma } from "@/lib/db";

export type ArrFamily = "RADARR" | "SONARR" | "LIDARR";

/** The only Arr family whose records correspond to each library type. */
export const FAMILY_FOR_LIBRARY: Record<"MOVIE" | "SERIES" | "MUSIC", ArrFamily> = {
  MOVIE: "RADARR",
  SERIES: "SONARR",
  MUSIC: "LIDARR",
};

/** Family encoded in an actionType suffix, or null for DO_NOTHING/null. */
export function actionFamilyForType(actionType: string | null | undefined): ArrFamily | null {
  if (!actionType || actionType === "DO_NOTHING") return null;
  if (actionType.endsWith("_RADARR")) return "RADARR";
  if (actionType.endsWith("_SONARR")) return "SONARR";
  if (actionType.endsWith("_LIDARR")) return "LIDARR";
  return null;
}

/**
 * Validate the (merged) action configuration for a rule set. Returns a
 * human-readable error string, or null when the configuration is sound.
 *
 * - `actionType`'s family must match the library type's family.
 * - `arrInstanceId`, when set, must reference an existing instance of that
 *   family owned by the user (tags-only configurations use the library
 *   type's family).
 */
export async function validateActionConfig(opts: {
  userId: string;
  libraryType: "MOVIE" | "SERIES" | "MUSIC";
  actionType: string | null | undefined;
  arrInstanceId: string | null | undefined;
}): Promise<string | null> {
  const { userId, libraryType, actionType, arrInstanceId } = opts;
  const libraryFamily = FAMILY_FOR_LIBRARY[libraryType];

  const actionFamily = actionFamilyForType(actionType);
  if (actionFamily && actionFamily !== libraryFamily) {
    return `Action "${actionType}" targets ${actionFamily.toLowerCase()} and is not valid for ${libraryType.toLowerCase()} rule sets`;
  }

  if (arrInstanceId) {
    const where = { id: arrInstanceId, userId };
    const instance =
      libraryFamily === "RADARR"
        ? await prisma.radarrInstance.findFirst({ where, select: { id: true } })
        : libraryFamily === "SONARR"
          ? await prisma.sonarrInstance.findFirst({ where, select: { id: true } })
          : await prisma.lidarrInstance.findFirst({ where, select: { id: true } });
    if (!instance) {
      return `Arr instance not found — ${libraryType.toLowerCase()} rule sets require a ${libraryFamily.toLowerCase()} instance`;
    }
  }

  return null;
}
