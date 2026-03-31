import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { verifyTotpToken } from "@/lib/auth/mfa";
import { validateRequest, mfaVerifySchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "mfa-verify");
    if (rateLimited) return rateLimited;

    const session = await getSession();
    if (!session.pendingMfaUserId) {
      return NextResponse.json({ error: "No pending MFA verification" }, { status: 400 });
    }

    const { data, error } = await validateRequest(request, mfaVerifySchema);
    if (error) return error;
    const { token } = data;

    const user = await prisma.user.findUnique({
      where: { id: session.pendingMfaUserId },
      select: { id: true, totpSecret: true, totpEnabled: true, username: true, sessionVersion: true, plexToken: true },
    });

    if (!user || !user.totpEnabled || !user.totpSecret) {
      return NextResponse.json({ error: "MFA not configured" }, { status: 400 });
    }

    const valid = verifyTotpToken(user.totpSecret, token);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid verification code" },
        { status: 401 }
      );
    }

    // MFA passed — complete the login
    session.pendingMfaUserId = undefined;
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = user.sessionVersion;
    if (user.plexToken) {
      session.plexToken = user.plexToken;
    }
    await session.save();

    apiLogger.info("Auth", `MFA verified for "${user.username}"`);

    return NextResponse.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "MFA verification failed", { error: String(error) });
    return NextResponse.json(
      { error: "MFA verification failed" },
      { status: 500 }
    );
  }
}
