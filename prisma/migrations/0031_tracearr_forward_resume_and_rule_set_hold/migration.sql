-- The start of a forward (catch-up) window the Tracearr import has not
-- finished walking. Tracearr serves history newest first, so a catch-up that
-- stops after a page has already stored the newest plays, and the next window
-- -- derived from MAX("watchedAt") -- would start above the stretch it never
-- reached. NULL on every existing row: no unfinished window is recorded yet.
ALTER TABLE "MediaServer" ADD COLUMN "tracearrForwardResumeAt" TIMESTAMP(3);

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
