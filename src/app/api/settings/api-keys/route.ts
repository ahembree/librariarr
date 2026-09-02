/**
 * API key management for the web UI.
 *
 * Session-authenticated on purpose: these routes are NOT part of `/api/v1` and
 * never go through `withApiKey`. An API key that could mint, list or revoke
 * keys would let a leaked key issue itself a replacement and outlive the
 * revocation, so key management is reachable only from a logged-in browser
 * session.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma, type ApiKey } from "@/generated/prisma/client";
import { generateApiKey, serializeApiKey } from "@/lib/auth/api-key";
import { apiLogger } from "@/lib/logger";
import { validateRequest, apiKeyCreateSchema } from "@/lib/validation";

/** Every column except `keyHash` — the stored digest never leaves Postgres. */
const API_KEY_SELECT = {
  id: true,
  userId: true,
  name: true,
  prefix: true,
  scope: true,
  expiresAt: true,
  revokedAt: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ApiKeySelect;

type ApiKeyRow = Prisma.ApiKeyGetPayload<{ select: typeof API_KEY_SELECT }>;

/** `serializeApiKey` is typed against the full row but reads no secret column. */
function serializeRow(row: ApiKeyRow) {
  return serializeApiKey(row as ApiKey);
}

export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const keys = await prisma.apiKey.findMany({
    where: { userId: session.userId! },
    select: API_KEY_SELECT,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ keys: keys.map(serializeRow) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, apiKeyCreateSchema);
  if (error) return error;

  // The schema only checks the timestamp's shape. A key that is born expired
  // authenticates nothing and is always a mistake, so reject it here.
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Expiry must be in the future." }, { status: 400 });
  }

  const { raw, keyHash, prefix } = generateApiKey();

  let created: ApiKeyRow;
  try {
    created = await prisma.apiKey.create({
      data: {
        userId: session.userId!,
        name: data.name,
        keyHash,
        prefix,
        scope: data.scope,
        expiresAt,
      },
      select: API_KEY_SELECT,
    });
  } catch (err) {
    // The (userId, name) unique index is the authority. A read-then-insert
    // pre-check would be a TOCTOU race between two concurrent mints, so the
    // constraint violation is what turns into the 409.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "An API key with that name already exists." },
        { status: 409 },
      );
    }
    throw err;
  }

  // Name and prefix only — the raw secret must never reach the log table.
  apiLogger.info("API Keys", `API key created: ${created.name}`, {
    prefix: created.prefix,
    scope: created.scope,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // `secret` below is the ONE AND ONLY time the raw key exists in a response
  // body. Only its SHA-256 digest is persisted, so it is not recoverable
  // afterwards: no later request can re-display it, and a lost key can only be
  // deleted and replaced.
  // ─────────────────────────────────────────────────────────────────────────
  return NextResponse.json({ key: serializeRow(created), secret: raw }, { status: 201 });
}
