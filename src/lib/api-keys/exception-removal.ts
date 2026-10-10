import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getApiKeyPrincipal } from "./principal";
import { destructiveRefusalResponse, reserveApiDestructive } from "./destructive-budget";

/**
 * Remove exceptions through `remove`, charged to the API's destructive budget,
 * or refuse without removing anything.
 *
 * Removing an exception deletes nothing by itself, but it is what lets the
 * rules match the item again, and the item's deletion then runs on the rule
 * set's own schedule, where no API budget applies. Unprotecting 1,000 items in
 * one call would be a mass deletion one detection cycle later, so each removal
 * counts as one destructive item. Only exceptions that exist and belong to the
 * key's owner are charged — an id that matches nothing costs nothing — and the
 * charge is settled on what `remove` actually removed (`removedCount`, read off
 * its response): an exception that was gone by the time the delete ran (a
 * concurrent request removed it) is given back, so two overlapping calls with
 * the same ids are charged once, not twice.
 */
export async function removeExceptionsCharged(
  ids: string[],
  remove: () => Promise<Response>,
  removedCount: (response: Response) => Promise<number>,
): Promise<Response> {
  const principal = getApiKeyPrincipal();
  // Only reachable if a route forgot `withApiKey` — fail closed.
  if (!principal) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const count = await prisma.lifecycleException.count({
    where: { id: { in: ids }, userId: principal.userId },
  });
  const reservation = reserveApiDestructive(count);
  if (!reservation.ok) return destructiveRefusalResponse(reservation);

  let removed = 0;
  try {
    const response = await remove();
    if (response.ok) {
      // The removal has happened; a response it cannot be read off keeps the
      // whole charge rather than turning a success into a refunded 500.
      removed = count;
      try {
        removed = Math.min(count, Math.max(0, await removedCount(response.clone())));
      } catch {
        // Keep the whole charge.
      }
    }
    return response;
  } finally {
    reservation.release(count - removed);
  }
}
