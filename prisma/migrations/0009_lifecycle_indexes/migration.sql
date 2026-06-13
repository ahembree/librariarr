-- Add missing indexes on LifecycleAction. Phase 2 lifecycle processing cancels
-- pending actions by ruleSetId and filters by mediaItemId/userId; these queries
-- previously did sequential scans. CONCURRENTLY is intentionally not used so the
-- statements run inside the migration transaction.
CREATE INDEX IF NOT EXISTS "LifecycleAction_ruleSetId_idx" ON "LifecycleAction"("ruleSetId");
CREATE INDEX IF NOT EXISTS "LifecycleAction_mediaItemId_idx" ON "LifecycleAction"("mediaItemId");
CREATE INDEX IF NOT EXISTS "LifecycleAction_userId_idx" ON "LifecycleAction"("userId");

-- Drop the redundant single-column index: the composite unique
-- (ruleSetId, mediaItemId) already provides a usable index for ruleSetId lookups.
DROP INDEX IF EXISTS "RuleMatch_ruleSetId_idx";
