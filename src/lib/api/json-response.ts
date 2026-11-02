import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const gzipAsync = promisify(gzip);

/**
 * Bodies below this size are sent as-is: the gzip framing and the CPU spent
 * on them cost more than the handful of bytes saved.
 */
export const MIN_COMPRESS_BYTES = 4096;

/**
 * zlib level. JSON list payloads compress ~7–9x at any level; level 3 was
 * measured at 66 ms for a 28 MB episode list (vs 135 ms at the default 6 for a
 * 3.6 MB → 3.1 MB difference), and the work runs on the libuv threadpool, so
 * the event loop is never held.
 */
const GZIP_LEVEL = 3;

/** Rows serialised between yields to the event loop. */
export const STRINGIFY_SLICE_ROWS = 1000;

/** How deep a long list is looked for: `{ groups: [{ items: [...] }] }` is three levels. */
const MAX_LIST_DEPTH = 3;

/**
 * `JSON.stringify(body)`, but a long list is serialised a slice of rows at a
 * time with the event loop let through between slices — at the top level or
 * nested a few levels down, as the lifecycle listings nest theirs
 * (`{ groups: [{ items }] }`, `{ ruleMatches: [{ items }] }`).
 *
 * Serialising a whole library in one call held the process for hundreds of
 * milliseconds — measured against the production build while a 40k-track list
 * was built, a request to `/api/health` waited 0.7–1.1 s, and every poster on
 * the screen that asked for it waited the same. The output is identical to
 * `JSON.stringify(body)`: same keys in the same order, same values.
 */
export async function stringifyYielding(body: unknown): Promise<string> {
  const chunks: string[] = [];
  await writeJsonYielding(body, (chunk) => chunks.push(chunk));
  // A body with no JSON form answers what `JSON.stringify` does.
  return chunks.length > 0 ? chunks.join("") : (JSON.stringify(body) as string);
}

/**
 * `stringifyYielding`, handed to `write` a piece at a time instead of joined:
 * the pieces, concatenated, are exactly `JSON.stringify(body)`. For a writer
 * that sends them straight on (the NDJSON progress streams), the whole
 * document never exists as one string — joining a 30 MB preview result held
 * its slices and the joined copy at once, nearly doubling the request's peak
 * memory against a 2 GB heap.
 */
export async function writeJsonYielding(body: unknown, write: (chunk: string) => void): Promise<void> {
  const text = leafJson(body, MAX_LIST_DEPTH);
  if (text === null) await writeNode(body, MAX_LIST_DEPTH, write);
  else if (text !== undefined) write(text);
}

/**
 * The JSON of a value that holds no long list, `undefined` when it has none
 * (as `JSON.stringify` answers), or `null` when it does hold a long list and
 * must be written in pieces.
 */
function leafJson(value: unknown, depth: number): string | undefined | null {
  if (isLongList(value) || holdsLongList(value, depth)) return null;
  return JSON.stringify(value);
}

async function writeNode(value: unknown, depth: number, write: (chunk: string) => void): Promise<void> {
  if (isLongList(value)) return writeList(value, write);
  if (Array.isArray(value)) {
    write("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) write(",");
      const text = leafJson(value[i], depth - 1);
      // JSON.stringify writes an element with no JSON form as null.
      if (text === null) await writeNode(value[i], depth - 1, write);
      else write(text ?? "null");
    }
    write("]");
    return;
  }
  write("{");
  let first = true;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const text = leafJson(child, depth - 1);
    // JSON.stringify leaves out a key whose value has no JSON form.
    if (text === undefined) continue;
    write(`${first ? "" : ","}${JSON.stringify(key)}:`);
    first = false;
    if (text === null) await writeNode(child, depth - 1, write);
    else write(text);
  }
  write("}");
}

