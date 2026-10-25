import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { withSharedSession } from "@/lib/auth/shared-session";
import { appCache } from "@/lib/cache/memory-cache";
import { LIST_RESPONSE_CACHE_PREFIX } from "@/lib/cache/list-response-prefix";
import { acceptsGzip } from "@/lib/api/json-response";
import { sortedQueryString } from "@/lib/sorted-query";

const gunzipAsync = promisify(gunzip);

/** As long as `appCache`'s own default: every change to the media set drops it anyway. */
export const LIST_RESPONSE_CACHE_TTL_MS = 60_000;

/**
 * How many listings are kept at once. An entry is a whole compressed library —
 * megabytes, where an `appCache` entry is usually a few figures — so these get
 * a bound of their own. A page's first screenful and its remainder are two
 * entries and the grouped listings one each, so this covers moving between
 * every library page and back; a filter typed letter by letter cycles through
 * it instead of growing.
 */
export const LIST_RESPONSE_CACHE_MAX_ENTRIES = 24;

/**
 * Bodies past this many (compressed) bytes are answered but not kept: one
 * huge library must not be able to hold hundreds of megabytes on a small host.
 */
export const LIST_RESPONSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface StoredResponse {
  status: number;
  headers: [string, string][];
  body: Uint8Array<ArrayBuffer>;
  gzip: boolean;
}

/** Headers recomputed per answer rather than replayed from the stored one. */
const PER_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "vary"]);

/**
 * The keys stored, oldest first, so the oldest can be dropped past the bound.
 * A key `invalidateMediaCaches()` already removed may linger here; such a key
 * is forgotten without touching `appCache`, since the same listing may be
 * recomputing under it and invalidating would throw that run's result away.
 * Pinned to `globalThis` like `appCache` itself, so every module copy bounds
 * the same set of entries.
 */
const globalForListKeys = globalThis as unknown as { listResponseCacheKeys: Set<string> | undefined };
const storedKeys = (globalForListKeys.listResponseCacheKeys ??= new Set<string>());

function remember(key: string): void {
  storedKeys.delete(key);
  storedKeys.add(key);
  // Keys whose entry is already gone (invalidated or expired) hold no space.
  for (const stored of storedKeys) {
    if (stored !== key && appCache.get(stored) === undefined) storedKeys.delete(stored);
  }
  while (storedKeys.size > LIST_RESPONSE_CACHE_MAX_ENTRIES) {
    const oldest = storedKeys.values().next().value;
    if (oldest === undefined) break;
    storedKeys.delete(oldest);
    appCache.invalidate(oldest);
  }
}

/**
 * The cache key: the listing's name plus its query string with the
 * parameters sorted, so the same filters in another order share an entry.
 * One admin owns every server (see "Single-user model"), so no user is in it.
 */
export function listCacheKey(name: string, url: string): string {
  return `${LIST_RESPONSE_CACHE_PREFIX}${name}?${sortedQueryString(new URL(url).searchParams)}`;
}

/**
 * A library listing's `GET`, answered from `appCache` when the same listing
 * was asked for in the last minute.
 *
 * Moving between the library pages and back — or from a page to an item and
 * back — re-ran the whole listing each time: the aggregate SQL, the
 * serialisation and the compression, for an answer nothing had changed. Every
 * mutation that can change one goes through `invalidateMediaCaches()`, which
 * drops these (`LIST_RESPONSE_CACHE_PREFIX`), and the TTL bounds anything else.
 *
 * The handler always runs with gzip accepted and the compressed body is what
 * is kept (lists compress 7–9×); a caller that does not accept gzip gets it
 * decompressed. Concurrent identical requests share one run of the handler.
 * Only a 200 under `LIST_RESPONSE_CACHE_MAX_BYTES` is kept; anything else is
 * passed on as the handler answered it. A request that is not signed in goes
 * straight to the handler, which refuses it as before.
 */
export function withListResponseCache(
  name: string,
  handler: (request: NextRequest) => Promise<Response>,
): (request: NextRequest) => Promise<Response> {
  // One session read for the request: the handler's own `getSession()` on a
  // miss reads through the same memo instead of checking the cookie again.
  return (request: NextRequest) => withSharedSession(() => cachedListGet(request));

  async function cachedListGet(request: NextRequest): Promise<Response> {
    const session = await getSession();
    if (!session.isLoggedIn) return handler(request);

    const key = listCacheKey(name, request.url);
    const stored = await appCache.getOrSet<StoredResponse>(
      key,
      async () => {
        const headers = new Headers(request.headers);
        headers.set("accept-encoding", "gzip");
        const response = await handler(new NextRequest(request.url, { headers }));
        return {
          status: response.status,
          headers: [...response.headers.entries()].filter(([header]) => !PER_RESPONSE_HEADERS.has(header.toLowerCase())),
          body: new Uint8Array(await response.arrayBuffer()),
          gzip: response.headers.get("content-encoding") === "gzip",
        };
      },
      LIST_RESPONSE_CACHE_TTL_MS,
      {
        shouldCache: (value) => {
          const keep = value.status === 200 && value.body.byteLength <= LIST_RESPONSE_CACHE_MAX_BYTES;
          if (keep) remember(key);
          return keep;
        },
      },
    );

    return toResponse(request, stored);
  }
}

async function toResponse(request: Request, stored: StoredResponse): Promise<Response> {
  const headers = new Headers(stored.headers);
  headers.append("Vary", "Accept-Encoding");
  let body = stored.body;
  if (stored.gzip) {
    if (acceptsGzip(request.headers.get("accept-encoding"))) {
      headers.set("Content-Encoding", "gzip");
    } else {
      body = new Uint8Array(await gunzipAsync(stored.body));
    }
  }
  headers.set("Content-Length", String(body.byteLength));
  return new NextResponse(body, { status: stored.status, headers });
}
