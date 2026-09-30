import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { validateRequest, apiKeyCreateSchema } from "@/lib/validation";
import { generateApiKey } from "@/lib/api-keys/keys";
import { API_KEY_PUBLIC_SELECT, MAX_API_KEYS } from "@/lib/api-keys/manage";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";
import { notifyApiKeyChange } from "@/lib/api-keys/notify";
import { normalizeScopes } from "@/lib/api-keys/scopes";
import { isPasswordSignInEnabled } from "@/lib/auth/password-sign-in";
import {
  PASSWORD_CONFIRM_BUCKET,
  peekAuthRateLimit,
  refundAuthAttempt,
  reserveAuthAttempt,
} from "@/lib/rate-limit/rate-limiter";

/**
 * API key management for the settings page — cookie session only. These routes
 * are not under `/api/v1`, so an API key can never list, mint or delete keys.
 *
 * Creating a key is a step up from being signed in. A key outlives the cookie
 * session that mints it — logging out or changing the password revokes
 * sessions, not keys — so a stolen cookie could otherwise turn a temporary
 * foothold into a permanent one in one request. The step-up is the account's
 * password where it has one and password sign-in is on, and otherwise (Plex
 * or SSO only, or password sign-in turned off) a login made in
 * the last `RECENT_LOGIN_WINDOW_MS` (`src/lib/auth/recent-login.ts`, which
 * also guards setting a first password and linking a Plex account or an SSO
 * identity, the other ways a cookie could make itself last) — which the
 * dialog renews in place through `/api/auth/reauth/*`; either way the
 * creation is also announced on Discord where a webhook is set.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKeys = await prisma.apiKey.findMany({
    where: { userId: session.userId! },
    select: API_KEY_PUBLIC_SELECT,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ apiKeys }, { headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, apiKeyCreateSchema);
  if (error) return error;

  const user = await prisma.user.findUnique({
    where: { id: session.userId! },
    select: { passwordHash: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The password is the step-up only while password sign-in is on. With it
  // off the password is accepted for nothing (password-sign-in.ts), so the
  // account is treated as having none: a recent sign-in by another method,
  // and a `currentPassword` in the body is never compared.
  if (user.passwordHash && (await isPasswordSignInEnabled())) {
    // Charged only on a wrong password (a routine that creates ten keys in a
    // row must not lock itself out), but a wrong one costs what a failed
    // login does, so this route is not a cheaper password oracle than login.
    const limited = peekAuthRateLimit(request, PASSWORD_CONFIRM_BUCKET);
    if (limited) return limited;
    if (!data.currentPassword) {
      return NextResponse.json(
        { error: "Enter your current password to create an API key", code: "password_required" },
        { status: 400 },
      );
    }
    // Charged before the compare, refunded on a match: concurrent guesses
    // each count from the moment they start (see `reserveAuthAttempt`).
    const reserved = reserveAuthAttempt(request, PASSWORD_CONFIRM_BUCKET);
    if (reserved) return reserved;
    const valid = await bcrypt.compare(data.currentPassword, user.passwordHash);
    if (!valid) {
      logger.warn("Auth", "API key creation refused — the current password was incorrect");
      return NextResponse.json(
        { error: "Current password is incorrect", code: "password_incorrect" },
        { status: 403 },
      );
    }
    refundAuthAttempt(request, PASSWORD_CONFIRM_BUCKET);
  } else if (!hasRecentLogin(session)) {
    // Names the ways to confirm the identity in place (Plex, SSO — never the
    // password while password sign-in is off), which the settings dialog
    // offers instead of making the user sign out and back in.
    return reauthRequired(session.userId!, "Creating an API key");
  }

  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "The expiration date must be in the future" },
      { status: 400 },
    );
  }

  const scopes = normalizeScopes(data.scopes);
  // Hashed (scrypt, tens of milliseconds) before the lock below is taken.
  const { key, prefix, keyHash } = await generateApiKey();

  // Counted and inserted under one lock, or concurrent requests each pass the
  // count and together create more than MAX_API_KEYS.
  let apiKey;
  try {
    apiKey = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext('api-key-create:' || $1))`,
        session.userId!,
      );
      const existing = await tx.apiKey.count({ where: { userId: session.userId! } });
      if (existing >= MAX_API_KEYS) return null;
      return tx.apiKey.create({
        data: { userId: session.userId!, name: data.name, prefix, keyHash, scopes, expiresAt },
        select: API_KEY_PUBLIC_SELECT,
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "An API key with this name already exists" },
        { status: 409 },
      );
    }
    throw err;
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: `You can have at most ${MAX_API_KEYS} API keys. Delete one you no longer use first.` },
      { status: 400 },
    );
  }

  logger.info(
    "Auth",
    `API key "${apiKey.name}" (${apiKey.prefix}…) created — scopes: ${scopes.join(", ")}; expires: ${expiresAt ? expiresAt.toISOString() : "never"}`,
  );
  void notifyApiKeyChange(session.userId!, "created", apiKey);

  // The only time the plaintext key ever leaves the server. Only its hash was
  // stored, so it cannot be shown again; `no-store` keeps it out of caches.
  return NextResponse.json({ apiKey, key }, { status: 201, headers: NO_STORE });
}
