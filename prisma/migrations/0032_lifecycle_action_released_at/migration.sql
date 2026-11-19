-- A COMPLETED/FAILED non-destructive action suppresses scheduling the same
-- action (same config signature) on its item again, so it does not re-run as
-- a no-op every cycle while the item keeps matching. That suppression was
-- permanent: an item that stopped matching after the action ran (e.g. its
-- quality profile was changed back by hand) and then matched again was never
-- acted on again. Detection now stamps the settled actions of an item whose
-- match it drops; a stamped action no longer suppresses. Existing rows start
-- unstamped (behaviour unchanged until an item next stops matching).
ALTER TABLE "LifecycleAction" ADD COLUMN "releasedAt" TIMESTAMP(3);
