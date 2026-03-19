import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
      addImportExclusion: true,
      searchAfterDelete: true,
      addArrTags: true,
      removeArrTags: true,
      collectionEnabled: true,
      collectionName: true,
      collectionSort: true,
      ruleMatches: {
        select: { itemData: true, detectedAt: true },
        orderBy: { detectedAt: "desc" },
      },
    },
  });

  const ruleMatches = ruleSets
    .map((rs) => ({
      ruleSet: {
        id: rs.id,
        name: rs.name,
        type: rs.type,
        actionEnabled: rs.actionEnabled,
        actionType: rs.actionType,
        actionDelayDays: rs.actionDelayDays,
        arrInstanceId: rs.arrInstanceId,
        addImportExclusion: rs.addImportExclusion,
        searchAfterDelete: rs.searchAfterDelete,
        addArrTags: rs.addArrTags,
        removeArrTags: rs.removeArrTags,
        collectionEnabled: rs.collectionEnabled,
        collectionName: rs.collectionName,
        collectionSort: rs.collectionSort,
      },
      items: rs.ruleMatches.map((m) => ({
        ...(m.itemData as Record<string, unknown>),
        detectedAt: m.detectedAt.toISOString(),
      })),
      count: rs.ruleMatches.length,
    }));

  return NextResponse.json({ ruleMatches });
}
