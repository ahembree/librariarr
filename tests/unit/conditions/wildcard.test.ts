import { describe, expect, it } from "vitest";
import { wildcardToRegex } from "@/lib/conditions/wildcard";

/** The RegExp the matcher replaced — the behaviour destructive rules were written against. */
function referenceRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regex}$`, "i");
}

/** Deterministic PRNG (mulberry32) so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("wildcardToRegex — same answers as the RegExp it replaced", () => {
  it("agrees on random patterns and values, line terminators and case folding included", () => {
    const random = prng(20261120);
    // Small alphabets so matches are common; the odd characters are the ones
    // whose case folding or `.` handling differs from the naive reading.
    const valueAlphabet = ["a", "A", "b", "B", ".", " ", "\n", "\r", " ", "ß", "ſ", "s", "S", "ı", "i", "I", "K", "k", "é", "É", "\ud83d", "\ude00"];
    const patternAlphabet = [...valueAlphabet, "*", "*", "*", "?", "?", "(", "[", "\\", "$", "^", "+", "|", "{"];
    const pick = (alphabet: string[]) => alphabet[Math.floor(random() * alphabet.length)];
    const build = (alphabet: string[], max: number) => {
      const length = Math.floor(random() * (max + 1));
      let out = "";
      for (let i = 0; i < length; i++) out += pick(alphabet);
      return out;
    };

    for (let i = 0; i < 20000; i++) {
      // At most 6 pattern characters: the reference backtracks, so keep it cheap.
      const pattern = build(patternAlphabet, 6);
      const value = build(valueAlphabet, 8);
      const expected = referenceRegex(pattern).test(value);
      const actual = wildcardToRegex(pattern).test(value);
      if (actual !== expected) {
        throw new Error(
          `pattern ${JSON.stringify(pattern)} on ${JSON.stringify(value)}: expected ${expected}, got ${actual}`,
        );
      }
    }
  });

  it("does not let * or ? cross a line break, as `.` did not", () => {
    expect(wildcardToRegex("*zombie*").test("a zombie film")).toBe(true);
    expect(wildcardToRegex("*zombie*").test("first line\na zombie film")).toBe(false);
    expect(wildcardToRegex("a?b").test("a\nb")).toBe(false);
    expect(wildcardToRegex("a\nb").test("a\nb")).toBe(true);
  });

  it("backtracks through several stars to find a match", () => {
    expect(wildcardToRegex("*a*b*c").test("xxaxxbxxabxc")).toBe(true);
    expect(wildcardToRegex("*a*b*c").test("xxaxxbxxabx")).toBe(false);
    expect(wildcardToRegex("a*b*a").test("abababa")).toBe(true);
    expect(wildcardToRegex("*ab").test("aaab")).toBe(true);
    expect(wildcardToRegex("a*?").test("a")).toBe(false);
    expect(wildcardToRegex("a*?").test("ab")).toBe(true);
  });
});

describe("wildcardToRegex — bounded cost", () => {
  // Each of these took seconds to minutes per value as a RegExp (seven stars:
  // 1.9 s for one title; every extra star multiplied it by about eight).
  const title = "The Lord of the Rings: The Fellowship of the Ring";

  it("answers a pattern of many stars at once", () => {
    const matcher = wildcardToRegex(`${"*".repeat(40)}~`);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) expect(matcher.test(title)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("answers interleaved stars against a long near-match at once", () => {
    const matcher = wildcardToRegex(`${"*a".repeat(30)}*b`);
    const value = "a".repeat(5000);
    const started = performance.now();
    expect(matcher.test(value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
