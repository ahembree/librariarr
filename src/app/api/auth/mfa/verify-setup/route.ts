import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { verifyTotpToken, generateRecoveryCodes } from "@/lib/auth/mfa";
import { validateRequest, mfaVerifySetupSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await validateRequest(request, mfaVerifySetupSchema);
    if (error) return error;
    const { token, secret } = data;

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { totpEnabled: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (user.totpEnabled) {
      return NextResponse.json(
        { error: "MFA is already enabled" },
        { status: 400 }
      );
    }

    const valid = verifyTotpToken(secret, token);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid verification code. Please try again." },
        { status: 400 }
      );
    }

    const recoveryCodes = generateRecoveryCodes();

    await prisma.user.update({
      where: { id: session.userId },
      data: {
        totpSecret: secret,
        totpEnabled: true,
        totpRecoveryCodes: recoveryCodes,
      },
    });

    apiLogger.info("Auth", `MFA enabled for user ${session.userId}`);

    return NextResponse.json({ success: true, recoveryCodes });
  } catch (error) {
    apiLogger.error("Auth", "MFA verify-setup failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to enable MFA" },
      { status: 500 }
    );
  }
}
