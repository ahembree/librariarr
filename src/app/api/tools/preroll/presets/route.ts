import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, prerollPresetCreateSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const presets = await prisma.prerollPreset.findMany({
    where: { userId: session.userId! },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, prerollPresetCreateSchema);
  if (error) return error;
  const { name, path } = data;

  const preset = await prisma.prerollPreset.create({
    data: {
      userId: session.userId!,
      name: name.trim(),
      path: path.trim(),
    },
  });

  return NextResponse.json({ preset }, { status: 201 });
}
