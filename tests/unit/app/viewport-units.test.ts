import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** Every `file:line` whose source matches `pattern`. */
function occurrences(pattern: RegExp): string[] {
  return sourceFiles(SRC).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${path.relative(process.cwd(), file)}:${i + 1}`] : [])),
  );
}

describe("viewport-height units", () => {
  // A phone browser's 100vh is its height with the toolbars hidden. While
  // they show, a frame sized `h-screen` runs behind them — the bottom of
  // every page sat under Safari's and Chrome's toolbars and the whole frame
  // scrolled as a second layer — and a dialog or sheet capped in vh can be
  // taller than the screen, which put the filter sheet's drag handle off the
  // top. dvh tracks the visible height.
  it("never sizes a frame with h-screen", () => {
    expect(occurrences(/(^|[\s"'`])h-screen(?=[\s"'`]|$)/)).toEqual([]);
  });

  it("never caps a height in vh", () => {
    expect(occurrences(/max-h-\[[^\]]*(?<![dls])vh/)).toEqual([]);
  });

  // `min-h-screen` is `min-height: 100vh` — the same toolbar overrun as
  // h-screen on a full-page frame (login, onboarding, the detail hero) — and
  // an arbitrary `h-[55vh]` / `min-h-[50vh]` sizes against the hidden-toolbar
  // height the same way.
  it("never sizes a minimum height with min-h-screen", () => {
    expect(occurrences(/(^|[\s"'`])min-h-screen(?=[\s"'`]|$)/)).toEqual([]);
  });

  it("never sizes a height in vh", () => {
    expect(occurrences(/(^|[\s"'`:])(min-|max-)?h-\[[^\]]*(?<![dls])vh\]/)).toEqual([]);
  });
});
