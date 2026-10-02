import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getApiKeyPrincipal } from "./principal";
import { destructiveRefusalResponse, reserveApiDestructive } from "./destructive-budget";

/**
 * Charge removing these exceptions to the API's destructive budget, or refuse.
 *
 * Removing an exception deletes nothing by itself, but it is what lets the
 * rules match the item again, and the item's deletion then runs on the rule
 * set's own schedule, where no API budget applies. Unprotecting 1,000 items in
 * one call would be a mass deletion one detection cycle later, so each removal
 * counts as one destructive item. Only exceptions that exist and belong to the
 * key's owner are counted: an id that matches nothing costs nothing.
 *
 * Returns the response to send when refused, `null` when the removal may go
 * ahead.
 */
export async function reserveExceptionRemoval(ids: string[]): Promise<NextResponse | null> {
  const principal = getApiKeyPrincipal();
  // Only reachable if a route forgot `withApiKey` — fail closed.
  if (!principal) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const count = await prisma.lifecycleException.count({
    where: { id: { in: ids }, userId: principal.userId },
  });
  const reservation = reserveApiDestructive(count);
  return reservation.ok ? null : destructiveRefusalResponse(reservation);
}
