import type { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";

/**
 * Detach every lifecycle reference to an Arr instance that is being deleted.
 *
 * `RuleSet.arrInstanceId` and `LifecycleAction.arrInstanceId` are plain strings
 * (the id can name a Radarr, Sonarr or Lidarr instance, so there is no FK to
 * cascade or null them). Left in place, the rule set kept matching and
 * scheduling actions that all failed with "instance not found", and its
 * pending actions sat there failing on every run.
 *
 * So, in the deleting transaction: pending actions bound to the instance are
 * cancelled, and the rule sets lose the instance and have their action turned
 * off — the user picks a new instance and re-enables it. A "Do Nothing"
 * action with no Arr tags never touched the instance and stays enabled.
 */
export async function detachDeletedArrInstance(
  tx: Prisma.TransactionClient,
  userId: string,
  instanceId: string,
  service: string,
): Promise<void> {
  const cancelled = await tx.lifecycleAction.deleteMany({
    where: { userId, arrInstanceId: instanceId, status: "PENDING" },
  });
  const usesInstance = {
    userId,
    arrInstanceId: instanceId,
    OR: [
      { actionType: { not: "DO_NOTHING" } },
      { actionType: null },
      { addArrTags: { isEmpty: false } },
      { removeArrTags: { isEmpty: false } },
    ],
  } satisfies Prisma.RuleSetWhereInput;
  const disarmed = await tx.ruleSet.updateMany({
    where: usesInstance,
    data: { arrInstanceId: null, actionEnabled: false },
  });
  const detached = await tx.ruleSet.updateMany({
    where: { userId, arrInstanceId: instanceId },
    data: { arrInstanceId: null },
  });
  if (cancelled.count > 0 || disarmed.count > 0 || detached.count > 0) {
    logger.warn(
      "Lifecycle",
      `Deleted ${service} instance ${instanceId}: cancelled ${cancelled.count} pending action(s), turned off the action of ${disarmed.count} rule set(s) and detached ${disarmed.count + detached.count} rule set(s) from it`,
    );
  }
}
