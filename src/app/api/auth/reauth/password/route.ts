import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiLogger } from "@/lib/logger";
import { validateRequest, reauthPasswordSchema } from "@/lib/validation";
import { loadReauthContext } from "@/lib/auth/reauth";
import {
  PASSWORD_CONFIRM_BUCKET,
  peekAuthRateLimit,
  reserveAuthAttempt,
} from "@/lib/rate-limit/rate-limiter";

/**
 * Confirms the signed-in admin's identity with the account's current password
 * and stamps `session.authenticatedAt`, so an action that needs a recent
 * sign-in (linking Plex or an SSO identity) goes ahead without signing out
 * and back in. Only while password sign-in is on: with it off the password
 * is accepted for nothing (password-sign-in.ts).
 *
 * Charged against the auth limiters only on a wrong password, and in the SAME
 * bucket as the API-key step-up (`PASSWORD_CONFIRM_BUCKET`): each bucket has
 * its own per-address and global budget, so a bucket of its own would have
 * added a second budget of guesses beside that one.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = peekAuthRateLimit(request, PASSWORD_CONFIRM_BUCKET);
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
  // Password sign-in turned off (local login off, or SSO replacing it): the
  // password is accepted for nothing, so it is never compared (see reauth.ts).
  if (!(await loadReauthContext(session.userId)).methods.includes("password")) {
    return NextResponse.json({ error: "Password sign-in is turned off" }, { status: 400 });
  }

  // Charged before the compare, refunded on a match: concurrent guesses each
  // count from the moment they start (see `reserveAuthAttempt`).
  const attempt = reserveAuthAttempt(request, PASSWORD_CONFIRM_BUCKET);
  if (attempt.refused) return attempt.refused;
  if (!(await bcrypt.compare(data.password, user.passwordHash))) {
    apiLogger.warn("Auth", "Password re-authentication refused — the password was incorrect");
    return NextResponse.json(
      { error: "That password is not correct", code: "password_incorrect" },
      { status: 403 },
    );
  }

  attempt.refund();

  session.authenticatedAt = Date.now();
  await session.save();

  apiLogger.info("Auth", "Identity confirmed with the account password");
  return NextResponse.json({ verified: true });
}
