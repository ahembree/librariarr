import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { syncCollectionById } from "@/lib/lifecycle/collections";
import { validateRequest, collectionSyncSchema } from "@/lib/validation";

/**
 * Manually push a collection to Plex from its current persisted matches. Syncs
 * the UNION of every enabled rule set assigned to the collection.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, collectionSyncSchema);
  if (error) return error;

  const { collectionId } = data;

  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, userId: session.userId },
    select: { id: true, name: true },
  });
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  await syncCollectionById(collection.id);

  return NextResponse.json({ success: true, collectionName: collection.name });
}
