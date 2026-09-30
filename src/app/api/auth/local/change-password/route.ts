import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, changePasswordSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { isPasswordSignInEnabled } from "@/lib/auth/password-sign-in";

export async function POST(request: NextRequest) {
  // Rate-limit even though the route is authenticated. bcrypt.compare runs on
  // each call and the route is otherwise an oracle for testing currentPassword.
  const rateLimited = checkAuthRateLimit(request, "change-password");
  if (rateLimited) return rateLimited;

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

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify currentPassword *first* so the route doesn't become a username-
    // enumeration oracle for callers without the current password (the
    // 409 "Username is already taken" response would otherwise leak which
    // local usernames exist before any auth check). Skipped when the user has
    // no password yet — initial credential setup for a Plex/SSO-only account —
    // and when password sign-in is off, when the password is accepted for
    // nothing (password-sign-in.ts) and a recent sign-in stands in for it.
    const acceptedHash = user.passwordHash && (await isPasswordSignInEnabled()) ? user.passwordHash : null;
    if (acceptedHash) {
      if (!currentPassword) {
        return NextResponse.json(
          { error: "Current password is required" },
          { status: 400 }
        );
      }
      const valid = await bcrypt.compare(currentPassword, acceptedHash);
      if (!valid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 401 }
        );
      }
    } else if (user.passwordHash && !hasRecentLogin(session)) {
      // Password sign-in is off, so the current password proves nothing. Any
      // credential change still needs proof, as it does with the password on:
      // a recent sign-in by another method.
      return reauthRequired(session.userId!, "Changing your local credentials");
    } else if (hasNewPassword && !hasRecentLogin(session)) {
      // There is no current password to confirm, and a first password is a
      // lasting way in that outlives this session (see recent-login.ts): a
      // stolen cookie must not be able to set one, nor use it to get past the
      // API-key step-up, which accepts the password in place of a recent
      // sign-in.
      return reauthRequired(session.userId!, "Setting a password");
    }

    if (hasNewUsername) {
      const trimmed = newUsername.trim();
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
