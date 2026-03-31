import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { generateTotpSecret } from "@/lib/auth/mfa";
import QRCode from "qrcode";

export async function POST() {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { localUsername: true, passwordHash: true, totpEnabled: true },
    });

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!user.passwordHash) {
      return NextResponse.json(
        { error: "MFA requires a local account with a password" },
        { status: 400 }
      );
    }

    if (user.totpEnabled) {
      return NextResponse.json(
        { error: "MFA is already enabled" },
        { status: 400 }
      );
    }

    const { secret, uri } = generateTotpSecret(user.localUsername ?? "user");
    const qrCodeDataUrl = await QRCode.toDataURL(uri);

    return NextResponse.json({ secret, uri, qrCode: qrCodeDataUrl });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate MFA setup" },
      { status: 500 }
    );
  }
}
