import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { groupScheduledFor, loadGroupedActionHold } from "@/lib/lifecycle/grouped-action-hold";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const ruleSet = await prisma.ruleSet.findFirst({
    where: { id, userId: session.userId },
    select: { actionDelayDays: true, type: true },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + ruleSet.actionDelayDays);

  // A show's or an artist's action keeps the one-time upgrade hold, as when it
  // was scheduled (see grouped-action-hold.ts).
  const hold = await loadGroupedActionHold(session.userId!);
  const groupedFor = groupScheduledFor(scheduledFor, hold, ruleSet.type);

  const [result] = await prisma.$transaction([
    prisma.lifecycleAction.updateMany({
      where: { ruleSetId: id, status: "PENDING" },
      data: { scheduledFor },
    }),
    ...(groupedFor > scheduledFor
      ? [
          prisma.lifecycleAction.updateMany({
            where: { ruleSetId: id, status: "PENDING", mediaItemTitle: { not: null }, mediaItemParentTitle: null },
            data: { scheduledFor: groupedFor },
          }),
        ]
      : []),
  ]);

  return NextResponse.json({ updated: result.count });
}
