import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, savedQueryCreateSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const queries = await prisma.savedQuery.findMany({
    where: { userId: session.userId! },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      query: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ queries });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, savedQueryCreateSchema);
  if (error) return error;

  const query = await prisma.savedQuery.create({
    data: {
      userId: session.userId!,
      name: data.name,
      query: data.query as object,
    },
    select: {
      id: true,
      name: true,
      query: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ query }, { status: 201 });
}
