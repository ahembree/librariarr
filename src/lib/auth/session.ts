import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface SessionData {
  userId?: string;
  plexToken?: string;
  isLoggedIn: boolean;
  sessionVersion?: number;
}

const SESSION_SECRET_FILE = "/config/.session-secret";

/**
 * Resolve the session secret from (in priority order):
 * 1. SESSION_SECRET environment variable
 * 2. Persisted auto-generated secret at /config/.session-secret
 * 3. Newly generated secret (persisted for future restarts)
 */
function resolveSessionSecret(): string {
  // 1. Explicit env var takes priority
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) {
    return envSecret;
  }

  if (envSecret && envSecret.length > 0 && envSecret.length < 32) {
    throw new Error(
      "SESSION_SECRET is set but must be at least 32 characters long. " +
        "Generate one with: openssl rand -hex 32"
    );
  }

  // 2. Check for previously auto-generated secret
  try {
    if (existsSync(SESSION_SECRET_FILE)) {
      const stored = readFileSync(SESSION_SECRET_FILE, "utf-8").trim();
      if (stored.length >= 32) {
        logger.info(
          "Using auto-generated session secret from %s",
          SESSION_SECRET_FILE
        );
        return stored;
      }
    }
  } catch {
    // File unreadable — fall through to generate a new one
  }

  // 3. Generate and persist a new secret
  const generated = randomBytes(32).toString("hex"); // 64-char hex string
  try {
    mkdirSync(dirname(SESSION_SECRET_FILE), { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, generated + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    logger.info(
      "No SESSION_SECRET configured — auto-generated and saved to %s",
      SESSION_SECRET_FILE
    );
  } catch (err) {
    // Persist failed (e.g. read-only filesystem) — use the generated value
    // for this process lifetime but warn that sessions won't survive restarts
    logger.warn(
      "Auto-generated SESSION_SECRET but could not persist to %s — " +
        "sessions will be invalidated on restart. " +
        "Set SESSION_SECRET in your environment to avoid this. Error: %s",
      SESSION_SECRET_FILE,
      err instanceof Error ? err.message : String(err)
    );
  }

  return generated;
}

// Lazy-initialised so the module can be imported at build time (next build's
// "Collecting page data" phase) without requiring SESSION_SECRET to exist.
let _sessionOptions: SessionOptions | null = null;

function getSessionOptions(): SessionOptions {
  if (!_sessionOptions) {
    const sessionSecret = resolveSessionSecret();
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
