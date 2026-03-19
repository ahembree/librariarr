import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, transcodeManagerSchema } from "@/lib/validation";

const DEFAULT_CRITERIA = {
  anyTranscoding: false,
  videoTranscoding: false,
  audioTranscoding: false,
  fourKTranscoding: false,
  remoteTranscoding: false,
};

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: {
      transcodeManagerEnabled: true,
      transcodeManagerMessage: true,
      transcodeManagerDelay: true,
      transcodeManagerCriteria: true,
      transcodeManagerExcludedUsers: true,
    },
  });

  return NextResponse.json({
    enabled: settings?.transcodeManagerEnabled ?? false,
    message: settings?.transcodeManagerMessage ?? "",
    delay: settings?.transcodeManagerDelay ?? 30,
    criteria: (settings?.transcodeManagerCriteria as Record<string, boolean> | null) ?? DEFAULT_CRITERIA,
    excludedUsers: settings?.transcodeManagerExcludedUsers ?? [],
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, transcodeManagerSchema);
  if (error) return error;
  const { enabled, message, delay, criteria, excludedUsers } = data;

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: {
      transcodeManagerEnabled: enabled,
      transcodeManagerMessage: message,
      ...(delay !== undefined && { transcodeManagerDelay: delay }),
      ...(criteria !== undefined && { transcodeManagerCriteria: criteria }),
      ...(excludedUsers !== undefined && { transcodeManagerExcludedUsers: excludedUsers }),
    },
    create: {
      userId: session.userId!,
      transcodeManagerEnabled: enabled,
      transcodeManagerMessage: message,
      transcodeManagerDelay: delay ?? 30,
      transcodeManagerCriteria: criteria ?? DEFAULT_CRITERIA,
      ...(excludedUsers !== undefined && { transcodeManagerExcludedUsers: excludedUsers }),
    },
    select: {
      transcodeManagerEnabled: true,
      transcodeManagerMessage: true,
      transcodeManagerDelay: true,
      transcodeManagerCriteria: true,
      transcodeManagerExcludedUsers: true,
    },
  });

  return NextResponse.json({
    enabled: settings.transcodeManagerEnabled,
    message: settings.transcodeManagerMessage,
    delay: settings.transcodeManagerDelay,
    criteria: settings.transcodeManagerCriteria ?? DEFAULT_CRITERIA,
    excludedUsers: settings.transcodeManagerExcludedUsers,
  });
}
