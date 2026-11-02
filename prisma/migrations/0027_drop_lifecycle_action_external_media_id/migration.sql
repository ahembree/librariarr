-- `LifecycleAction.externalMediaId` has existed since 0001_init but nothing
-- has ever written or read it: an action's Arr identity is the
-- `mediaItemExternalId` snapshot (0024). Every row holds NULL.
ALTER TABLE "LifecycleAction" DROP COLUMN "externalMediaId";
