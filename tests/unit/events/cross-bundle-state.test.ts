import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// In a production build the code started from instrumentation (the job worker,
// the realtime manager, the enforcers) loads its own copy of every module, and
// the route handlers load another. Module-level state in a module BOTH load is
// therefore two states in production and one everywhere else — development and
// every test included — which is how the event bus, the sync limiter and the
// health cache each split without a single test noticing.
//
// This walks the import graph from both entry points and lists the mutable
// module-level state of every module in both. Each entry must be pinned to
// globalThis (`globalForX.x ??= …`, which this scan does not flag) or be listed
// below with the reason a second copy is harmless. New state in a shared module
// fails here until someone makes that call.

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

const ALLOWED: Record<string, string> = {
  "src/lib/backup/backup-service.ts#knownFieldCache":
    "derived from Prisma's generated field enums, identical in every copy",
  "src/lib/backup/backup-service.ts#droppedFieldsReported":
    "log-once set; a second copy logs the dropped column once more",
  "src/lib/jobs/client.ts#pool": "a connection pool per copy; the queue itself is in Postgres",
  "src/lib/jobs/client.ts#workerUtils": "per-copy handle onto the same Postgres queue",
  "src/lib/jobs/client.ts#workerUtilsPromise": "per-copy handle onto the same Postgres queue",
  "src/lib/lifecycle/processor.ts#lastApiHoldNoticeAt":
    "read and written only by executeLifecycleActions, which runs only in the worker's lifecycle task",
  "src/lib/maintenance/enforcer.ts#initialized":
    "the enforcer is started only from instrumentation; routes reach the module through the realtime manager's import and never call it",
  "src/lib/maintenance/enforcer.ts#isRunning": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/maintenance/enforcer.ts#prerollRunning": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/maintenance/enforcer.ts#prerollInitialized": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/maintenance/enforcer.ts#pendingTerminations": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/maintenance/enforcer.ts#knownBlackoutSessions": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/maintenance/enforcer.ts#lastPrerollPath": "enforcer state, instrumentation copy only (see initialized)",
  "src/lib/sync/sync-progress.ts#lastEmit":
    "throttle for sync:progress, emitted only by syncMediaServer/syncMediaServerItems, which run only in the worker",
};

const IMPORT_RE =
  /(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

const depsCache = new Map<string, string[]>();
function deps(file: string): string[] {
  const cached = depsCache.get(file);
  if (cached) return cached;
  const out: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
    if (m[1]) continue; // `import type` / `export type` — erased at build time
    const resolved = resolveImport(m[2] ?? m[3], file);
    if (resolved) out.push(resolved);
  }
  depsCache.set(file, out);
  return out;
}

function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...deps(file));
  }
  return seen;
}

function routeEntries(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeEntries(full);
    return /^(route|page|layout)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const MUTATION = (name: string) =>
  new RegExp(
    `\\b${name.replace(/\$/g, "\\$")}\\s*(?:\\.(?:set|add|delete|clear|push|pop|shift|unshift|splice)\\(|\\[[^\\]]*\\]\\s*=(?!=)|\\.[A-Za-z_$][\\w$]*\\s*=(?!=))`,
  );

/** `name`s of module-level state in `source`: every let/var, and const collections the file mutates. */
function moduleState(source: string): string[] {
  const lines = source.split("\n");
  const names: string[] = [];
  lines.forEach((line, i) => {
    const decl = /^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!decl) return;
    const [, kind, name] = decl;
    if (kind !== "const") {
      names.push(name);
      return;
    }
    // The initializer: after the first ` = ` (never `=>`), or the next line.
    const eq = /\s=(?:\s|$)/.exec(line);
    if (!eq) return;
    const init = (line.slice(eq.index + eq[0].length).trim() || (lines[i + 1] ?? "").trim());
    if (!/^(?:new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b|\[|\{)/.test(init)) return;
    const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
    if (MUTATION(name).test(rest)) names.push(name);
  });
  return names;
}

function sharedState(): string[] {
  const background = reachable([path.join(SRC, "instrumentation.ts")]);
  const routes = reachable([...routeEntries(path.join(SRC, "app")), path.join(SRC, "proxy.ts")]);
  return [...background]
    .filter((file) => routes.has(file) && !file.includes(`${path.sep}generated${path.sep}`))
    .flatMap((file) => moduleState(readFileSync(file, "utf8")).map((name) => `${path.relative(ROOT, file)}#${name}`))
    .sort();
}

describe("module state shared between instrumentation and routes", () => {
  const found = sharedState();

  it("is pinned to globalThis or allowed with a reason", () => {
    expect(found.filter((key) => !(key in ALLOWED))).toEqual([]);
  });

  it("every allowed entry still exists", () => {
    expect(Object.keys(ALLOWED).filter((key) => !found.includes(key))).toEqual([]);
  });

  it("reaches the worker's modules from instrumentation", () => {
    const background = reachable([path.join(SRC, "instrumentation.ts")]);
    for (const file of ["src/lib/jobs/tasks.ts", "src/lib/lifecycle/processor.ts", "src/lib/sync/sync-server.ts"]) {
      expect(background.has(path.join(ROOT, file))).toBe(true);
    }
  });

  it("flags the shapes it is for and not a pinned singleton", () => {
    const source = [
      "let counter = 0;",
      "const queue: Array<() => void> = [];",
      "const seen = new Map<string, number>();",
      "const lookup = new Set([1, 2]);",
      "const config = { a: 1 };",
      "const globalForX = globalThis as unknown as { x: Map<string, number> | undefined };",
      "const pinned = (globalForX.x ??= new Map<string, number>());",
      "function f() { queue.push(() => {}); seen.set('a', 1); config.a = 2; pinned.set('b', 2); counter++; }",
    ].join("\n");
    expect(moduleState(source)).toEqual(["counter", "queue", "seen", "config"]);
  });
});
