import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");

/**
 * Every event type the server can emit must have at least one client
 * subscriber.
 *
 * This exists because an audit of the realtime layer found two events —
 * `server:changed` and `settings:changed` — that were emitted by several
 * routes, correctly forwarded over SSE, and read by nobody at all. Nothing
 * failed; the UI simply went stale until a reload, which is invisible in review
 * and in every other test. A dangling emitter is silent by construction, so the
 * only way to catch it is to assert the two halves against each other.
 *
 * If this fails you have added an event type without wiring anything to it.
 * Either subscribe a component with `useRealtime("<type>", …)`, or — if the
 * event genuinely has no browser consumer — add it to SERVER_ONLY below with a
 * comment saying why.
 */

/** Event types deliberately not consumed by the browser. */
const SERVER_ONLY = new Set<string>([
  // (empty — every event currently reaches the UI)
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function declaredEventTypes(): string[] {
  const source = readFileSync(join(SRC, "lib/events/event-bus.ts"), "utf-8");
  const union = source.slice(
    source.indexOf("export type AppEventType ="),
    source.indexOf("export interface AppEvent"),
  );
  // Union members are quoted string literals; comments in between are ignored
  // because they never contain a `| "..."` form.
  return [...union.matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("app event catalogue", () => {
  const types = declaredEventTypes();
  const sources = walk(SRC)
    .filter((f) => !f.endsWith("use-realtime.ts"))
    .map((f) => readFileSync(f, "utf-8"))
    .join("\n");

  it("parses the AppEventType union", () => {
    // Guards the regex above: if the union's shape changes so that nothing
    // parses, every other assertion here would vacuously pass.
    expect(types.length).toBeGreaterThan(5);
    expect(types).toContain("sync:completed");
  });

  it.each(types)("%s has at least one client subscriber", (type) => {
    if (SERVER_ONLY.has(type)) return;
    expect(sources).toContain(`useRealtime("${type}"`);
  });

  it("has no SERVER_ONLY entry that is not a real event type", () => {
    for (const type of SERVER_ONLY) {
      expect(types).toContain(type);
    }
  });
});
