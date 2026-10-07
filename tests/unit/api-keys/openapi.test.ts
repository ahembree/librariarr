import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getApiKeyGuard } from "@/lib/api-keys/guard";
import { FULL_LISTING_REQUEST_COST } from "@/lib/api-keys/limits";
import {
  API_OPERATIONS,
  OPENAPI_HISTORY_SORT_KEYS,
  buildOpenApiDocument,
  operationId,
} from "@/lib/api-keys/openapi";
import { HISTORY_SORT_KEYS, HISTORY_SORT_SQL } from "@/lib/media/history-sort";
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

  describe("GET /media/history", () => {
    const op = API_OPERATIONS.find((o) => o.method === "get" && o.path === "/media/history");

    it("lists exactly the sort keys the route's whitelist accepts", () => {
      // openapi.ts keeps its own copy (it cannot import history-sort.ts — see
      // OPENAPI_HISTORY_SORT_KEYS), so this is what keeps the copy current.
      expect([...OPENAPI_HISTORY_SORT_KEYS]).toEqual([...HISTORY_SORT_KEYS]);
      const sortBy = op?.query?.find((p) => p.name === "sortBy");
      expect(sortBy?.schema?.enum).toEqual([...HISTORY_SORT_KEYS]);
    });

    it("documents every query parameter the route reads, and none it does not", () => {
      const source = readFileSync(
        path.resolve(__dirname, "../../../src/app/api/media/history/route.ts"),
        "utf8",
      );
      const read = [...source.matchAll(/searchParams\.get\("(\w+)"\)/g)].map((m) => m[1]);
      expect(read.length).toBeGreaterThan(10);
      expect((op?.query ?? []).map((p) => p.name).sort()).toEqual([...new Set(read)].sort());
    });

    it("documents the title sort's key order, matching the route's ORDER BY", () => {
      // The sentence a client reads to know where an episode lands under
      // `sortBy=title`: the show/artist first, then season and episode for
      // episodes only, then the row's own title — not the item's own title
      // alone, which scattered a show's episodes by episode name.
      const description = op?.description ?? "";
      expect(description).toContain(
        "`sortBy=title` sorts by the displayed title (the show or artist, then season and " +
          "episode for episodes, then the title)",
      );
      // Pinned to the ORDER BY the route applies, so neither can be reordered
      // without the other: the display lead (show/artist, else title), season,
      // episode — both episode-only — then the row's own title.
      const [lead, season, episode, own, ...rest] = HISTORY_SORT_SQL.title;
      expect(rest).toEqual([]);
      expect(lead).toMatch(/"parentTitle".*ELSE mi\."title"/);
      expect(season).toMatch(/'SERIES'.*"seasonNumber"/);
      expect(episode).toMatch(/'SERIES'.*"episodeNumber"/);
      expect(own).toBe('LOWER(mi."title")');
    });
  });
});
