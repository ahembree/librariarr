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
  const text = JSON.stringify(body);
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
