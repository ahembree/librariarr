import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, prerollPresetUpdateSchema } from "@/lib/validation";

export const PUT = withSession(async (
  session,
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const { data, error } = await validateRequest(request, prerollPresetUpdateSchema);
  if (error) return error;
  const { name, path } = data;

  // Verify ownership
  const existing = await prisma.prerollPreset.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const preset = await prisma.prerollPreset.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(path !== undefined && { path: path.trim() }),
    },
  });

  return NextResponse.json({ preset });
});

export const DELETE = withSession(async (
  session,
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;

  // Verify ownership
  const existing = await prisma.prerollPreset.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.prerollPreset.delete({ where: { id } });

  return NextResponse.json({ success: true });
});
