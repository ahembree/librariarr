import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { validateRequest, arrTestSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, arrTestSchema);
  if (error) return error;
  const { url, apiKey } = data;

  const client = new SonarrClient(url, apiKey);
  const result = await client.testConnection();
  return NextResponse.json(result);
}
