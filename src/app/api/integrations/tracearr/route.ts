import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import { validateRequest, tracearrInstanceCreateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = await prisma.tracearrInstance.findMany({
    where: { userId: session.userId! },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ instances: sanitize(instances) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, tracearrInstanceCreateSchema);
  if (error) return error;
  const { name, url, apiKey } = data;

  const client = new TracearrClient(url, apiKey);
  const result = await client.testConnection();
  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to connect to Tracearr", detail: sanitizeErrorDetail(result.error) },
      { status: 400 }
    );
  }

  const instance = await prisma.tracearrInstance.create({
    data: {
      userId: session.userId!,
      name,
      url: url.replace(/\/+$/, ""),
      apiKey,
    },
  });

  return NextResponse.json({ instance: sanitize(instance) }, { status: 201 });
}
