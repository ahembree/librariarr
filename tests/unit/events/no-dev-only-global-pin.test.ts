import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// In a production build the job worker and the realtime manager (started from
// instrumentation) load their own copy of every module, and the route handlers
// load another. A singleton pinned to globalThis only outside production — the
// usual HMR idiom — is therefore one object in development and in tests, and
// two in production: the event bus was, and nothing the worker or the manager
// emitted ever reached the browser, while every dev and test run passed. Pin
// unconditionally (`globalForX.x ??= new X()`). The process-singletons test
// checks the known registries behave; this one refuses the pattern anywhere.

const SRC = path.join(process.cwd(), "src");

// A duplicate here is harmless, and each entry says why.
const ALLOWED: Record<string, string> = {
  // A second PrismaClient in the worker's bundle is a second connection pool,
  // not split state: both read and write the same database.
  "src/lib/db.ts": "PrismaClient — a duplicate costs a pool, not correctness",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const DEV_ONLY = /process\.env\.NODE_ENV\s*!==?\s*["']production["']|process\.env\.NODE_ENV\s*===?\s*["']development["']/;
const GLOBAL_WRITE = /\bglobal(This|For\w*)?\b[^=]*[^=!<>]=(?!=)/;

/** Every `file:line` where a development-only condition guards a write to a global. */
function devOnlyPins(): string[] {
  return sourceFiles(SRC).flatMap((file) => {
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.flatMap((line, i) => {
      if (!DEV_ONLY.test(line)) return [];
      // The guarded statement: the same line, or the block it opens.
      const guarded = lines.slice(i, i + 4).join("\n");
      return GLOBAL_WRITE.test(guarded) ? [`${path.relative(process.cwd(), file)}:${i + 1}`] : [];
    });
  });
}

describe("globalThis singletons", () => {
  it("are never pinned only outside production", () => {
    const found = devOnlyPins().filter((at) => !(at.split(":")[0] in ALLOWED));
    expect(found).toEqual([]);
  });

  it("every allowed exception still exists", () => {
    const files = new Set(devOnlyPins().map((at) => at.split(":")[0]));
    expect(Object.keys(ALLOWED).filter((file) => !files.has(file))).toEqual([]);
  });

  it("the check catches the pattern it is for", () => {
    const sample = [
      'if (process.env.NODE_ENV !== "production") globalForBus.bus = bus;',
      'if (process.env.NODE_ENV !== "production") {\n  globalThis.__x = x;\n}',
    ];
    for (const text of sample) {
      const lines = text.split("\n");
      expect(DEV_ONLY.test(lines[0])).toBe(true);
      expect(GLOBAL_WRITE.test(lines.join("\n"))).toBe(true);
    }
    expect(GLOBAL_WRITE.test('if (process.env.NODE_ENV !== "production") console.log(globalThis === x);')).toBe(false);
  });
});
