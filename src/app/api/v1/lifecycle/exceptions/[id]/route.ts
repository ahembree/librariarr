import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { prisma } from "@/lib/db";

/**
 * Un-protect an item.
 *
 * Removing an exception needs no follow-up — the item simply becomes eligible
 * again and the next detection run re-matches it (and re-adds it to any
 * collection) on its own. This mirrors the UI's DELETE, which is likewise a
 * bare delete.
 *
 * `deleteMany` with the ownership filter baked in makes the scoping and the
 * existence check the same statement, so there is no window between them.
 */
export const DELETE = withApiKey(
  async (_request, { userId, params }) => {
    const { count } = await prisma.lifecycleException.deleteMany({
      where: { id: params.id, userId },
    });

    if (count === 0) return v1Error("Exception not found", 404);

    return NextResponse.json({ success: true, id: params.id });
  },
  { scope: "READ_WRITE" },
);
