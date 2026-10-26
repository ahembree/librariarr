/**
 * Every browser call to a route that can answer `reauth_required` goes through
 * `fetchWithReauth`.
 *
 * A route that starts asking for a recent sign-in (`reauthRequired`, or
 * `refuseStoredKeyToNewUrl`) needs its callers moved to `fetchWithReauth`, or
 * the 403 arrives as a plain error with no "Confirm it's you" prompt and the
 * action can no longer be done from a session older than 15 minutes. That is
 * how the AI settings shipped: the routes gained the stored-key check and the
 * Settings page's save and test stayed on `fetch`.
 *
 * Reads the sources: which exported method of which route file calls a guard,
 * and every `fetch("/api/…")` / `fetchWithReauth("/api/…")` with a literal URL
 * outside `src/app/api`. A call whose JSON body cannot reach its route's check
 * (an enable toggle carries no URL) may stay on `fetch`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const API = path.join(SRC, "app", "api");

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : walk(full, keep);
    return keep(full) ? [full] : [];
  });
}

// ─── Routes ───

const GUARD_CALL = /\b(?:reauthRequired|refuseStoredKeyToNewUrl)\(/;
const METHOD_EXPORT = /^export\s+async\s+function\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\b/gm;

interface GuardedRoute {
  /** `/api/servers/[id]` */
  path: string;
  segments: string[];
  guarded: Set<string>;
}

// A route file whose methods a shared builder makes:
// `export const { PUT, DELETE } = instanceItemRoutes(RADARR);`
const BUILT_EXPORT = /^export\s+const\s+\{([^}]+)\}\s*=\s*(\w+)\(/gm;
const BUILDER_METHOD = /^\s*async\s+function\s+(GET|HEAD|POST|PUT|PATCH|DELETE)\(/gm;

/**
 * The methods a builder imported by a route file defines, each with its body.
 * Follows the import to the builder's module and reads its `export function
 * <builder>(…)`, whose handlers are `async function METHOD(…)` declarations.
 */
function builderMethods(routeSource: string, builder: string): Map<string, string> {
  const spec = new RegExp(`import\\s*\\{[^}]*\\b${builder}\\b[^}]*\\}\\s*from\\s*"(@/[^"]+)"`).exec(routeSource)?.[1];
  if (!spec) throw new Error(`cannot find where ${builder} is imported from`);
  const moduleSource = readFileSync(path.join(SRC, `${spec.slice(2)}.ts`), "utf8");
  const start = moduleSource.search(new RegExp(`export function ${builder}[<(]`));
  if (start === -1) throw new Error(`${spec} does not export function ${builder}`);
  const next = moduleSource.indexOf("\nexport ", start + 1);
  const body = moduleSource.slice(start, next === -1 ? moduleSource.length : next);
  const methods = [...body.matchAll(BUILDER_METHOD)];
  return new Map(methods.map((m, i) => [m[1], body.slice(m.index, methods[i + 1]?.index ?? body.length)]));
}

function guardedRoutes(): GuardedRoute[] {
  return walk(API, (f) => f.endsWith(`${path.sep}route.ts`))
    .filter((f) => !f.startsWith(path.join(API, "v1") + path.sep))
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const exports = [...source.matchAll(METHOD_EXPORT)];
      const guarded = new Set<string>();
      exports.forEach((m, i) => {
        const body = source.slice(m.index, exports[i + 1]?.index ?? source.length);
        if (GUARD_CALL.test(body)) guarded.add(m[1]);
      });
      for (const [, names, builder] of source.matchAll(BUILT_EXPORT)) {
        const methods = builderMethods(source, builder);
        for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
          const body = methods.get(name);
          if (body === undefined) throw new Error(`${builder} defines no ${name} (exported by ${file})`);
          if (GUARD_CALL.test(body)) guarded.add(name);
        }
      }
      if (guarded.size === 0) return [];
      const routePath = "/" + path.relative(path.join(SRC, "app"), path.dirname(file)).split(path.sep).join("/");
      return [{ path: routePath, segments: routePath.split("/").filter(Boolean), guarded }];
    });
}

// ─── Client calls ───

