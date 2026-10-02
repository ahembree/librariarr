-- Detection stores a title matched on several servers ONCE, on one copy, and
-- lists the others in itemData.copies. "Matched By Rule Set" has to answer for
-- those copies too; reading them out of every match's JSON scanned (and
-- detoasted) the whole table on each evaluation. The ids get their own column
-- with a GIN index so the lookup is an array-overlap probe.
ALTER TABLE "RuleMatch" ADD COLUMN "copyIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "RuleMatch"
SET "copyIds" = ARRAY(
  SELECT c->>'id'
  FROM jsonb_array_elements("itemData"->'copies') AS c
  WHERE c->>'id' IS NOT NULL
)
WHERE jsonb_typeof("itemData"->'copies') = 'array';

CREATE INDEX "RuleMatch_copyIds_idx" ON "RuleMatch" USING GIN ("copyIds");
