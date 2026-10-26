import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import { validateRequest, prerollPresetCreateSchema } from "@/lib/validation";

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, prerollPresetCreateSchema);
  if (error) return error;
  const { name, path } = data;

  const preset = await prisma.prerollPreset.create({
    data: {
      userId: session.userId,
      name: name.trim(),
      path: path.trim(),
    },
  });

  return NextResponse.json({ preset }, { status: 201 });
});
