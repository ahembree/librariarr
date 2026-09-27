import { prisma } from "@/lib/db";

/**
 * The one-time hold on grouped actions after the upgrade that made them run.
 *
 * Before migration `0024`, the scheduled executor cancelled every series action
 * (either scope) and every artist-scope music action as an identity change, so
 * none of them had ever run. The migration moved the ones pending at the time
 * to a week out and recorded that date in `AppSettings.groupedActionsHeldUntil`;
 * everything that schedules a grouped action applies it too, because the ones
 * pending at the upgrade were not all of them — a rule set with no delay has
 * nothing pending between runs, and a cancelled action was only scheduled
 * again at the next detection. The Pending page then shows the real date.
 */

/** The hold still in force for this user's grouped actions, or `null`. */
export async function loadGroupedActionHold(userId: string, now = new Date()): Promise<Date | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { groupedActionsHeldUntil: true },
  });
  const hold = settings?.groupedActionsHeldUntil ?? null;
  return hold && hold > now ? hold : null;
}

/**
 * Whether an action is recorded as its group — a show, or a music artist — as
 * detection stores a series match (either scope) and an artist-scope music
 * match: a title with no parent title. The migration selects the same way.
 */
export function isGroupSnapshot(type: string, title: unknown, parentTitle: unknown): boolean {
  return (type === "SERIES" || type === "MUSIC") && title != null && parentTitle == null;
}

/** When a group's action of a rule set of this type may run: the hold, when that is later. */
export function groupScheduledFor(scheduledFor: Date, hold: Date | null, type: string): Date {
  return hold && hold > scheduledFor && (type === "SERIES" || type === "MUSIC") ? hold : scheduledFor;
}

/** When an action may run: its own date, or the hold if it is a group's and the hold is later. */
export function heldScheduledFor(
  scheduledFor: Date,
  hold: Date | null,
  snapshot: { type: string; title: unknown; parentTitle: unknown },
): Date {
  return isGroupSnapshot(snapshot.type, snapshot.title, snapshot.parentTitle)
    ? groupScheduledFor(scheduledFor, hold, snapshot.type)
    : scheduledFor;
}
