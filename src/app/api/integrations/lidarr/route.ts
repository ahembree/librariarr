import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { validateRequest, arrInstanceCreateSchema } from "@/lib/validation";
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = await prisma.lidarrInstance.findMany({
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

  const { data, error } = await validateRequest(request, arrInstanceCreateSchema);
  if (error) return error;
  const { name, url, apiKey, externalUrl } = data;

  const client = new LidarrClient(url, apiKey);
  const result = await client.testConnection();
  if (!result.ok) {
    return NextResponse.json(
      { error: "Failed to connect to Lidarr", detail: sanitizeErrorDetail(result.error) },
      { status: 400 }
    );
  }

  const instance = await prisma.lidarrInstance.create({
    data: {
      userId: session.userId!,
      name,
      url: url.replace(/\/+$/, ""),
      apiKey,
      externalUrl: externalUrl ? externalUrl.replace(/\/+$/, "") : null,
    },
  });

  return NextResponse.json({ instance: sanitize(instance) }, { status: 201 });
}
