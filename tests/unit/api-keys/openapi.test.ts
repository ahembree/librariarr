import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getApiKeyGuard } from "@/lib/api-keys/guard";
import { FULL_LISTING_REQUEST_COST } from "@/lib/api-keys/limits";
import { API_OPERATIONS, DOCUMENTED_LIST_LIMIT, buildOpenApiDocument, operationId } from "@/lib/api-keys/openapi";
import { DEFAULT_LIST_LIMIT, MAX_GROUPED_LIST_LIMIT, MAX_LIST_LIMIT } from "@/lib/api/pagination";
import { API_SCOPES } from "@/lib/api-keys/scopes";

/**
 * The OpenAPI document is built from `API_OPERATIONS` at request time, never
 * stored, so the only way it can go stale is that table drifting from the
 * route files. This pins the two together over every file on disk.
 */

const V1_ROOT = path.resolve(__dirname, "../../../src/app/api/v1");
const API_ROOT = path.resolve(__dirname, "../../../src/app/api");
const SRC_ROOT = path.resolve(__dirname, "../../../src");

/** Every `x.get("name")` a source file makes — the query parameters it reads. */
function namesRead(source: string): Set<string> {
  return new Set([...source.matchAll(/\.get\(\s*"(\w+)"\s*\)/g)].map((m) => m[1]));
}

/**
 * Parameters a route reads through a shared parser rather than by name: when
 * its source calls the parser, it reads everything the parser reads.
 */
