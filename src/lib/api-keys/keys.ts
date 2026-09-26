import { createHash, randomBytes } from "node:crypto";

/**
 * API key format: `lbr_` followed by 43 base62 characters drawn from the CSPRNG
 * — 62^43 ≈ 2^256, so guessing is not a strategy and the key needs no slow
 * hash. Base62 rather than base64 so a double-click selects the whole key, and
 * a fixed prefix so secret scanners (and people) can recognise one in a paste.
 *
 * Only `hashApiKey(key)` is stored. SHA-256 is the right tool for a
 * high-entropy random secret: bcrypt/scrypt exist to slow down guessing a
 * low-entropy password, which is not possible here, and would cost every API
 * request a deliberately slow hash.
 */
export const API_KEY_PREFIX = "lbr_";

const SECRET_LENGTH = 43;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const API_KEY_PATTERN = /^lbr_[0-9A-Za-z]{43}$/;

/** `lbr_` plus the first 6 secret characters — what the settings list shows. */
export const API_KEY_DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

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

export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBase62(SECRET_LENGTH);
  return {
    key,
    prefix: key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function isWellFormedApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}
