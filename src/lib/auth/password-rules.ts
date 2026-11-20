/**
 * The rules for a new login password, shared by the setup and
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

export const PASSWORD_TOO_GUESSABLE_MESSAGE =
  "That password is too easy to guess: a common password, a simple sequence, or a word followed by numbers. Choose something longer or less predictable";

/**
 * Passwords at the top of every guessing list that are long enough to pass the
 * length rule (compared in lower case).
 */
const COMMON_PASSWORDS = new Set([
  "password", "passw0rd", "password1", "password12", "password123", "password1234", "password!",
  "qwertyuiop", "qwertyui", "qwerty123", "qwerty1234", "qwertyuio", "asdfghjkl", "asdfghjk", "zxcvbnm123",
  "1qaz2wsx", "1qaz2wsx3edc", "qazwsxedc", "1q2w3e4r", "1q2w3e4r5t", "q1w2e3r4", "zaq12wsx", "1qazxsw2",
  "iloveyou", "iloveyou1", "sunshine", "princess", "football", "baseball", "superman", "trustno1",
  "starwars", "whatever", "computer", "michelle", "jennifer", "corvette", "mercedes", "maverick",
  "letmein1", "letmein123", "welcome1", "welcome123", "admin123", "admin1234", "administrator",
  "changeme", "changeme1", "default1", "abcd1234", "abc12345", "a1b2c3d4", "1234qwer", "qwer1234",
  "passpass", "password2", "monkey123", "dragon123", "master123", "shadow123", "michael1", "internet",
  "11111111", "00000000", "12341234", "12121212", "11223344", "aaaaaaaa", "asdfasdf", "qweqweqwe",
  "asdf1234", "zxcvbnm1", "1234abcd", "pass1234", "test1234", "testtest", "guest123", "root1234",
  "librariarr", "plexpass", "jellyfin", "sonarr123", "radarr123",
]);

/**
 * Words that, alone or dressed up with trailing digits and punctuation
 * (`Welcome2024!`, `plex1234`, `P@ssw0rd1`), are what a guessing run tries
 * first.
 */
const GUESSABLE_BASE_WORDS = new Set([
  "password", "passwort", "pass", "qwerty", "azerty", "letmein", "welcome", "admin", "administrator",
  "iloveyou", "dragon", "monkey", "football", "baseball", "master", "sunshine", "princess", "shadow",
  "superman", "batman", "login", "starwars", "trustno", "changeme", "default", "secret", "test",
  "testing", "guest", "root", "toor", "user", "hello", "freedom", "whatever", "computer", "internet",
  "access", "abc", "abcd", "summer", "winter", "spring", "autumn", "librariarr", "plex", "plexpass",
  "jellyfin", "emby", "sonarr", "radarr", "lidarr", "media", "server", "homelab",
]);

/** The letters the usual substitutions stand for (`p@ssw0rd` → `password`). */
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/** Every character one step up (or down) from the one before: `12345678`, `hgfedcba`. */
function isStraightRun(value: string): boolean {
  if (value.length < 2) return false;
  const step = value.charCodeAt(1) - value.charCodeAt(0);
  if (step !== 1 && step !== -1) return false;
  for (let i = 2; i < value.length; i++) {
    if (value.charCodeAt(i) - value.charCodeAt(i - 1) !== step) return false;
  }
  return true;
}

/**
 * Whether a password is one a guessing run reaches in its first few thousand
 * tries. The login limiter allows a few thousand guesses a day against the one
 * admin account (the address it buckets by can be a header the client wrote),
 * so length alone is not enough: `password123` and `12345678` are both "at
 * least 8 characters". Deliberately narrow — exact common passwords, straight
 * runs, fewer than four different characters, and a common word that is the
 * WHOLE password apart from trailing digits and punctuation — so an ordinary
 * passphrase is never refused. Applies to a password being set; login accepts
 * whatever was set before.
 */
export function isGuessablePassword(password: string): boolean {
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;
  if (new Set(lower).size < 4) return true;
  if (isStraightRun(lower) || lower === "1234567890" || lower === "0123456789" || lower === "0987654321") {
    return true;
  }
  // A common word with digits and punctuation around it.
  const base = lower.replace(/[\d\W_]+$/, "").replace(/^[\d\W_]+/, "");
  if (base && GUESSABLE_BASE_WORDS.has(base)) return true;
  // The same word in the usual substitutions; `1` stands for `l` or for `i`.
  const dressed = lower.replace(/[\d\W_]+$/, "");
  const unleet = (one: string) => Array.from(dressed, (ch) => (ch === "1" ? one : (LEET[ch] ?? ch))).join("");
  return GUESSABLE_BASE_WORDS.has(unleet("l")) || GUESSABLE_BASE_WORDS.has(unleet("i"));
}

/** The first rule a new password breaks, or null when it is acceptable. */
export function newPasswordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_TOO_SHORT_MESSAGE;
  if (passwordByteLength(password) > MAX_PASSWORD_BYTES) return PASSWORD_TOO_LONG_MESSAGE;
  if (isGuessablePassword(password)) return PASSWORD_TOO_GUESSABLE_MESSAGE;
  return null;
}
