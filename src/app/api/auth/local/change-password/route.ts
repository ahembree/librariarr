import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, changePasswordSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data, error } = await validateRequest(request, changePasswordSchema);
    if (error) return error;

    const { currentPassword, newPassword, newUsername } = data;

    const hasNewPassword = !!newPassword;
    const hasNewUsername = !!newUsername;

    if (!hasNewPassword && !hasNewUsername) {
      return NextResponse.json(
        { error: "Provide a new password or username" },
        { status: 400 }
      );
    }

    if (hasNewUsername) {
      const trimmed = newUsername.trim();
      // Check for uniqueness
      const existing = await prisma.user.findUnique({
        where: { localUsername: trimmed.toLowerCase() },
      });
      if (existing && existing.id !== session.userId) {
        return NextResponse.json(
          { error: "Username is already taken" },
          { status: 409 }
        );
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // If user already has a password, verify the current one
    if (user.passwordHash) {
      if (!currentPassword) {
        return NextResponse.json(
          { error: "Current password is required" },
          { status: 400 }
        );
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 401 }
        );
      }
    }

    const updateData: { passwordHash?: string; localUsername?: string; username?: string } = {};

    if (hasNewPassword) {
      updateData.passwordHash = await bcrypt.hash(newPassword, 12);
    }

    if (hasNewUsername) {
      const trimmed = newUsername.trim();
      updateData.localUsername = trimmed.toLowerCase();
      updateData.username = trimmed;
    }

    // If no local username is set yet and only changing password, derive from display name
    if (!user.localUsername && !hasNewUsername) {
      updateData.localUsername = user.username.trim().toLowerCase();
    }

    // Increment sessionVersion to invalidate all other sessions
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { ...updateData, sessionVersion: { increment: 1 } },
    });

    // Keep the current session valid with the new version
    session.sessionVersion = updated.sessionVersion;
    await session.save();

    const changes = [hasNewUsername && "username", hasNewPassword && "password"].filter(Boolean).join(" and ");
    apiLogger.info("Auth", `Credentials updated (${changes}) for "${user.username}"`);

    return NextResponse.json({
      success: true,
      localUsername: updateData.localUsername ?? user.localUsername,
    });
  } catch (error) {
    apiLogger.error("Auth", "Change credentials failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to update credentials" },
      { status: 500 }
    );
  }
}