/** Does a plain object or short array hold a long list within `depth` levels? */
function holdsLongList(value: unknown, depth: number): boolean {
  if (depth <= 0) return false;
  const children = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : null;
  return children !== null && children.some((child) => isLongList(child) || holdsLongList(child, depth - 1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && typeof (value as { toJSON?: unknown }).toJSON !== "function";
}

function isLongList(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > STRINGIFY_SLICE_ROWS;
}

/** Let queued I/O — other requests, artwork — run before carrying on. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `rows.map(fn)` a slice at a time, letting the event loop through between
 * slices — for shaping a whole library into its response rows, which on a
 * large one holds the process as long as serialising it did.
 */
export async function mapInSlices<T, U>(rows: readonly T[], fn: (row: T) => U): Promise<U[]> {
  const out: U[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % STRINGIFY_SLICE_ROWS === 0) await yieldToEventLoop();
    out[i] = fn(rows[i]);
  }
  return out;
}

async function writeList(rows: unknown[], write: (chunk: string) => void): Promise<void> {
  write("[");
  for (let i = 0; i < rows.length; i += STRINGIFY_SLICE_ROWS) {
    if (i > 0) await yieldToEventLoop();
    // `[a,b]` → `a,b`: a slice is never empty, so this never writes "".
    write(`${i > 0 ? "," : ""}${JSON.stringify(rows.slice(i, i + STRINGIFY_SLICE_ROWS)).slice(1, -1)}`);
  }
  write("]");
}

/**
 * Does the client accept gzip? Handles `gzip;q=0` and `*` per RFC 9110.
 */
export function acceptsGzip(acceptEncoding: string | null): boolean {
  if (!acceptEncoding) return false;
  let wildcard = false;
  for (const raw of acceptEncoding.split(",")) {
    const [token, ...params] = raw.trim().split(";");
    const name = token.trim().toLowerCase();
    if (name !== "gzip" && name !== "*") continue;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="));
    const enabled = q === undefined || parseFloat(q.slice(2)) > 0;
    if (name === "gzip") return enabled;
    wildcard = enabled;
  }
  return wildcard;
}

/**
 * `NextResponse.json` with gzip.
 *
 * Next.js compresses rendered pages and static chunks but sends Route Handler
 * responses uncompressed — measured against the production image: a 28 MB
 * all-episodes list and a 2 MB movie list both left the server with no
 * `Content-Encoding`, while the surrounding HTML was gzipped. JSON list
 * payloads compress ~7–9x, so for the list routes this is the difference
 * between a page that paints in a second on a remote connection and one that
 * doesn't.
 *
 * Only bodies at or above `MIN_COMPRESS_BYTES` whose caller accepts gzip are
 * compressed; everything else behaves exactly like `NextResponse.json`. The
 * serialisation is the same `JSON.stringify`, so a BigInt still has to be
 * stringified by the caller first.
 */
export async function jsonResponse(
  request: Request,
  body: unknown,
  init?: ResponseInit,
): Promise<NextResponse> {
  return jsonTextResponse(request, await stringifyYielding(body), init);
}

/**
 * `jsonResponse` for a body that is already JSON text — the rule-match listing
 * splices each match's stored JSON instead of parsing and re-serialising it.
 */
export async function jsonTextResponse(
  request: Request,
  text: string,
  init?: ResponseInit,
): Promise<NextResponse> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  headers.append("Vary", "Accept-Encoding");

  // `text.length` (UTF-16 units) is a floor on the UTF-8 byte count, which is
  // all a threshold needs; a second pass over a multi-megabyte string to get
  // the exact figure would cost more than the bytes it decides about.
  if (
    text.length < MIN_COMPRESS_BYTES ||
    !acceptsGzip(request.headers.get("accept-encoding"))
  ) {
    return new NextResponse(text, { ...init, headers });
  }

  const compressed = await gzipAsync(text, { level: GZIP_LEVEL });
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  // A zero-copy view: `Buffer` already is a `Uint8Array`, but its `ArrayBufferLike`
  // typing is not assignable to `BodyInit`, and `new Uint8Array(buffer)` would
  // copy the whole compressed body.
  const view = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  return new NextResponse(view, { ...init, headers });
}
