-- Add quality profile target for the new "Change Quality Profile" lifecycle action.
-- Stored as an integer because it's the Arr instance's internal profile id.
ALTER TABLE "RuleSet" ADD COLUMN "targetQualityProfileId" INTEGER;
ALTER TABLE "LifecycleAction" ADD COLUMN "targetQualityProfileId" INTEGER;
