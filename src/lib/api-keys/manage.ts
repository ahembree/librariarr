import type { Prisma } from "@/generated/prisma/client";

/**
 * Upper bound on API keys. Keeps a stolen browser session from minting an
 * unbounded number of long-lived credentials, and keeps the settings list
 * something a person can actually audit.
 */
export const MAX_API_KEYS = 50;

/**
 * How recent a login must be to create a key on an account that has no local
 * password (Plex or SSO only). An account with a password confirms the
 * password instead. Either way, a stolen cookie alone cannot mint a key that
 * would outlive it.
 */
export const API_KEY_CREATE_REAUTH_WINDOW_MS = 15 * 60 * 1000;

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
