import { NextRequest } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { jsonTextResponse } from "@/lib/api/json-response";
import { prisma } from "@/lib/db";
import { matchItemJson } from "@/lib/lifecycle/match-json";

export const GET = withSession(async (session, request: NextRequest) => {
  // Read persisted matches grouped by rule set
  const ruleSets = await prisma.ruleSet.findMany({
    where: { userId: session.userId, enabled: true },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      type: true,
      actionEnabled: true,
      actionType: true,
      actionDelayDays: true,
      arrInstanceId: true,
      targetQualityProfileId: true,
      addImportExclusion: true,
      searchAfterAction: true,
      addArrTags: true,
      removeArrTags: true,
      // The detail panel's Logic Preview, as the rule editor's preview shows it.
      rules: true,
      collection: { select: { name: true, sort: true } },
    },
  });

  // Each match's snapshot is read as JSON text and spliced into the response
  // (see `matchItemJson`), never parsed: the page reads every match, and a
  // parse-and-reserialise of each ~2 KB row was most of this route's time.
  const matchRows = ruleSets.length === 0
    ? []
    : await prisma.$queryRawUnsafe<{ ruleSetId: string; item: string | null; detectedAt: Date }[]>(
        `SELECT "ruleSetId", "itemData"::text AS item, "detectedAt"
         FROM "RuleMatch"
         WHERE "ruleSetId" = ANY($1::text[])
         ORDER BY "detectedAt" DESC, "id"`,
        ruleSets.map((rs) => rs.id),
      );
  const itemsByRuleSet = new Map<string, string[]>();
  for (const row of matchRows) {
    let items = itemsByRuleSet.get(row.ruleSetId);
    if (!items) {
      items = [];
      itemsByRuleSet.set(row.ruleSetId, items);
    }
    items.push(matchItemJson(row.item, row.detectedAt));
  }

  const groups = ruleSets.map((rs) => {
    const ruleSet = {
      id: rs.id,
      name: rs.name,
      type: rs.type,
      actionEnabled: rs.actionEnabled,
      actionType: rs.actionType,
      actionDelayDays: rs.actionDelayDays,
      arrInstanceId: rs.arrInstanceId,
      targetQualityProfileId: rs.targetQualityProfileId,
      addImportExclusion: rs.addImportExclusion,
      searchAfterAction: rs.searchAfterAction,
      addArrTags: rs.addArrTags,
      removeArrTags: rs.removeArrTags,
      rules: rs.rules,
      collectionName: rs.collection?.name ?? null,
      collectionSort: rs.collection?.sort ?? null,
    };
    const items = itemsByRuleSet.get(rs.id) ?? [];
    return `{"ruleSet":${JSON.stringify(ruleSet)},"items":[${items.join(",")}],"count":${items.length}}`;
  });

  return jsonTextResponse(request, `{"ruleMatches":[${groups.join(",")}]}`);
});
