import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, trashAssignmentUpdateSchema } from "@/lib/validation";
import { fetchTrashCatalog, catalogHasResource } from "@/lib/trash/catalog";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import type { ServiceType } from "@/lib/trash/types";

// Update a managed resource's stored options (currently the naming selection).
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, trashAssignmentUpdateSchema);
  if (error) return error;

  const existing = await prisma.trashManagedResource.findFirst({
    where: { id, userId: session.userId! },
    select: { id: true, serviceType: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If the new selection attaches custom-format scores (PROFILE_CF), re-run the
  // same guide cross-reference the POST consent gate uses. Without this a PUT
  // could smuggle in CF trash_ids from another service or ones not in the guide,
  // bypassing the cross-service gate that POST enforces on assignment.
  const sel = data.selection as { formats?: { trashId: string }[] } | undefined;
  if (sel?.formats?.length) {
    let catalog;
    try {
      catalog = await fetchTrashCatalog(existing.serviceType as ServiceType);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Could not verify items against the guide catalog",
          detail: sanitizeErrorDetail(err instanceof Error ? err.message : undefined),
        },
        { status: 502 },
      );
    }
    const invalid = sel.formats.filter(
      (f) => !catalogHasResource(catalog, "CUSTOM_FORMAT", f.trashId),
    );
    if (invalid.length) {
      const svc = existing.serviceType === "SONARR" ? "Sonarr" : "Radarr";
      return NextResponse.json(
        {
          error: `These custom formats are not part of the ${svc} guide: ${invalid
            .map((f) => f.trashId)
            .join(", ")}`,
        },
        { status: 400 },
      );
    }
  }

  const assignment = await prisma.trashManagedResource.update({
    where: { id },
    data: { selection: data.selection as object },
  });
  return NextResponse.json({ assignment });
}

// Stop managing a resource. This removes only the Librariarr management record —
// it never deletes the resource from the Arr app.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await prisma.trashManagedResource.findFirst({
    where: { id, userId: session.userId! },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.trashManagedResource.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
