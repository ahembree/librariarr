import type { LifecycleRule, LifecycleRuleGroup } from "@/lib/rules/types";
import { hasArrRules, hasSeerrRules } from "@/lib/rules/lifecycle-engine";
import { hasEnabledArrInstances, arrFamilyLabel } from "@/lib/lifecycle/fetch-arr-metadata";
import { hasEnabledSeerrInstances } from "@/lib/lifecycle/fetch-seerr-metadata";

/**
 * Whether a rule set's external dependencies (Arr/Seerr instances) are
 * available, so its rules can be evaluated faithfully.
 *
 * `evaluable: false` means evaluation would run against an EMPTY external
 * metadata map, which makes negative rules like `foundInArr = false` /
 * `seerrRequested = false` vacuously true for the ENTIRE library — the
 * match-all hazard every caller of this helper exists to refuse.
 *
 * `permanent` distinguishes the two failure classes:
 *  - false (transient): no enabled instance right now — the rule set resumes
 *    as soon as an instance is re-enabled, so callers skip it and leave its
 *    matches/actions untouched (same as a metadata fetch failure).
 *  - true (permanent): the configuration can NEVER evaluate (Seerr criteria
 *    on a MUSIC rule set — Seerr has no music requests). Detection callers
 *    must also DISARM the rule set (clear matches, cancel pending actions):
 *    a vacuous whole-library flood armed before this guard existed would
 *    otherwise stay frozen forever and still execute.
 *
 * This is the single policy point for the guard — the detection paths log
 * the reason and skip, the preview/test/diff routes return it as a 400.
 */
export type RuleEvaluability =
  | { evaluable: true }
  | { evaluable: false; reason: string; permanent: boolean };

export async function checkLifecycleRuleEvaluability(
  userId: string,
  type: "MOVIE" | "SERIES" | "MUSIC",
  rules: LifecycleRule[] | LifecycleRuleGroup[],
): Promise<RuleEvaluability> {
  if (hasArrRules(rules) && !(await hasEnabledArrInstances(userId, type))) {
    return {
      evaluable: false,
      permanent: false,
      reason: `Rules use Arr criteria but no enabled ${arrFamilyLabel(type)} instance exists — evaluating them without one would match the entire library`,
    };
  }
  if (hasSeerrRules(rules)) {
    if (type === "MUSIC") {
      return {
        evaluable: false,
        permanent: true,
        reason: "Seerr criteria are not supported for music rules",
      };
    }
    if (!(await hasEnabledSeerrInstances(userId))) {
      return {
        evaluable: false,
        permanent: false,
        reason: "Rules use Seerr criteria but no enabled Seerr instance exists — evaluating them without one would match the entire library",
      };
    }
  }
  return { evaluable: true };
}
