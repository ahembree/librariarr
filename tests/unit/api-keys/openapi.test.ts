import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getApiKeyGuard } from "@/lib/api-keys/guard";
import { API_OPERATIONS, buildOpenApiDocument, operationId } from "@/lib/api-keys/openapi";
import { API_SCOPES } from "@/lib/api-keys/scopes";

/**
 * The OpenAPI document is built from `API_OPERATIONS` at request time, never
 * stored, so the only way it can go stale is that table drifting from the
 * route files. This pins the two together over every file on disk.
 */

const V1_ROOT = path.resolve(__dirname, "../../../src/app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

async function routeTable(): Promise<string[]> {
  const rows: string[] = [];
  for (const file of routeFiles(V1_ROOT)) {
    const route = "/" + path.relative(V1_ROOT, path.dirname(file)).split(path.sep).join("/");
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [method, handler] of Object.entries(mod)) {
      const scope = getApiKeyGuard(handler)?.scope ?? null;
      rows.push(`${method.toLowerCase()} ${route.replace(/\[(\w+)\]/g, "{$1}")} ${scope ?? "-"}`);
    }
  }
  return rows.sort();
}

describe("OpenAPI document", () => {
  it("describes exactly the routes on disk, with the scope each one enforces", async () => {
    const described = API_OPERATIONS.map((op) => `${op.method} ${op.path} ${op.scope ?? "-"}`).sort();
    expect(described).toEqual(await routeTable());
  });

  it("names only registry scopes", () => {
    for (const op of API_OPERATIONS) {
      if (op.scope !== null) expect(API_SCOPES).toContain(op.scope);
    }
  });

  it("builds a 3.1 document for the address it is served on", () => {
    const doc = buildOpenApiDocument("https://librariarr.example.com", "1.2.3") as {
      openapi: string;
      info: { version: string; description: string };
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { "x-scope": string | null; security: unknown[]; parameters: Array<{ name: string; in: string }>; responses: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.2.3");
    expect(doc.servers).toEqual([{ url: "https://librariarr.example.com/api/v1" }]);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["apiKeyHeader", "bearerAuth"]);
    for (const scope of API_SCOPES) expect(doc.info.description).toContain(scope);

    const byId = doc.paths["/media/{id}"].get;
    expect(byId["x-scope"]).toBe("media:read");
    expect(byId.parameters).toContainEqual(expect.objectContaining({ name: "id", in: "path" }));
    expect(Object.keys(byId.responses)).toEqual(expect.arrayContaining(["200", "401", "403", "404", "429"]));
    expect(byId.security).toEqual([{ bearerAuth: [] }, { apiKeyHeader: [] }]);
    expect(doc.paths["/me"].get["x-scope"]).toBeNull();
    expect(Object.keys(doc.paths["/lifecycle/exceptions"]).sort()).toEqual(["delete", "get", "post"]);
  });

  it("gives every operation a unique operationId", () => {
    const doc = buildOpenApiDocument("http://localhost:3000", "0") as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("getMediaByIdImage");
    expect(operationId("delete", "/lifecycle/exceptions/{id}")).toBe("deleteLifecycleExceptionsById");
    expect(operationId("get", "/openapi.json")).toBe("getOpenapiJson");
  });
});
