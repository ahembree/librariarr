/**
 * Write the public API's OpenAPI document for the docs site.
 *
 * The app itself never stores this document — it builds it per request from
 * `src/lib/api-keys/openapi.ts` — so the docs site gets the same generator run
 * at build time (`docs/package.json` → `build`), writing `docs/public/openapi.json`
 * for the API reference page. The file is git-ignored: it exists only inside a
 * docs build, so it can never be out of date with the code it was built from.
 *
 * Run from anywhere: `tsx scripts/generate-openapi.ts [out-file]`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/lib/api-keys/openapi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
const out = path.resolve(process.argv[2] ?? path.join(root, "docs/public/openapi.json"));

const document = buildOpenApiDocument("{baseUrl}", version, {
  serverVariables: {
    baseUrl: {
      default: "https://librariarr.example.com",
      description: "Where your Librariarr runs.",
    },
  },
});

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(document, null, 2) + "\n");
console.log(`Wrote ${path.relative(process.cwd(), out)} (Librariarr ${version})`);
