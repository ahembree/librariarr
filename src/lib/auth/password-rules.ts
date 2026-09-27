/**
 * Length rules for a new login password, shared by the setup and
 * change-password schemas and the forms that submit to them (client-safe: no
 * Node imports).
 *
 * bcrypt reads only the first 72 bytes of a password and ignores the rest, so
 * a longer one would be accepted and then silently shortened: any two
 * passwords sharing their first 72 bytes would both unlock the account. A
 * password over the limit is refused instead. The limit counts UTF-8 bytes,
 * the unit bcrypt truncates in, so accented letters and emoji count as more
 * than one each. Login itself takes any length, so a password set before the
 * limit existed still signs in.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72;

export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const PASSWORD_TOO_LONG_MESSAGE =
  `Password must be at most ${MAX_PASSWORD_BYTES} bytes: ${MAX_PASSWORD_BYTES} plain letters, fewer with accents or emoji`;

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** The first rule a new password breaks, or null when it is acceptable. */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_TOO_SHORT_MESSAGE;
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) return PASSWORD_TOO_LONG_MESSAGE;
  return null;
}
