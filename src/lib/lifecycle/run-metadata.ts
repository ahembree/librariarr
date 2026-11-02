import {
  hasAnyActiveRules,
  hasArrRules,
  hasCustomFormatScoreRules,
  hasSeerrRules,
  type ArrDataMap,
  type SeerrDataMap,
} from "@/lib/rules/lifecycle-engine";
import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { fetchArrMetadata } from "@/lib/lifecycle/fetch-arr-metadata";
import { fetchSeerrMetadataByType } from "@/lib/lifecycle/fetch-seerr-metadata";

type ArrType = "MOVIE" | "SERIES" | "MUSIC";
type SeerrType = "MOVIE" | "SERIES";

interface RunRuleSet {
  userId: string;
  type: string;
  rules: unknown;
  arrInstanceId: string | null;
}

const arrTypeOf = (type: string): ArrType => (type === "MOVIE" ? "MOVIE" : type === "MUSIC" ? "MUSIC" : "SERIES");

/**
 * The Arr and Seerr reads one detection run shares across its rule sets
 * (`processLifecycleRules`, `runDetection`), decided from every rule set of the
 * run up front:
 *
 * - Arr data is read once per owner, library type and rule-set instance (a
 *   rule set's Arr criteria are read from its own instance — see
 *   `resolveArrInstanceScope`), with Radarr's custom-format scores only when a
 *   rule set sharing that read uses Custom Format Score.
 * - Seerr is walked once per owner for every type the run needs: a MOVIE and a
 *   SERIES rule set used to cost two walks, each of which made Seerr ask every
 *   Arr app about every page, and on a server ignoring the `mediaType` filter
 *   read the whole request list twice.
 *
 * A failed read is remembered too, so the remaining rule sets needing it skip
 * at once (each through its own catch) instead of re-reading an instance that
 * just failed. Every read is fresh — this never touches the previews' cache.
 */
export function createRunMetadata(ruleSets: RunRuleSet[]) {
  const withScores = new Set<string>();
  const seerrTypes = new Map<string, Set<SeerrType>>();
  const arrKey = (userId: string, type: ArrType, arrInstanceId: string | null) =>
    `${userId}:${type}:${arrInstanceId ?? "*"}`;

  for (const rs of ruleSets) {
    const rules = rs.rules as LifecycleRule[] | LifecycleRuleGroup[];
    if (!Array.isArray(rules) || !hasAnyActiveRules(rules)) continue;
    if (hasArrRules(rules) && hasCustomFormatScoreRules(rules)) {
      withScores.add(arrKey(rs.userId, arrTypeOf(rs.type), rs.arrInstanceId));
    }
    if (hasSeerrRules(rules) && rs.type !== "MUSIC") {
      const types = seerrTypes.get(rs.userId) ?? new Set<SeerrType>();
      types.add(rs.type === "MOVIE" ? "MOVIE" : "SERIES");
      seerrTypes.set(rs.userId, types);
    }
  }

  const reads = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let pending = reads.get(key);
    if (!pending) {
      pending = load();
      // Observed here so a failure nobody awaits yet is not an unhandled rejection.
      pending.catch(() => {});
      reads.set(key, pending);
    }
    return pending as Promise<T>;
  };

  return {
    arr(userId: string, type: string, arrInstanceId: string | null): Promise<ArrDataMap> {
      const t = arrTypeOf(type);
      const key = arrKey(userId, t, arrInstanceId);
      return once(`arr:${key}`, () =>
        fetchArrMetadata(userId, t, undefined, arrInstanceId, { customFormatScores: withScores.has(key) }),
      );
    },

    async seerr(userId: string, type: SeerrType): Promise<SeerrDataMap> {
      const planned = seerrTypes.get(userId);
      if (!planned?.has(type)) {
        // Not foreseen (a caller asking for a type no rule set of the run
        // reads): its own walk, never a missing map read as "nothing requested".
        return once(`seerr:${userId}:${type}`, async () => (await fetchSeerrMetadataByType(userId, [type]))[type]!);
      }
      const all = await once(`seerr:${userId}`, () => fetchSeerrMetadataByType(userId, [...planned]));
      return all[type]!;
    },
  };
}
