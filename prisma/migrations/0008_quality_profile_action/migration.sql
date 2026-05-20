-- Add quality profile target for the new "Change Quality Profile" lifecycle action.
-- Stored as an integer because it's the Arr instance's internal profile id.
ALTER TABLE "RuleSet" ADD COLUMN "targetQualityProfileId" INTEGER;
ALTER TABLE "LifecycleAction" ADD COLUMN "targetQualityProfileId" INTEGER;

-- Rename searchAfterDelete -> searchAfterAction. The original name was
-- accurate when the flag only existed alongside the delete actions, but the
-- new "Change Quality Profile" action also uses it to trigger an Arr search
-- after the profile is updated. The generic name covers both contexts.
ALTER TABLE "RuleSet" RENAME COLUMN "searchAfterDelete" TO "searchAfterAction";
ALTER TABLE "LifecycleAction" RENAME COLUMN "searchAfterDelete" TO "searchAfterAction";
