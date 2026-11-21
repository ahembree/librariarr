/**
 * Glob-style matching for the wildcard operators (`*` = any run of characters,
 * `?` = exactly one), case-insensitive and anchored at both ends.
 *
 * It used to compile the pattern to a RegExp (`*` → `.*`). Every `*` is then a
 * backtracking point, so a pattern with a handful of them — `*******~`, or
 * `*a*a*a*a*b` — costs time exponential in their number against a value that
 * almost matches, and the match runs synchronously on the event loop once per
 * library item: seven stars took 1.9 s for ONE 49-character title. The value
 * is a rule's, and the AI assistant's `search_media` tool passes one a model
 * chose, so text a media server controls could ask for it.
 *
 * This matcher backtracks to the most recent `*` only, which is enough for a
 * glob (an earlier `*` taking more never helps once the literal run after it
 * has matched at its leftmost position), so the cost is bounded by
 * `pattern.length × value.length` whatever the pattern.
 *
 * It answers exactly as the RegExp did, because destructive rules are written
 * against that behaviour (`tests/unit/conditions/wildcard.test.ts` compares the
 * two on random input):
 *  - neither `*` nor `?` matches a line terminator, as `.` does not;
 *  - `?` is one UTF-16 code unit;
 *  - case folds as the `i` flag does without `u`: one code unit to its
 *    upper-case form, unless that is longer than one unit or maps a non-ASCII
 *    character onto an ASCII one.
 */
export interface WildcardMatcher {
  test(value: string): boolean;
}

const STAR = -1;
const ANY = -2;

function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/** The `i` flag's canonical form of one code unit (ECMA-262 Canonicalize, non-Unicode mode). */
function canonicalize(code: number): number {
  // ASCII fast path: every value Phase 2 sees is overwhelmingly ASCII.
  if (code < 0x80) return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  const upper = String.fromCharCode(code).toUpperCase();
  if (upper.length !== 1) return code;
  const upperCode = upper.charCodeAt(0);
  return upperCode < 0x80 ? code : upperCode;
}

/** Convert a glob-style wildcard pattern (* = any chars, ? = single char) to a matcher. */
export function wildcardToRegex(pattern: string): WildcardMatcher {
  // Tokens: a canonical code unit, STAR or ANY. Consecutive stars are one.
  const tokens: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charCodeAt(i);
    if (ch === 0x2a /* * */) {
      if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
    } else if (ch === 0x3f /* ? */) {
      tokens.push(ANY);
    } else {
      tokens.push(canonicalize(ch));
    }
  }
  const tokenCount = tokens.length;

  return {
    test(value: string): boolean {
      const length = value.length;
      let v = 0;
      let t = 0;
      // The most recent star, and how far into the value it has reached.
      let starToken = -1;
      let starValue = 0;

      while (v < length) {
        const token = t < tokenCount ? tokens[t] : undefined;
        if (token === STAR) {
          starToken = t;
          starValue = v;
          t++;
          continue;
        }
        if (token !== undefined) {
          const code = value.charCodeAt(v);
          const matches = token === ANY ? !isLineTerminator(code) : canonicalize(code) === token;
          if (matches) {
            v++;
            t++;
            continue;
          }
        }
        // Mismatch (or the pattern ran out): let the last star take one more
        // character and retry what follows it — unless that character is one
        // a star cannot take.
        if (starToken === -1 || isLineTerminator(value.charCodeAt(starValue))) return false;
        starValue++;
        v = starValue;
        t = starToken + 1;
      }

      // The value is used up; only a trailing star may remain.
      while (t < tokenCount && tokens[t] === STAR) t++;
      return t === tokenCount;
    },
  };
}
