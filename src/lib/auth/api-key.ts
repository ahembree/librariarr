/**
 * API key authentication for the public `/api/v1` surface.
 *
 * Keys are minted in the UI, shown to the admin exactly once, and never stored
 * in plaintext — only a SHA-256 digest is persisted, and that digest (not the
 * raw key) is what the auth path looks up. Two consequences worth spelling out:
 *
 * 1. A database dump contains no usable credentials.
 * 2. Authentication is a single indexed equality probe, so it stays O(1) as the
 *    key count grows and never degrades into "load every key and compare".
 *
 * SHA-256 rather than bcrypt/argon2 is deliberate. Those exist to slow down
 * dictionary attacks on human-chosen passwords; a key here is 32 bytes of
 * `randomBytes`, so there is no dictionary to grind and a slow KDF would only
 * tax every legitimate request.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import type { ApiKey, ApiKeyScope } from "@/generated/prisma/client";

/** Prefix on every issued key. Makes a leaked key greppable in logs/secret scanners. */
export const API_KEY_PREFIX = "lbr";

/** Bytes of CSPRNG entropy in the secret portion (256 bits). */
const API_KEY_ENTROPY_BYTES = 32;

/** Characters of the secret retained (with the prefix) as the non-secret display label. */
const DISPLAY_PREFIX_CHARS = 8;

/**
 * Minimum time between `lastUsedAt` writes for a single key.
 *
 * Without this, an integration polling once a second turns every request into a
 * row update. A minute of granularity is plenty for "when was this key last
 * used" and keeps a busy key at one write per minute instead of sixty.
 */
export const API_KEY_TOUCH_INTERVAL_MS = 60_000;

/** Shape returned by {@link generateApiKey}. `raw` is the only time it exists. */
export interface GeneratedApiKey {
  /** The full secret, e.g. `lbr_x7Kd...`. Shown once, then discarded. */
  raw: string;
  /** SHA-256 hex digest of `raw` — the value that goes in the database. */
  keyHash: string;
  /** Non-secret leading characters, e.g. `lbr_x7Kd9fQ2`. Safe to display/log. */
  prefix: string;
}

/**
 * Mint a new API key. The returned `raw` value is the only copy that will ever
 * exist — the caller must hand it to the user and then let it fall out of scope.
 */
export function generateApiKey(): GeneratedApiKey {
  // base64url: no `+`/`/`/`=`, so the key is safe in a header, a URL, a shell
  // argument and a YAML file without any escaping.
  const secret = randomBytes(API_KEY_ENTROPY_BYTES).toString("base64url");
  const raw = `${API_KEY_PREFIX}_${secret}`;
  return {
    raw,
    keyHash: hashApiKey(raw),
    prefix: `${API_KEY_PREFIX}_${secret.slice(0, DISPLAY_PREFIX_CHARS)}`,
  };
}

/** SHA-256 hex digest of a raw key. The stored form. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The database lookup already avoids leaking timing through comparison (Postgres
 * finds the row by index), but the presented key is re-verified against the
 * stored digest before it is trusted, and that check must not short-circuit.
 */
export function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which is itself a (harmless,
  // since digest length is fixed) early exit. Guard rather than throw.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Pull the presented key out of a request.
 *
 * Two accepted forms, both common in integration tooling:
 *   - `X-Api-Key: lbr_...`
 *   - `Authorization: Bearer lbr_...`
 *
 * `X-Api-Key` wins when both are present. A query-string key is deliberately
 * NOT supported: URLs land in access logs, browser history and `Referer`
 * headers, so accepting one would quietly undo the point of the header.
 */
export function extractApiKey(request: Request): string | null {
  const header = request.headers.get("x-api-key");
  if (header && header.trim()) return header.trim();

  const auth = request.headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }

  return null;
}

/** Why an API key was rejected. Drives the HTTP status and the client-facing message. */
export type ApiKeyFailureReason =
  | "missing"
  | "invalid"
  | "revoked"
  | "expired"
  | "insufficient_scope";

export type ApiKeyAuthResult =
  | { ok: true; apiKey: ApiKey }
  | { ok: false; reason: ApiKeyFailureReason; status: number; error: string };

const FAILURES: Record<ApiKeyFailureReason, { status: number; error: string }> = {
  missing: {
    status: 401,
    error:
      "Missing API key. Send it as an 'X-Api-Key' header or 'Authorization: Bearer <key>'.",
  },
  // "invalid" covers both "no such key" and "malformed key" on purpose — telling
  // the caller which one would confirm whether a guessed key exists.
  invalid: { status: 401, error: "Invalid API key." },
  revoked: { status: 401, error: "This API key has been revoked." },
  expired: { status: 401, error: "This API key has expired." },
  insufficient_scope: {
    status: 403,
    error: "This API key is read-only and cannot perform write operations.",
  },
};

