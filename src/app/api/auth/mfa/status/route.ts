import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { totpEnabled: true, totpRecoveryCodes: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      mfaEnabled: user.totpEnabled,
      recoveryCodesRemaining: user.totpRecoveryCodes.length,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to get MFA status" },
      { status: 500 }
    );
  }
}