function sharedReaders(): Record<string, Set<string>> {
  const buildWhere = readFileSync(path.join(SRC_ROOT, "lib/filters/build-where.ts"), "utf8");
  const filters = namesRead(buildWhere);
  for (const m of buildWhere.matchAll(/applyConditionFilter\([^)]*?"(\w+Conditions)",\s*"(\w+Logic)"/g)) {
    filters.add(m[1]);
    filters.add(m[2]);
  }
  return {
    parseListPagination: new Set(["page", "limit", "offset"]),
    parsePlayHistoryPaging: new Set(["page", "limit", "serverId"]),
    applyCommonFilters: filters,
  };
}

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

  // A key's budget treats these reads differently; the document must say so
  // wherever the guard does.
  it("tells a client which reads are charged as full listings", async () => {
    const charged: string[] = [];
    for (const file of routeFiles(V1_ROOT)) {
      const route = "/" + path.relative(V1_ROOT, path.dirname(file)).split(path.sep).join("/");
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [method, handler] of Object.entries(mod)) {
        if (getApiKeyGuard(handler)?.fullListing) charged.push(`${method.toLowerCase()} ${route}`);
      }
    }
    expect(charged.length).toBeGreaterThan(0);
    for (const entry of charged) {
      const op = API_OPERATIONS.find((o) => `${o.method} ${o.path}` === entry);
      expect(op?.description, entry).toContain(`every read counts as ${FULL_LISTING_REQUEST_COST} requests`);
    }
  });

  // The spec promised `offset` on the grouped shows listing and `startsWith`
  // on the episode and track lists, none of which those handlers read: a
  // client paging by offset got page 1 forever, and a letter filter returned
  // the whole library. Every documented query parameter must be one the
  // handler behind the route actually reads.
  it("documents only query parameters the handler reads", () => {
    const shared = sharedReaders();
    for (const op of API_OPERATIONS) {
      if (!op.query?.length) continue;
      const file = path.join(API_ROOT, op.path.replace(/\{(\w+)\}/g, "[$1]"), "route.ts");
      const source = readFileSync(file, "utf8");
      const read = namesRead(source);
      for (const [parser, names] of Object.entries(shared)) {
        if (new RegExp(`\\b${parser}\\(`).test(source)) for (const n of names) read.add(n);
      }
      for (const param of op.query) {
        expect(read.has(param.name), `${op.method} ${op.path} documents "${param.name}", which ${path.relative(SRC_ROOT, file)} never reads`).toBe(true);
      }
    }
  });

  it("documents the list limits the routes enforce", () => {
    expect(DOCUMENTED_LIST_LIMIT).toEqual({ default: DEFAULT_LIST_LIMIT, flat: MAX_LIST_LIMIT, grouped: MAX_GROUPED_LIST_LIMIT });
    const limitOf = (p: string) => API_OPERATIONS.find((o) => o.path === p && o.method === "get")!.query!.find((q) => q.name === "limit")!.schema;
    for (const p of ["/media/movies", "/media/series", "/media/music"]) {
      expect(limitOf(p), p).toMatchObject({ maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT });
    }
    for (const p of ["/media/series/grouped", "/media/music/grouped"]) {
      expect(limitOf(p), p).toMatchObject({ maximum: MAX_GROUPED_LIST_LIMIT, default: DEFAULT_LIST_LIMIT });
    }
  });

  it("documents the status codes the routes answer with", () => {
    const doc = buildOpenApiDocument("http://localhost:3000", "0") as {
      paths: Record<string, Record<string, { description: string; responses: Record<string, unknown> }>>;
    };
    // Every operation passes the guard, which answers 503 when the database is down.
    for (const ops of Object.values(doc.paths)) for (const op of Object.values(ops)) expect(op.responses).toHaveProperty("503");
    // Adding an exception creates it: 201, never documented as 200.
    expect(Object.keys(doc.paths["/lifecycle/exceptions"].post.responses)).toEqual(expect.arrayContaining(["201", "404"]));
    expect(doc.paths["/lifecycle/exceptions"].post.responses).not.toHaveProperty("200");
    expect(doc.paths["/sync/cancel"].post.responses).toHaveProperty("404");
    expect(doc.paths["/lifecycle/actions/execute"].post.responses).toHaveProperty("404");
    for (const job of ["/jobs/sync", "/jobs/detection", "/jobs/execution"]) expect(doc.paths[job].post.responses, job).toHaveProperty("500");
  });

  it("does not tell a client an excepted item refuses the whole execute request", () => {
    // Excepted items and non-matches are skipped and the rest run; only an
    // identity change or a limit refuses the request whole.
    const execute = API_OPERATIONS.find((o) => o.path === "/lifecycle/actions/execute")!;
    expect(execute.description).toMatch(/protected by an exception, are skipped and the rest run/);
    expect(execute.description).not.toMatch(/nothing runs — when an item is excepted/);
    expect(execute.description).toMatch(/calls naming different items run side by side/);
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

  it("can publish the server as a template the reader fills in (the docs site)", () => {
    const doc = buildOpenApiDocument("{baseUrl}", "1.0.0", {
      serverVariables: { baseUrl: { default: "https://librariarr.example.com" } },
    }) as { servers: unknown[] };
    expect(doc.servers).toEqual([
      { url: "{baseUrl}/api/v1", variables: { baseUrl: { default: "https://librariarr.example.com" } } },
    ]);
  });

  it("documents the deletion limits where a key can delete", () => {
    const doc = buildOpenApiDocument("http://localhost:3000", "0") as {
      info: { description: string };
      paths: Record<string, Record<string, {
        description: string;
        requestBody?: { content: { "application/json": { schema: { required: string[]; properties: Record<string, { maxItems?: number }> } } } };
        responses: Record<string, { description: string }>;
      }>>;
    };
    expect(doc.info.description).toMatch(/at most 25 items, and every key together at most 100 an hour/);

    const execute = doc.paths["/lifecycle/actions/execute"].post;
    const schema = execute.requestBody!.content["application/json"].schema;
    expect(schema.required).toEqual(["ruleSetId", "mediaItemIds"]);
    expect(schema.properties.mediaItemIds.maxItems).toBe(25);
    expect(Object.keys(execute.responses)).toEqual(expect.arrayContaining(["200", "409", "429"]));

    const removeMany = doc.paths["/lifecycle/exceptions"].delete;
    expect(removeMany.requestBody!.content["application/json"].schema.properties.ids.maxItems).toBe(25);
    expect(removeMany.responses["429"].description).toMatch(/100 items in the last hour/);
    expect(doc.paths["/jobs/execution"].post.description).toMatch(/held/);
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