function fail(reason: ApiKeyFailureReason): ApiKeyAuthResult {
  return { ok: false, reason, ...FAILURES[reason] };
}

/**
 * Resolve and validate the API key on a request.
 *
 * Checks, in order: presented at all → known digest → not revoked → not expired.
 * On success the key's `lastUsedAt` is refreshed (throttled, fire-and-forget).
 *
 * Scope is NOT checked here — the caller knows whether the endpoint writes.
 * See {@link requireScope}.
 */
export async function authenticateApiKey(request: Request): Promise<ApiKeyAuthResult> {
  const raw = extractApiKey(request);
  if (!raw) return fail("missing");

  const keyHash = hashApiKey(raw);
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
  // No row, or (paranoia) a row whose stored digest somehow differs from the
  // one we searched by. Both are "invalid" to the caller.
  if (!apiKey || !digestsMatch(apiKey.keyHash, keyHash)) return fail("invalid");

  if (apiKey.revokedAt) return fail("revoked");
  if (isExpired(apiKey)) return fail("expired");

  touchLastUsed(apiKey);

  return { ok: true, apiKey };
}

/** True when the key carries an expiry that has already passed. */
export function isExpired(apiKey: Pick<ApiKey, "expiresAt">, now = new Date()): boolean {
  return apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now.getTime();
}

/**
 * Enforce that a key may perform a write.
 *
 * Read endpoints accept either scope; write endpoints require `READ_WRITE`.
 */
export function requireScope(
  apiKey: Pick<ApiKey, "scope">,
  needed: ApiKeyScope,
): ApiKeyAuthResult | null {
  if (needed === "READ_WRITE" && apiKey.scope !== "READ_WRITE") {
    return fail("insufficient_scope");
  }
  return null;
}

/**
 * Refresh `lastUsedAt`, at most once per {@link API_KEY_TOUCH_INTERVAL_MS} per key.
 *
 * Deliberately fire-and-forget: a failed bookkeeping write must never turn a
 * successfully authenticated request into an error. The throttle map is
 * in-process — a restart just means one extra write, and there is only ever one
 * app process (the worker runs in-process too), so no coordination is needed.
 */
function touchLastUsed(apiKey: ApiKey): void {
  const now = Date.now();
  const last = apiKey.lastUsedAt?.getTime() ?? 0;
  const lastLocal = touchedAt.get(apiKey.id) ?? 0;
  if (now - Math.max(last, lastLocal) < API_KEY_TOUCH_INTERVAL_MS) return;

  touchedAt.set(apiKey.id, now);
  void prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date(now) } })
    .catch(() => {
      // Roll the local stamp back so the next request retries the write rather
      // than suppressing it for a whole interval on a transient DB blip.
      touchedAt.delete(apiKey.id);
    });
}

/** id → epoch ms of the last `lastUsedAt` write we issued. Bounds DB write rate. */
const touchedAt = new Map<string, number>();

/** Drop throttle entries for keys that no longer exist (called on revoke/delete). */
export function forgetApiKeyTouch(id: string): void {
  touchedAt.delete(id);
}

/** Test seam: reset the in-process throttle state. */
export function resetApiKeyTouchState(): void {
  touchedAt.clear();
}

/** Lifecycle state of a key, derived from its timestamps. */
export type ApiKeyStatus = "active" | "revoked" | "expired";

export function apiKeyStatus(
  apiKey: Pick<ApiKey, "revokedAt" | "expiresAt">,
  now = new Date(),
): ApiKeyStatus {
  // Revocation is deliberate and wins over expiry in the display, so a key an
  // admin revoked never reads as merely "expired".
  if (apiKey.revokedAt) return "revoked";
  if (isExpired(apiKey, now)) return "expired";
  return "active";
}

/**
 * Shape an ApiKey row for a client response.
 *
 * `keyHash` is dropped rather than masked — the client has no use for it, and
 * not sending it at all is one fewer thing to get wrong. The raw key is not
 * present in the row to begin with.
 */
export function serializeApiKey(apiKey: ApiKey, now = new Date()) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    scope: apiKey.scope,
    status: apiKeyStatus(apiKey, now),
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt.toISOString(),
  };
}

export type SerializedApiKey = ReturnType<typeof serializeApiKey>;
