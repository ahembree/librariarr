import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, exceptionUpdateSchema } from "@/lib/validation";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  // deleteMany, not findFirst + delete: a concurrent removal of the same
  // exception (a second tab, or two API calls) must answer 404 here rather
  // than throw P2025 into a 500.
  const { count } = await prisma.lifecycleException.deleteMany({
    where: { id, userId: session.userId! },
  });

  if (count === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await validateRequest(request, exceptionUpdateSchema);
  if (error) return error;

  // updateMany, like DELETE: an exception removed between a lookup and the
  // update must answer 404, not throw P2025 into a 500.
  const { count } = await prisma.lifecycleException.updateMany({
    where: { id, userId: session.userId! },
    data: { reason: data.reason },
  });
  const updated = count > 0 ? await prisma.lifecycleException.findFirst({ where: { id, userId: session.userId! } }) : null;

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ exception: updated });
}
