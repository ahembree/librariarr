import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * TanStack Virtual writes `initialOffset` (default 0) to its scroll element
 * when it first attaches. The tables and poster grids scroll the shell's
 * shared `<main>`, so a list mounting while the page is scrolled — the first
 * Run Query or Preview, a list coming back after a re-read — threw the page to
 * the top. Every virtualizer starts from where its element already is.
 */
describe("useVirtualizer calls", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  /** The options object of each `useVirtualizer({ … })` call in `source`. */
  function virtualizerOptions(source: string): string[] {
    const calls: string[] = [];
    const re = /useVirtualizer\(\{/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      let depth = 1;
      let i = match.index + match[0].length;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
      }
      calls.push(source.slice(match.index, i));
    }
    return calls;
  }

  const calls = sourceFiles(SRC).flatMap((path) =>
    virtualizerOptions(readFileSync(path, "utf8")).map((options) => ({
      file: relative(process.cwd(), path),
      options,
    })),
  );

  it("finds the virtualizers", () => {
    // The tables, the poster grids, Matches and Pending.
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("every one starts from its scroll element's current offset", () => {
    const offenders = calls
      .filter(({ options }) => !/initialOffset:\s*\(\)\s*=>\s*\w+\.current\?\.scrollTop\s*\?\?\s*0/.test(options))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
