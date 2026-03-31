import * as OTPAuth from "otpauth";
import { randomBytes } from "crypto";

const ISSUER = "Librariarr";
const RECOVERY_CODE_COUNT = 8;

/**
 * Generate a new TOTP secret and return the secret + provisioning URI.
 */
export function generateTotpSecret(username: string) {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Verify a TOTP token against a secret.
 * Allows a 1-period window in each direction for clock drift.
 */
export function verifyTotpToken(secret: string, token: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: ISSUER,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

/**
 * Generate a set of recovery codes.
 * Each code is a 10-character alphanumeric string formatted as XXXXX-XXXXX.
 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = randomBytes(5);
    const raw = bytes.toString("hex").toUpperCase().slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
