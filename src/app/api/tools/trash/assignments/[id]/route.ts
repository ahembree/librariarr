import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, trashAssignmentUpdateSchema } from "@/lib/validation";

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
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
