import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { validateRequest, mfaDisableSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data, error } = await validateRequest(request, mfaDisableSchema);
    if (error) return error;
    const { password } = data;

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { passwordHash: true, totpEnabled: true },
    });

    if (!user || !user.passwordHash) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!user.totpEnabled) {
      return NextResponse.json(
        { error: "MFA is not enabled" },
        { status: 400 }
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid password" },
        { status: 401 }
      );
    }

    await prisma.user.update({
      where: { id: session.userId },
      data: {
        totpSecret: null,
        totpEnabled: false,
        totpRecoveryCodes: [],
      },
    });

    apiLogger.info("Auth", `MFA disabled for user ${session.userId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    apiLogger.error("Auth", "MFA disable failed", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to disable MFA" },
      { status: 500 }
    );
  }
}
