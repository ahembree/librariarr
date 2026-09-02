/**
 * Rename, revoke or delete a single API key.
 *
 * Session-authenticated, like the collection route next to it: an API key can
 * never manage API keys, so none of this is reachable from `/api/v1`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { Prisma, type ApiKey } from "@/generated/prisma/client";
import { forgetApiKeyTouch, serializeApiKey } from "@/lib/auth/api-key";
import { apiLogger } from "@/lib/logger";
import { validateRequest, apiKeyUpdateSchema } from "@/lib/validation";

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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.apiKey.findFirst({
    where: { id, userId: session.userId! },
    select: API_KEY_SELECT,
  });
  if (!existing) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  const { data, error } = await validateRequest(request, apiKeyUpdateSchema);
  if (error) return error;

  // Revocation is one-way — the schema accepts only the literal `true`, because
  // a revoked key may already be in the wrong hands and un-revoking would hand
  // that access back. Editing a revoked key is otherwise still allowed: a
  // rename is harmless and keeps the audit trail readable, and an expiry change
  // is inert (status stays "revoked"). Only a second revoke is rejected, since
  // it would silently move revokedAt and is never what the caller meant.
  if (data.revoked && existing.revokedAt) {
    return NextResponse.json({ error: "This API key is already revoked." }, { status: 400 });
  }

  const expiresAt =
    data.expiresAt === undefined ? undefined : data.expiresAt ? new Date(data.expiresAt) : null;
  // Same value check as minting: an expiry in the past is a mistake, and
  // revocation already exists for "kill it now".
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Expiry must be in the future." }, { status: 400 });
  }

  let updated: ApiKeyRow;
  try {
    updated = await prisma.apiKey.update({
      where: { id: existing.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(expiresAt !== undefined && { expiresAt }),
        ...(data.revoked && { revokedAt: new Date() }),
      },
      select: API_KEY_SELECT,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "An API key with that name already exists." },
        { status: 409 },
      );
    }
    throw err;
  }

  if (data.revoked) {
    // The throttle map is keyed by id and would otherwise hold an entry for a
    // key that can never authenticate again.
    forgetApiKeyTouch(existing.id);
    apiLogger.info("API Keys", `API key revoked: ${updated.name}`, { prefix: updated.prefix });
  }

  return NextResponse.json({ key: serializeRow(updated) });
}

/**
 * Hard delete.
 *
 * PATCH `{ revoked: true }` is the soft delete: the row survives, so the name,
 * prefix and lastUsedAt stay visible as an audit trail of a credential that
 * once existed. DELETE erases that record entirely — use it for a key minted by
 * mistake, not for one that may have been used.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.apiKey.findFirst({
    where: { id, userId: session.userId! },
    select: { id: true, name: true, prefix: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "API key not found" }, { status: 404 });
  }

  await prisma.apiKey.delete({ where: { id: existing.id } });
  forgetApiKeyTouch(existing.id);

  apiLogger.info("API Keys", `API key deleted: ${existing.name}`, { prefix: existing.prefix });

  return NextResponse.json({ success: true });
}
