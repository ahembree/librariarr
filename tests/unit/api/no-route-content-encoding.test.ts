import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Since 16.4.5 Next.js drops a Route Handler's own `Content-Encoding` and
 * `Content-Length` (GHSA-pc58-hwjq-p385), and since 16.4.6 it gzips Route
 * Handler responses itself. A body compressed in the app left the server
 * gzipped twice (or, for a type Next.js does not compress, as raw gzip bytes
 * with no header), and the browser read compressed bytes as JSON.
 */
const SRC = join(process.cwd(), "src");
const SETS_ENCODING = /(?:\.(?:set|append)\(\s*["']content-encoding["']|["']content-encoding["']\s*:)/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "generated") continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("route responses", () => {
  it("never set Content-Encoding (Next.js compresses on the way out)", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => SETS_ENCODING.test(readFileSync(file, "utf8")))
      .map((file) => relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
