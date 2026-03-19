import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { LidarrClient } from "@/lib/arr/lidarr-client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const instance = await prisma.lidarrInstance.findFirst({
    where: { id, userId: session.userId },
  });

  if (!instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  const client = new LidarrClient(instance.url, instance.apiKey);
  const [artists, qualityProfiles, tags] = await Promise.all([
    client.getArtists(),
    client.getQualityProfiles(),
    client.getTags(),
  ]);

  const tagMap = new Map(tags.map((t) => [t.id, t.label]));
  const profileMap = new Map(qualityProfiles.map((p) => [p.id, p.name]));

  const artistLookup: Record<
    string,
    {
      tags: string[];
      qualityProfile: string;
      monitored: boolean;
      rating: number | null;
    }
  > = {};

  for (const a of artists) {
    artistLookup[a.foreignArtistId] = {
      tags: a.tags.map((tid) => tagMap.get(tid) ?? String(tid)),
      qualityProfile: profileMap.get(a.qualityProfileId) ?? "Unknown",
      monitored: a.monitored,
      rating: a.ratings?.value ?? null,
    };
  }

  return NextResponse.json({
    artists: artistLookup,
    tags: tags.map((t) => ({ id: t.id, label: t.label })),
    qualityProfiles: qualityProfiles.map((p) => ({ id: p.id, name: p.name })),
  });
}
