import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, savedQueryCreateSchema } from "@/lib/validation";
import { findFieldsInvalidForTypes, type LibraryType } from "@/lib/conditions";

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

  // Reject fields invalid for every selected media type (mirrors the query
  // builder's multi-type gating). A field invalid for all targets can never
  // contribute matches, so persisting it would save a silently-dead query.
  const invalidFields = findFieldsInvalidForTypes(
    data.query.groups,
    data.query.mediaTypes as LibraryType[],
  );
  if (invalidFields.length > 0) {
    return NextResponse.json(
      { error: `These criteria are not valid for the selected media types: ${invalidFields.join(", ")}` },
      { status: 400 }
    );
  }

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
