-- A save that changes what a rule set matches (its rules, servers, series
-- scope, or the Arr instance its Arr criteria are read from) but keeps its
-- matches ("Save only", clearMatches=false) left every PENDING action armed
-- under the old rules: the executor only checks that the item's RuleMatch row
-- exists, and detection and execution run on separate schedules, so an action
-- whose item the edited rules no longer select could run before detection
-- re-checked it. Such a save now stamps the rule set; the next detection run
-- that evaluates it clears the stamp, and none of the rule set's actions run
-- while it is set. Existing rule sets start unheld.
ALTER TABLE "RuleSet" ADD COLUMN "actionsHeldSince" TIMESTAMP(3);
