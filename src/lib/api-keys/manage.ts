import type { Prisma } from "@/generated/prisma/client";

/**
 * Upper bound on API keys. Keeps a stolen browser session from minting an
 * unbounded number of long-lived credentials, and keeps the settings list
 * something a person can actually audit.
 */
export const MAX_API_KEYS = 50;

/**
 * Every field of a key that may leave the server. `keyHash` is not here and
 * must never be: it is the lookup value, and returning it would let anyone who
 * can read the list confirm a guessed key offline.
 */
export const API_KEY_PUBLIC_SELECT = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  lastUsedIp: true,
  createdAt: true,
} satisfies Prisma.ApiKeySelect;
