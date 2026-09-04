import { prisma } from "@/lib/db";
import { isDestructiveActionType } from "@/lib/lifecycle/action-types";

/**
 * The optional ceiling on how many items ONE destructive run may act on.
 *
 * Deliberately opt-in and unlimited by default. Librariarr exists to delete
 * media without supervision, and a user whose rules legitimately select
 * thousands of items should not be second-guessed for it — a hard cap shipped
 * on by default would be the wrong trade for this application.
 *
 * What it defends against is not a rule being wrong. Every vacuous-match guard
 * in the codebase refuses a KNOWN failure — Arr metadata that could not be
 * fetched, Seerr criteria on music, play history that was never established —
 * and each was written after finding a specific way the engine could match an
 * entire library on absent evidence. A ceiling is the only defence that does
 * not depend on having enumerated the hazards first: it bounds the blast radius
 * of the ones nobody has found yet.
 *
 * Counted per RUN across every rule set, over destructive actions only.
 * Exceeding it holds the WHOLE batch rather than trimming it to the limit —
 * acting on an arbitrary subset of a match set you already distrust is not
 * safer, just quieter about it.
 */
export interface DeleteCeilingVerdict {
  /** `true` when the run may proceed (under the ceiling, or none configured). */
  allowed: boolean;
  /** Destructive items this run would act on. */
  count: number;
  /** The configured ceiling, or `null` when unlimited. */
  limit: number | null;
  /** Operator-facing explanation, present only when blocked. */
  reason?: string;
}

/** Read the user's configured ceiling. `null` means unlimited. */
export async function getDeleteCeiling(userId: string): Promise<number | null> {
  const settings = await prisma.appSettings.findFirst({
    where: { userId },
    select: { maxAutoDeleteItems: true },
  });
  const limit = settings?.maxAutoDeleteItems ?? null;
  // A non-positive value is meaningless as a ceiling and almost certainly means
  // "off" rather than "refuse everything", which would silently disable
  // lifecycle deletion entirely.
  return limit != null && limit > 0 ? limit : null;
}

/**
 * Decide whether a run of `actionTypes` may proceed.
 *
 * Takes the action types rather than a count so the destructive filter lives in
 * one place: a caller that counted its own items would have to re-derive which
 * of them destroy anything, and would drift from `isDestructiveActionType`.
 */
export async function checkDeleteCeiling(
  userId: string,
  actionTypes: string[],
): Promise<DeleteCeilingVerdict> {
  const count = actionTypes.filter(isDestructiveActionType).length;
  const limit = await getDeleteCeiling(userId);

  if (limit == null || count <= limit) return { allowed: true, count, limit };

  return {
    allowed: false,
    count,
    limit,
    reason:
      `This run would delete ${count} item(s), above the configured limit of ${limit}. ` +
      `Nothing was deleted. Review the items and run it manually if they are correct, ` +
      `or raise the limit in Settings.`,
  };
}
