import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { validateRequest, mfaRecoverySchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "mfa-recovery");
    if (rateLimited) return rateLimited;

    const session = await getSession();
    if (!session.pendingMfaUserId) {
      return NextResponse.json({ error: "No pending MFA verification" }, { status: 400 });
    }

    const { data, error } = await validateRequest(request, mfaRecoverySchema);
    if (error) return error;
    const { code } = data;

    const user = await prisma.user.findUnique({
      where: { id: session.pendingMfaUserId },
      select: { id: true, totpEnabled: true, totpRecoveryCodes: true, username: true, sessionVersion: true, plexToken: true },
    });

    if (!user || !user.totpEnabled) {
      return NextResponse.json({ error: "MFA not configured" }, { status: 400 });
    }

    const normalizedCode = code.trim().toUpperCase();
    const codeIndex = user.totpRecoveryCodes.indexOf(normalizedCode);

    if (codeIndex === -1) {
      return NextResponse.json(
        { error: "Invalid recovery code" },
        { status: 401 }
      );
    }

    // Remove the used recovery code
    const updatedCodes = [...user.totpRecoveryCodes];
    updatedCodes.splice(codeIndex, 1);

    await prisma.user.update({
      where: { id: user.id },
      data: { totpRecoveryCodes: updatedCodes },
    });

    // Complete the login
    session.pendingMfaUserId = undefined;
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = user.sessionVersion;
    if (user.plexToken) {
      session.plexToken = user.plexToken;
    }
    await session.save();

    apiLogger.info("Auth", `MFA recovery code used for "${user.username}" (${updatedCodes.length} remaining)`);

    return NextResponse.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
      remainingCodes: updatedCodes.length,
    });
  } catch (error) {
    apiLogger.error("Auth", "MFA recovery failed", { error: String(error) });
    return NextResponse.json(
      { error: "Recovery failed" },
      { status: 500 }
    );
  }
}