interface Body {
  /** Top-level keys of the `JSON.stringify({ … })` object literal. */
  keys: Set<string>;
  /** A top-level spread: its keys are unknown. */
  spread: boolean;
}

interface ClientCall {
  where: string;
  wrapped: boolean;
  url: string;
  method: string;
  /** null when the body is not an object literal (unknown). */
  body: Body | null;
}

/** Index just past the string/template literal starting at `i`. */
function skipLiteral(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") j += 2;
    else if (quote === "`" && src[j] === "$" && src[j + 1] === "{") j = skipBalanced(src, j + 1);
    else j++;
  }
  return j + 1;
}

/** Index just past the bracket group opening at `i`. */
function skipBalanced(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipLiteral(src, j);
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/** Top-level keys of the object literal whose `{` is at `i`. */
function objectKeys(src: string, i: number): Body {
  const keys = new Set<string>();
  let spread = false;
  const end = skipBalanced(src, i) - 1;
  let j = i + 1;
  let expectKey = true;
  while (j < end) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipLiteral(src, j);
      expectKey = false;
    } else if (c === "(" || c === "{" || c === "[") {
      j = skipBalanced(src, j);
      expectKey = false;
    } else if (c === ",") {
      expectKey = true;
      j++;
    } else if (expectKey && src.startsWith("...", j)) {
      spread = true;
      expectKey = false;
      j += 3;
    } else if (expectKey && /[A-Za-z_$]/.test(c)) {
      const name = /^[A-Za-z_$][\w$]*/.exec(src.slice(j))![0];
      keys.add(name);
      expectKey = false;
      j += name.length;
    } else {
      j++;
    }
  }
  return { keys, spread };
}

