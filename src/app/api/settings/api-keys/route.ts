import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { validateRequest, apiKeyCreateSchema } from "@/lib/validation";
import { generateApiKey } from "@/lib/api-keys/keys";
import { API_KEY_PUBLIC_SELECT, MAX_API_KEYS } from "@/lib/api-keys/manage";
import { normalizeScopes } from "@/lib/api-keys/scopes";

/**
 * API key management for the settings page — cookie session only. These routes
 * are not under `/api/v1`, so an API key can never list, mint or delete keys.
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

  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "The expiration date must be in the future" },
      { status: 400 },
    );
  }

  const existing = await prisma.apiKey.count({ where: { userId: session.userId! } });
  if (existing >= MAX_API_KEYS) {
    return NextResponse.json(
      { error: `You can have at most ${MAX_API_KEYS} API keys. Delete one you no longer use first.` },
      { status: 400 },
    );
  }

  const scopes = normalizeScopes(data.scopes);
  const { key, prefix, keyHash } = generateApiKey();

  let apiKey;
  try {
    apiKey = await prisma.apiKey.create({
      data: { userId: session.userId!, name: data.name, prefix, keyHash, scopes, expiresAt },
      select: API_KEY_PUBLIC_SELECT,
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

  logger.info(
    "Auth",
    `API key "${apiKey.name}" (${apiKey.prefix}…) created — scopes: ${scopes.join(", ")}; expires: ${expiresAt ? expiresAt.toISOString() : "never"}`,
  );

  // The only time the plaintext key ever leaves the server. Only its hash was
  // stored, so it cannot be shown again; `no-store` keeps it out of caches.
  return NextResponse.json({ apiKey, key }, { status: 201, headers: NO_STORE });
}
