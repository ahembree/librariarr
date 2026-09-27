import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * API key format: `lbr_` followed by 43 base62 characters drawn from the CSPRNG
 * — 62^43 ≈ 2^256. Base62 rather than base64 so a double-click selects the
 * whole key, and a fixed prefix so secret scanners (and people) can recognise
 * one in a paste.
 *
 * Stored: the key's first 10 characters (`prefix`, shown in the list and used
 * to find the row) and a salted scrypt hash of the whole key (`keyHash`). The
 * plaintext is never stored. A key is authenticated by loading the rows with
 * its prefix and verifying the hash — never by comparing a fast digest — so a
 * database copy gives nothing to test guesses against cheaply. The guard caches
 * a successful verification in memory (see `guard.ts`), so the key derivation
 * runs once per key per process rather than on every request.
 */
export const API_KEY_PREFIX = "lbr_";

const SECRET_LENGTH = 43;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const API_KEY_PATTERN = /^lbr_[0-9A-Za-z]{43}$/;

/** A key anywhere inside a longer string (a URL, a query value). */
const API_KEY_IN_TEXT = /(?<![0-9A-Za-z])lbr_[0-9A-Za-z]{43}(?![0-9A-Za-z])/;

/** `lbr_` plus the first 6 secret characters — what the settings list shows, and the lookup. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

/**
 * scrypt with Node's default cost (N = 2^14, r = 8, p = 1: 16 MiB, tens of
 * milliseconds) and a random 16-byte salt per key. Recorded in each stored hash
 * so the cost can be raised later without invalidating existing keys.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** The largest cost a stored hash may ask for: 2^17 (128 MiB), OWASP's scrypt minimum for passwords. */
const MAX_SCRYPT_N = 131072;
const HASH_SCHEME = "scrypt";

/**
 * Uniformly random base62. A byte is accepted only below 248 (= 62 × 4), so
 * `byte % 62` gives every character the same probability; the modulo of a raw
 * byte would favour the first eight characters.
 */
function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface GeneratedApiKey {
  /** The plaintext — returned to the user once and never stored. */
  key: string;
  prefix: string;
  keyHash: string;
}

/** A fresh key's plaintext, not yet hashed. */
export function newApiKey(): string {
  return API_KEY_PREFIX + randomBase62(SECRET_LENGTH);
}

/** The part of a key that is stored in the clear and used to find its row. */
export function apiKeyLookupPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const key = newApiKey();
  return { key, prefix: apiKeyLookupPrefix(key), keyHash: await hashApiKey(key) };
}

function deriveKey(key: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      key,
      salt,
      HASH_BYTES,
      // 128·N·r bytes plus headroom; Node refuses a derivation above `maxmem`.
      { N: n, r, p, maxmem: 256 * n * r },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

/** `scrypt$N$r$p$<salt>$<hash>`, both base64url. */
export async function hashApiKey(key: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(key, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [HASH_SCHEME, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), derived.toString("base64url")].join("$");
}

/**
 * Whether `key` is the key `stored` was made from. Constant-time over the
 * derived bytes; a stored value that is not a hash this version wrote (or asks
 * for more work than it would ever ask for) verifies nothing rather than throws.
 */
export async function verifyApiKey(key: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_SCHEME) return false;
  const [n, r, p] = parts.slice(1, 4).map((v) => (/^[1-9][0-9]{0,6}$/.test(v) ? Number(v) : NaN));
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 2 || n > MAX_SCRYPT_N || (n & (n - 1)) !== 0 || r > 8 || p > 4) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length < SALT_BYTES || expected.length !== HASH_BYTES) return false;
  try {
    return timingSafeEqual(await deriveKey(key, salt, n, r, p), expected);
  } catch {
    return false;
  }
}

export function isWellFormedApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export function containsApiKey(text: string): boolean {
  return API_KEY_IN_TEXT.test(text);
}
