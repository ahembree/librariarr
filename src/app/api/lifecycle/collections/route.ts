import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, collectionCreateSchema } from "@/lib/validation";

/**
 * List the user's reusable Plex collection definitions. Optionally filter by
 * `?type=MOVIE|SERIES|MUSIC` so the lifecycle rule editor only offers
 * collections matching the rule set's library type.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const type = request.nextUrl.searchParams.get("type");
  const where: { userId: string; type?: "MOVIE" | "SERIES" | "MUSIC" } = {
    userId: session.userId!,
  };
  if (type === "MOVIE" || type === "SERIES" || type === "MUSIC") {
    where.type = type;
  }

  const collections = await prisma.collection.findMany({
    where,
    orderBy: { name: "asc" },
    include: { _count: { select: { ruleSets: true } } },
  });

  return NextResponse.json({ collections });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, collectionCreateSchema);
  if (error) return error;

  const { name, type, sortName, homeScreen, recommended, sort } = data;

  const existing = await prisma.collection.findFirst({
    where: { userId: session.userId, type, name },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A collection with this name already exists for this library type" },
      { status: 409 }
    );
  }

  const collection = await prisma.collection.create({
    data: {
      userId: session.userId!,
      name,
      type,
      sortName: sortName ?? null,
      homeScreen: homeScreen ?? false,
      recommended: recommended ?? false,
      sort: sort ?? "ALPHABETICAL",
    },
  });

  return NextResponse.json({ collection }, { status: 201 });
}
