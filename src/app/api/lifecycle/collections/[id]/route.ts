import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  removePlexCollection,
  renameCollectionInPlex,
  syncCollectionById,
} from "@/lib/lifecycle/collections";
import { validateRequest, collectionUpdateSchema } from "@/lib/validation";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, collectionUpdateSchema);
  if (error) return error;

  const { name, sortName, homeScreen, recommended, sort } = data;

  const collection = await prisma.collection.findFirst({
    where: { id, userId: session.userId },
  });
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  // Renaming: reject a clash with another collection of the same type, and
  // rename the existing collection on Plex (found by its OLD name) before we
  // overwrite the stored name.
  const renamed = name !== undefined && name !== collection.name;
  if (renamed) {
    const clash = await prisma.collection.findFirst({
      where: { userId: session.userId, type: collection.type, name, id: { not: id } },
    });
    if (clash) {
      return NextResponse.json(
        { error: "A collection with this name already exists for this library type" },
        { status: 409 }
      );
    }
    try {
      await renameCollectionInPlex(session.userId!, collection.type, collection.name, name!);
    } catch {
      // Best-effort — the membership/visibility sync below still runs.
    }
  }

  const updated = await prisma.collection.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(sortName !== undefined ? { sortName } : {}),
      ...(homeScreen !== undefined ? { homeScreen } : {}),
      ...(recommended !== undefined ? { recommended } : {}),
      ...(sort !== undefined ? { sort } : {}),
    },
  });

  // Push the updated settings (sort order, sort title, visibility) — and the new
  // name — to Plex. Membership is recomputed from current matches.
  try {
    await syncCollectionById(id);
  } catch {
    // Best-effort — settings are persisted even if Plex is unreachable.
  }

  return NextResponse.json({ collection: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const collection = await prisma.collection.findFirst({
    where: { id, userId: session.userId },
  });
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  // Remove the collection from Plex. Rule sets that referenced it are detached
  // automatically (collectionId is set null via the FK), so they simply stop
  // contributing — their matches and actions are unaffected.
  try {
    await removePlexCollection(session.userId!, collection.type, collection.name);
  } catch {
    // Best-effort — don't block deletion if Plex is unreachable.
  }

  await prisma.collection.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
