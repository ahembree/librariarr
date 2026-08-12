import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { sendDiscordNotification, buildMaintenanceEmbed } from "@/lib/discord/client";
import { validateRequest, maintenanceSchema } from "@/lib/validation";

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { maintenanceMode: true, maintenanceMessage: true, maintenanceDelay: true, discordNotifyMaintenance: true, maintenanceExcludedUsers: true },
  });

  return NextResponse.json({
    enabled: settings?.maintenanceMode ?? false,
    message: settings?.maintenanceMessage ?? "",
    delay: settings?.maintenanceDelay ?? 30,
    discordNotifyMaintenance: settings?.discordNotifyMaintenance ?? false,
    excludedUsers: settings?.maintenanceExcludedUsers ?? [],
  });
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, maintenanceSchema);
  if (error) return error;
  const { enabled, message, delay, discordNotifyMaintenance, excludedUsers } = data;

  // Capture the prior state so the Discord notification fires only on an
  // actual enabled↔disabled transition. This route is also called for every
  // message/delay/exclusion edit (the UI saves on each keystroke of the custom
  // message while maintenance is on), and notifying on every PUT spammed the
  // webhook with identical "maintenance enabled" embeds.
  const prior = await prisma.appSettings.findUnique({
    where: { userId: session.userId! },
    select: { maintenanceMode: true },
  });

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.userId! },
    update: {
      maintenanceMode: enabled,
      maintenanceMessage: message,
      ...(delay !== undefined && { maintenanceDelay: delay }),
      ...(discordNotifyMaintenance !== undefined && { discordNotifyMaintenance }),
      ...(excludedUsers !== undefined && { maintenanceExcludedUsers: excludedUsers }),
    },
    create: {
      userId: session.userId!,
      maintenanceMode: enabled,
      maintenanceMessage: message,
      ...(delay !== undefined && { maintenanceDelay: delay }),
      ...(discordNotifyMaintenance !== undefined && { discordNotifyMaintenance }),
      ...(excludedUsers !== undefined && { maintenanceExcludedUsers: excludedUsers }),
    },
    select: {
      maintenanceMode: true,
      maintenanceMessage: true,
      maintenanceDelay: true,
      maintenanceExcludedUsers: true,
      discordWebhookUrl: true,
      discordWebhookUsername: true,
      discordWebhookAvatarUrl: true,
      discordNotifyMaintenance: true,
    },
  });

  // Send Discord notification only when maintenance actually toggled, and only
  // if configured. A new row (prior === null) counts as a transition when
  // enabled is true.
  const stateChanged = (prior?.maintenanceMode ?? false) !== enabled;
  if (stateChanged && settings.discordNotifyMaintenance && settings.discordWebhookUrl) {
    sendDiscordNotification(settings.discordWebhookUrl, {
      username: settings.discordWebhookUsername || "Librariarr",
      avatar_url: settings.discordWebhookAvatarUrl || undefined,
      embeds: [buildMaintenanceEmbed(enabled, message)],
    }).catch(() => {});
  }

  return NextResponse.json({
    enabled: settings.maintenanceMode,
    message: settings.maintenanceMessage,
    delay: settings.maintenanceDelay,
    discordNotifyMaintenance: settings.discordNotifyMaintenance,
    excludedUsers: settings.maintenanceExcludedUsers,
  });
}
