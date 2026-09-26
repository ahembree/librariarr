import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getApiKeyGuard } from "@/lib/api-keys/guard";
import { API_SCOPE_INFO, isApiScope } from "@/lib/api-keys/scopes";

/**
 * The public API's permission model, asserted structurally over every route
 * file under `src/app/api/v1`:
 *
 * - every exported handler is wrapped by `withApiKey` — an unwrapped handler
 *   would fall through to the cookie session, and answer 401 or worse;
 * - every GET needs a READ scope (or, for introspection, just a valid key) and
 *   every other method needs a WRITE scope — which is what makes a read-only
 *   key unable to change anything, whatever handler a future endpoint wraps;
 * - the full method/path/scope table matches the one below, so exposing a new
 *   endpoint, or changing what an existing one requires, is a visible,
 *   reviewed change to this file rather than a line in a route nobody reads.
 */

const V1_ROOT = path.resolve(__dirname, "../../../src/app/api/v1");
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

const EXPECTED = [
  "GET /api/v1/lifecycle/actions lifecycle:read",
  "POST /api/v1/lifecycle/actions/execute lifecycle:execute",
  "DELETE /api/v1/lifecycle/exceptions lifecycle:write",
  "GET /api/v1/lifecycle/exceptions lifecycle:read",
  "POST /api/v1/lifecycle/exceptions lifecycle:write",
  "DELETE /api/v1/lifecycle/exceptions/[id] lifecycle:write",
  "GET /api/v1/lifecycle/rules lifecycle:read",
  "GET /api/v1/lifecycle/rules/matches lifecycle:read",
  "POST /api/v1/lifecycle/rules/run lifecycle:write",
  "GET /api/v1/lifecycle/stats lifecycle:read",
  "POST /api/v1/jobs/detection lifecycle:write",
  "POST /api/v1/jobs/execution lifecycle:execute",
  "POST /api/v1/jobs/sync sync:write",
  "GET /api/v1/me (any valid key)",
  "GET /api/v1/media/[id] media:read",
  "GET /api/v1/media/[id]/image media:read",
  "GET /api/v1/media/[id]/plays media:read",
  "GET /api/v1/media/history media:read",
  "GET /api/v1/media/movies media:read",
  "GET /api/v1/media/music media:read",
  "GET /api/v1/media/music/albums media:read",
  "GET /api/v1/media/music/grouped media:read",
  "GET /api/v1/media/recently-added media:read",
  "GET /api/v1/media/search media:read",
  "GET /api/v1/media/series media:read",
  "GET /api/v1/media/series/grouped media:read",
  "GET /api/v1/media/series/seasons media:read",
  "GET /api/v1/media/stats media:read",
  "GET /api/v1/servers servers:read",
  "POST /api/v1/servers/[id]/sync sync:write",
  "POST /api/v1/sync/cancel sync:write",
  "GET /api/v1/sync/status servers:read",
  "GET /api/v1/system/info system:read",
  "GET /api/v1/tools/maintenance streams:read",
  "PUT /api/v1/tools/maintenance streams:write",
  "GET /api/v1/tools/sessions streams:read",
  "POST /api/v1/tools/sessions/terminate streams:write",
];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

async function loadRoutes() {
  const routes: Array<{ route: string; method: string; handler: unknown }> = [];
  for (const file of routeFiles(V1_ROOT)) {
    const route = "/api/v1/" + path.relative(V1_ROOT, path.dirname(file)).split(path.sep).join("/");
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [name, handler] of Object.entries(mod)) {
      routes.push({ route: route.replace(/\/$/, ""), method: name, handler });
    }
  }
  return routes;
}

describe("/api/v1 route guards", () => {
  it("exports nothing but HTTP method handlers", async () => {
    const routes = await loadRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const { route, method } of routes) {
      expect(HTTP_METHODS, `${route} exports "${method}"`).toContain(method);
    }
  });

  it("wraps every handler in withApiKey with a known scope", async () => {
    for (const { route, method, handler } of await loadRoutes()) {
      const guard = getApiKeyGuard(handler);
      expect(guard, `${method} ${route} is not wrapped in withApiKey`).toBeDefined();
      if (guard!.scope !== null) expect(isApiScope(guard!.scope)).toBe(true);
    }
  });

  it("requires a read scope for GET and a write scope for everything else", async () => {
    for (const { route, method, handler } of await loadRoutes()) {
      const scope = getApiKeyGuard(handler)!.scope;
      if (method === "GET" || method === "HEAD") {
        if (scope !== null) {
          expect(API_SCOPE_INFO[scope].access, `${method} ${route} → ${scope}`).toBe("read");
        }
      } else {
        expect(scope, `${method} ${route} must name a write scope`).not.toBeNull();
        expect(API_SCOPE_INFO[scope!].access, `${method} ${route} → ${scope}`).toBe("write");
      }
    }
  });

  it("exposes exactly the reviewed endpoint table", async () => {
    const actual = (await loadRoutes())
      .map(({ route, method, handler }) => {
        const scope = getApiKeyGuard(handler)?.scope;
        return `${method} ${route} ${scope ?? "(any valid key)"}`;
      })
      .sort((a, b) => a.split(" ")[1].localeCompare(b.split(" ")[1]) || a.localeCompare(b));
    const expected = [...EXPECTED].sort(
      (a, b) => a.split(" ")[1].localeCompare(b.split(" ")[1]) || a.localeCompare(b),
    );
    expect(actual).toEqual(expected);
  });
});
