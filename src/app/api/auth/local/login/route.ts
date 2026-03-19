import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, authLoginSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "login");
    if (rateLimited) return rateLimited;

    const { data, error } = await validateRequest(request, authLoginSchema);
    if (error) return error;
    const { username, password } = data;

    const user = await prisma.user.findUnique({
      where: { localUsername: username.trim().toLowerCase() },
    });

    if (!user || !user.passwordHash) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const session = await getSession();
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = user.sessionVersion;
    // No plexToken for local-only login
    if (user.plexToken) {
      session.plexToken = user.plexToken;
    }
    await session.save();

    apiLogger.info("Auth", `Local login: "${user.username}"`);

    return NextResponse.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "Local login failed", { error: String(error) });
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