const CALL = /\b(fetchWithReauth|fetch)\(\s*(?=["'`]\/api\/)/g;

function clientCalls(): ClientCall[] {
  return walk(SRC, (f) => /\.tsx?$/.test(f) && !f.startsWith(API + path.sep)).flatMap((file) => {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(CALL)].map((m) => {
      const start = m.index + m[0].length;
      const urlEnd = skipLiteral(src, start);
      const url = src.slice(start + 1, urlEnd - 1);
      const callEnd = skipBalanced(src, m.index + m[1].length);
      const options = src.slice(urlEnd, callEnd);
      const method = /\bmethod:\s*["'`](\w+)["'`]/.exec(options)?.[1]?.toUpperCase() ?? "GET";
      const bodyAt = /\bbody:\s*JSON\.stringify\(\s*/.exec(options);
      let body: Body | null = null;
      if (bodyAt) {
        const at = urlEnd + bodyAt.index + bodyAt[0].length;
        if (src[at] === "{") body = objectKeys(src, at);
      }
      const line = src.slice(0, m.index).split("\n").length;
      return {
        where: `${path.relative(ROOT, file)}:${line}`,
        wrapped: m[1] === "fetchWithReauth",
        url,
        method,
        body,
      };
    });
  });
}

/**
 * The routes a call can reach. A literal segment resolves as Next does — a
 * static route before a dynamic one; a `${…}` segment could be anything, so
 * every route it fits counts.
 */
function routesFor(url: string, routes: GuardedRoute[], allRoutes: string[][]): GuardedRoute[] {
  const segments = url.split("?")[0].split("/").filter(Boolean);
  const fits = (route: string[]) =>
    route.length === segments.length &&
    route.every((r, i) => segments[i].includes("${") || r.startsWith("[") || r === segments[i]);
  const isDynamic = (s: string) => s.startsWith("[");
  // Next's precedence for a literal segment: a route with a static segment
  // where the call has a literal one wins over a dynamic one.
  const best = allRoutes.filter(fits).reduce<string[][]>((acc, route) => {
    if (acc.length === 0) return [route];
    const cmp = route.findIndex((r, i) => !segments[i].includes("${") && isDynamic(r) !== isDynamic(acc[0][i]));
    if (cmp === -1) return [...acc, route];
    return isDynamic(route[cmp]) ? acc : [route];
  }, []);
  return routes.filter((r) => best.some((b) => b.join("/") === r.segments.join("/")));
}

// ─── Which plain-fetch calls cannot reach a check ───

/**
 * For a route whose check depends on what the request changes: whether a body
 * can reach it. Anything not listed here reaches its check whatever it sends.
 */
const CAN_TRIGGER: Record<string, (body: Body) => boolean> = {
  // A new URL, or certificate checks turned off, with the stored token kept.
  "PUT /api/servers/[id]": (b) => b.spread || b.keys.has("url") || b.keys.has("tlsSkipVerify"),
  // A discovered Plex server with no token in the request.
  "POST /api/servers": (b) => !b.keys.has("accessToken"),
  // A new URL with the stored key kept (stored-key-guard.ts).
  "PUT /api/integrations/[*]/[id]": (b) => b.spread || b.keys.has("url"),
  "POST /api/integrations/[*]/[id]/test-connection": (b) => b.spread || b.keys.has("url"),
  "PUT /api/settings/ai": (b) => b.spread || b.keys.has("baseUrl"),
  "POST /api/settings/ai/test": (b) => b.spread || b.keys.has("baseUrl"),
};

/** Callers that confirm identity some other way, with the reason. */
const CONFIRMS_INLINE: Record<string, string> = {
  // The create-key dialog renders `ReauthPanel` in place of the prompt.
  "POST /api/settings/api-keys": "ReauthPanel",
};

function triggerKey(method: string, route: string): string {
  return `${method} ${route.replace(/^\/api\/integrations\/(?:lidarr|radarr|seerr|sonarr|tracearr)\//, "/api/integrations/[*]/")}`;
}

describe("callers of recent-login-guarded routes", () => {
  const routes = guardedRoutes();
  const allRoutes = walk(API, (f) => f.endsWith(`${path.sep}route.ts`)).map((f) =>
    path.relative(path.join(SRC, "app"), path.dirname(f)).split(path.sep),
  );
  const calls = clientCalls();

  it("finds the guarded routes and their callers", () => {
    // A scanner that silently matched nothing would pass every check below.
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/api/settings/ai", "/api/servers/[id]", "/api/backup/restore"]));
    expect(routes.find((r) => r.path === "/api/backup")?.guarded).toEqual(new Set(["POST"]));
    expect(routes.find((r) => r.path === "/api/backup/[filename]")?.guarded).toEqual(new Set(["GET"]));
    // The integration routes are built by a shared builder; their guard is
    // found in the builder's handler bodies.
    for (const type of ["lidarr", "radarr", "seerr", "sonarr", "tracearr"]) {
      expect(routes.find((r) => r.path === `/api/integrations/${type}/[id]`)?.guarded, type).toEqual(new Set(["PUT"]));
      expect(routes.find((r) => r.path === `/api/integrations/${type}/[id]/test-connection`)?.guarded, type).toEqual(
        new Set(["POST"]),
      );
    }
    expect(calls.filter((c) => c.wrapped).length).toBeGreaterThan(20);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(
      expect.arrayContaining(["PUT /api/settings/ai", "POST /api/settings/ai/test", "PUT /api/servers/${serverId}"]),
    );
  });

  // An exemption for a route that no longer asks for a recent sign-in (or was
  // renamed) is dead weight that would silently cover whatever takes its key.
  it("lists exemptions only for methods of routes that are guarded", () => {
    const guardedKeys = new Set(routes.flatMap((r) => [...r.guarded].map((m) => triggerKey(m, r.path))));
    const exemptions = [...Object.keys(CAN_TRIGGER), ...Object.keys(CONFIRMS_INLINE)];
    expect(exemptions.filter((key) => !guardedKeys.has(key))).toEqual([]);
  });

  it("sends every call that can be refused for an old sign-in through fetchWithReauth", () => {
    const unwrapped = calls.flatMap((call) => {
      if (call.wrapped) return [];
      return routesFor(call.url, routes, allRoutes)
        .filter((route) => route.guarded.has(call.method))
        .filter((route) => {
          const key = triggerKey(call.method, route.path);
          if (CONFIRMS_INLINE[key]) return false;
          const canTrigger = CAN_TRIGGER[key];
          if (!canTrigger) return true;
          return call.body === null || canTrigger(call.body);
        })
        .map((route) => `${call.where} ${call.method} ${route.path}`);
    });
    expect(unwrapped).toEqual([]);
  });
});
