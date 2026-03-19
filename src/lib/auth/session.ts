import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

export interface SessionData {
  userId?: string;
  plexToken?: string;
  isLoggedIn: boolean;
  sessionVersion?: number;
}

// Lazy-initialised so the module can be imported at build time (next build's
// "Collecting page data" phase) without requiring SESSION_SECRET to exist.
let _sessionOptions: SessionOptions | null = null;

function getSessionOptions(): SessionOptions {
  if (!_sessionOptions) {
    const sessionSecret = process.env.SESSION_SECRET;
    if (!sessionSecret || sessionSecret.length < 32) {
      throw new Error(
        "SESSION_SECRET must be set and at least 32 characters long. " +
          "Generate one with: openssl rand -hex 32"
      );
    }
    _sessionOptions = {
      password: sessionSecret,
      cookieName: "librariarr_session",
      cookieOptions: {
        secure: process.env.COOKIE_SECURE === "true",
        httpOnly: true,
        sameSite: "lax" as const,
        maxAge: 60 * 60 * 24 * 30, // 30 days
      },
    };
  }
  return _sessionOptions;
}

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, getSessionOptions());
}

/**
 * Check if the session's userId still exists in the database.
 * Returns false if the user is gone (e.g. database was recreated)
 * or the database is unreachable.
 */
export async function isSessionValid(): Promise<boolean> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) return false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, sessionVersion: true },
    });
    if (!user) return false;
    // Version mismatch = session was invalidated (e.g. password change)
    if (session.sessionVersion !== undefined && session.sessionVersion !== user.sessionVersion) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
