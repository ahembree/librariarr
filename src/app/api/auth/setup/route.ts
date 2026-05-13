import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, authSetupSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  try {
    // Validate input outside the transaction so a bad payload doesn't even
    // hit the DB (bcrypt is expensive — do it before the lock too).
    const { data, error } = await validateRequest(request, authSetupSchema);
    if (error) return error;
    const { username, password } = data;

    // Cheap up-front guard for the common case (already set up). The
    // authoritative check is inside the Serializable transaction below — two
    // concurrent setup requests must not both succeed.
    const initialCount = await prisma.user.count();
    if (initialCount > 0) {
      return NextResponse.json(
        { error: "Setup has already been completed" },
        { status: 403 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Atomically create the first user + their AppSettings + mark setup
    // complete. PostgreSQL SSI catches the race where two concurrent setup
    // requests both pass the initialCount guard above and both try to create
    // an admin — the loser sees a serialization error (500) and can retry.
    const user = await prisma.$transaction(
      async (tx) => {
        const inner = await tx.user.count();
        if (inner > 0) return null;
        const created = await tx.user.create({
          data: {
            localUsername: username.trim().toLowerCase(),
            passwordHash,
            username: username.trim(),
          },
        });
        await tx.appSettings.create({
          data: { userId: created.id, localAuthEnabled: true },
        });
        await tx.systemConfig.upsert({
          where: { id: "singleton" },
          update: { setupCompleted: true },
          create: {
            id: "singleton",
            plexClientId: crypto.randomUUID(),
            setupCompleted: true,
          },
        });
        return created;
      },
      { isolationLevel: "Serializable" }
    );

    if (!user) {
      return NextResponse.json(
        { error: "Setup has already been completed" },
        { status: 403 }
      );
    }

    // Set session (destroy first to clear any stale data like a prior plexToken)
    const session = await getSession();
    session.destroy();
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = 0;
    await session.save();

    apiLogger.info("Auth", `Setup completed: local user "${username}" created`);

    return NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "Setup failed", { error: String(error) });
    return NextResponse.json(
      { error: "Setup failed" },
      { status: 500 }
    );
  }
}
