import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

const AUTHENTICATED = path.join(process.cwd(), "src/app/(authenticated)");

function loadingFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return loadingFiles(full);
    return /^loading\.(tsx|ts|jsx|js)$/.test(entry.name) ? [path.relative(process.cwd(), full)] : [];
  });
}

describe("authenticated routes", () => {
  // Every page under (authenticated) renders its own skeleton while its data
  // loads. A route-level loading fallback would only show during navigation,
  // and React then holds the page back for its 300 ms Suspense reveal
  // throttle — every sidebar click took at least that long.
  it("have no route-level loading.tsx", () => {
    expect(loadingFiles(AUTHENTICATED)).toEqual([]);
  });
});
