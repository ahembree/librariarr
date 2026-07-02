import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, trashAssignSchema } from "@/lib/validation";
import { resolveInstance, managedInstanceWhere } from "@/lib/trash/status";
import { fetchTrashCatalog, catalogHasResource } from "@/lib/trash/catalog";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import type { ServiceType } from "@/lib/trash/types";

// List the managed (assigned) resources, optionally scoped to one instance.
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const serviceType = searchParams.get("serviceType")?.toUpperCase();
  const instanceId = searchParams.get("instanceId");

  const instanceFilter =
    (serviceType === "SONARR" || serviceType === "RADARR") && instanceId
      ? managedInstanceWhere(serviceType as ServiceType, instanceId)
      : {};

  const assignments = await prisma.trashManagedResource.findMany({
    where: { userId: session.userId!, ...instanceFilter },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ assignments });
}

// Opt guide resources into Librariarr management. This is the consent gate:
// creating a managed row is what later permits the sync to write to the Arr.
// Creating the row itself performs NO Arr write.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, trashAssignSchema);
  if (error) return error;

  const inst = await resolveInstance(session.userId!, data.serviceType, data.instanceId);
  if (!inst) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  // Cross-service gate: every item must belong to the target service's guide.
  // `resolveInstance` already forces serviceType to match the instance, so this
  // rejects e.g. a Sonarr custom format assigned to a Radarr instance — its
  // trash_id is not in the Radarr catalog.
  let catalog;
  try {
    catalog = await fetchTrashCatalog(data.serviceType);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Could not verify items against the guide catalog",
        detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
      },
      { status: 502 },
    );
  }
  const invalid = data.items.filter((item) => {
    // PROFILE_CF targets a profile by name (not a guide item); instead validate
    // that every custom format it attaches is a guide custom format.
    if (item.resourceType === "PROFILE_CF") {
      const sel = item.selection as { formats?: { trashId: string }[] } | undefined;
      return (sel?.formats ?? []).some(
        (f) => !catalogHasResource(catalog, "CUSTOM_FORMAT", f.trashId),
      );
    }
    return !catalogHasResource(catalog, item.resourceType, item.trashId);
  });
  if (invalid.length) {
    const svc = data.serviceType === "SONARR" ? "Sonarr" : "Radarr";
    return NextResponse.json(
      {
        error: `These items are not part of the ${svc} guide and cannot be managed on a ${svc} instance: ${invalid
          .map((i) => `${i.resourceType} ${i.trashId}`)
          .join(", ")}`,
      },
      { status: 400 },
    );
  }

  const instanceKey = managedInstanceWhere(data.serviceType, data.instanceId);
  // Apply the whole batch atomically: a mid-loop failure (e.g. one bad row)
  // must not leave a partially-assigned set behind — either all requested
  // resources become managed or none do.
  const results = await prisma.$transaction(
    data.items.map((item) => {
      // Atomic upsert on the (user, instance, resource) composite unique — a
      // concurrent double-submit can't create duplicate managed rows. Re-assigning
      // an already-managed resource just refreshes its metadata (e.g. a changed
      // naming selection).
      const selectionData =
        item.selection !== undefined ? { selection: item.selection as object } : {};
      const where =
        data.serviceType === "SONARR"
          ? {
              userId_sonarrInstanceId_resourceType_trashId: {
                userId: session.userId!,
                sonarrInstanceId: data.instanceId,
                resourceType: item.resourceType,
                trashId: item.trashId,
              },
            }
          : {
              userId_radarrInstanceId_resourceType_trashId: {
                userId: session.userId!,
                radarrInstanceId: data.instanceId,
                resourceType: item.resourceType,
                trashId: item.trashId,
              },
            };
      return prisma.trashManagedResource.upsert({
        where,
        create: {
          userId: session.userId!,
          serviceType: data.serviceType,
          ...instanceKey,
          resourceType: item.resourceType,
          trashId: item.trashId,
          name: item.name,
          ...selectionData,
        },
        update: { name: item.name, ...selectionData },
      });
    }),
  );

  return NextResponse.json({ assignments: results }, { status: 201 });
}
