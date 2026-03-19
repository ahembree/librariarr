import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

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
    select: { actionDelayDays: true },
  });

  if (!ruleSet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const scheduledFor = new Date();
  scheduledFor.setDate(scheduledFor.getDate() + ruleSet.actionDelayDays);

  const result = await prisma.lifecycleAction.updateMany({
    where: { ruleSetId: id, status: "PENDING" },
    data: { scheduledFor },
  });

  return NextResponse.json({ updated: result.count });
}
