import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, reauthPasswordSchema } from "@/lib/validation";
import { peekAuthRateLimit, recordAuthFailure } from "@/lib/rate-limit/rate-limiter";

/**
 * Confirms the signed-in admin's identity with the account's current password
 * and stamps `session.authenticatedAt`, so an action that needs a recent
 * sign-in (linking Plex or an SSO identity) goes ahead without signing out
 * and back in.
 *
 * Charged against the auth limiters only on a wrong password, exactly like
 * the API-key step-up: a wrong one costs what a failed login does, so this is
 * not a cheaper password oracle than the login form.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = peekAuthRateLimit(request, "password-reauth");
  if (limited) return limited;

  const { data, error } = await validateRequest(request, reauthPasswordSchema);
  if (error) return error;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { passwordHash: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!user.passwordHash) {
    return NextResponse.json({ error: "This account has no password" }, { status: 400 });
  }

  if (!(await bcrypt.compare(data.password, user.passwordHash))) {
    recordAuthFailure(request, "password-reauth");
    apiLogger.warn("Auth", "Password re-authentication refused — the password was incorrect");
    return NextResponse.json(
      { error: "That password is not correct", code: "password_incorrect" },
      { status: 403 },
    );
  }

  session.authenticatedAt = Date.now();
  await session.save();

  apiLogger.info("Auth", "Identity confirmed with the account password");
  return NextResponse.json({ verified: true });
}
