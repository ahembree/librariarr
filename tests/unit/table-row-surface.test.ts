import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { rowSurfaceClass, ROW_TONE_LABELS, type RowTone } from "@/lib/table-row-surface";

const classes = (s: string) => s.split(/\s+/).filter(Boolean);

describe("rowSurfaceClass", () => {
  it("stripes by the row's index in the list, never by :nth-child", () => {
    for (let index = 0; index < 6; index++) {
      const list = classes(rowSurfaceClass({ index }));
      expect(list.includes("bg-white/1.5")).toBe(index % 2 === 1);
      expect(list.some((c) => c.startsWith("even:") || c.startsWith("odd:"))).toBe(false);
    }
  });

  it("gives an interactive plain row the pointer and hover feedback, and a static one neither", () => {
    expect(classes(rowSurfaceClass({ index: 0, interactive: true }))).toEqual(
      expect.arrayContaining(["cursor-pointer", "hover:bg-white/3", "hover:ring-1", "hover:ring-primary/20"]),
    );
    const plain = classes(rowSurfaceClass({ index: 0 }));
    expect(plain.some((c) => c.startsWith("hover:") || c === "cursor-pointer")).toBe(false);
  });

  // A `hover:`/`even:` background or ring colour outranks the tone's plain
  // class, so either one on a toned row hides its fill — every other row of a
  // run of additions lost it to the stripe, and the pointed-at row to hover.
  it.each<[RowTone, string, string]>([
    ["added", "bg-green-dim", "ring-green/40"],
    ["removed", "bg-amber-dim", "ring-amber/40"],
  ])("keeps a %s row's fill on every index and under hover", (tone, fill, ring) => {
    for (const index of [0, 1, 2, 3]) {
      for (const interactive of [false, true]) {
        const list = classes(rowSurfaceClass({ index, tone, interactive }));
        expect(list).toEqual(expect.arrayContaining([fill, "ring-1", "ring-inset", ring]));
        expect(list.some((c) => c.startsWith("bg-white"))).toBe(false);
        // The only hover fill is the tone's own (it replaces TableRow's
        // `hover:bg-muted/50` through cn()).
        expect(list.filter((c) => /^(hover|even|odd):bg-/.test(c))).toEqual([`hover:${fill}`]);
        expect(list.some((c) => c.startsWith("hover:ring-primary"))).toBe(false);
        expect(list.includes("cursor-pointer")).toBe(interactive);
      }
    }
  });

  it("answers hover on a toned row in the tone's own hue", () => {
    expect(classes(rowSurfaceClass({ index: 0, tone: "added", interactive: true }))).toContain("hover:ring-green/80");
    expect(classes(rowSurfaceClass({ index: 0, tone: "removed", interactive: true }))).toContain("hover:ring-amber/80");
  });

  it("names each tone in words", () => {
    expect(ROW_TONE_LABELS.added.short).toBe("New");
    expect(ROW_TONE_LABELS.removed.short).toBe("Removed");
  });
});

// The app's tables are virtualized: a row's :nth-child position moves with the
// rendered window, so an `even:`/`odd:` stripe flips on every row scrolled.
describe("zebra stripes", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
      return /\.(tsx|ts)$/.test(name) ? [path] : [];
    });
  }

  it("never use the even:/odd: variants", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => /(?:^|[\s"'`])(?:even|odd):[a-z[!]/m.test(readFileSync(path, "utf8")))
      .map((path) => relative(process.cwd(), path));
    expect(offenders).toEqual([]);
  });
});
