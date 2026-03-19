import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, authSetupSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  try {
    // Guard: fail if any user already exists
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return NextResponse.json(
        { error: "Setup has already been completed" },
        { status: 403 }
      );
    }

    const { data, error } = await validateRequest(request, authSetupSchema);
    if (error) return error;
    const { username, password } = data;

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        localUsername: username.trim().toLowerCase(),
        passwordHash,
        username: username.trim(),
      },
    });

    // Create app settings with local auth enabled
    await prisma.appSettings.create({
      data: {
        userId: user.id,
        localAuthEnabled: true,
      },
    });

    // Mark setup as completed
    await prisma.systemConfig.upsert({
      where: { id: "singleton" },
      update: { setupCompleted: true },
      create: {
        id: "singleton",
        plexClientId: crypto.randomUUID(),
        setupCompleted: true,
      },
    });

    // Set session
    const session = await getSession();
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = 0;
    await session.save();

    apiLogger.info("Auth", `Setup completed: local user "${username}" created`);

    return NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "Setup failed", { error: String(error) });
    return NextResponse.json(
      { error: "Setup failed" },
      { status: 500 }
    );
  }
}
