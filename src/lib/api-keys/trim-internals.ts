import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/api/json-response";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

const gunzipAsync = promisify(gunzip);

/**
 * Drops a media server's addressing details from a JSON response before it
 * leaves through the public API.
 *
 * The internal routes answer the app's own UI, which needs a server's `url`
 * to link to it and a media item's `filePath` to show it. A third-party
 * integration holding a read scope needs neither, and each is more than it
 * looks: a plex.direct hostname spells out the server's IP address (for a
 * remote server, the public one), `machineId` is the identifier plex.tv
 * addresses the server by, and `filePath` maps the server's storage. This
 * wrapper is applied in the `/api/v1` mirror only, so the internal route's
 * output does not change (precedent: the v1 maintenance route rebuilds its
 * request for the Settings handler — a v1 route may take or return less).
 *
 * The rule, applied recursively to the parsed body:
 *
 * - `filePath` is removed from EVERY object. It names a file on a media
 *   server's disk wherever it appears in these responses.
 * - `url`, `externalUrl`, `serverUrl`, `machineId`, `userId` and `accessToken`
 *   (always the masked placeholder by the time it reaches a response) are removed
 *   from an object that is, or describes, a media server: it has a `type` of
 *   `PLEX`/`JELLYFIN`/`EMBY`, or it has a `machineId` (a column only
 *   `MediaServer` has), or it sits under a `mediaServer` key or inside a
 *   `playServers` array. The three tests overlap on purpose — a select that
 *   omits `type` still carries `machineId`, and `playServers` rows carry
 *   neither, only `serverUrl`. Nothing else in these responses has a `url`
 *   (an artwork `thumbUrl` is a different key and is kept).
 * - a string `error` is passed through `sanitizeErrorDetail`. The writers
 *   sanitize before persisting, but a `SyncJob`/`LifecycleAction` row stored
 *   before they did still holds the raw text.
 *
 * A non-JSON response (an image, a stream, a body with no JSON content type)
 * is returned untouched. A JSON body the internal route already gzipped
 * (`jsonResponse` compresses past 4 KB when the client accepts it) is
 * inflated, transformed and re-emitted through `jsonResponse`, so the caller
 * still gets a compressed body; status and every other header are preserved.
 */

const SERVER_TYPES = new Set(["PLEX", "JELLYFIN", "EMBY"]);
const SERVER_INTERNAL_KEYS = new Set(["url", "externalUrl", "serverUrl", "machineId", "userId", "accessToken"]);
const SERVER_CONTAINER_KEYS = new Set(["mediaServer", "playServers"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeServer(obj: Record<string, unknown>): boolean {
  return (typeof obj.type === "string" && SERVER_TYPES.has(obj.type)) || "machineId" in obj;
}

/** The transform itself, exported for the unit test. Returns a new value; never mutates. */
export function trimServerInternals(value: unknown, underServerKey = false): unknown {
  if (Array.isArray(value)) return value.map((item) => trimServerInternals(item, underServerKey));
  if (!isRecord(value)) return value;

  const isServer = underServerKey || looksLikeServer(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "filePath") continue;
    if (isServer && SERVER_INTERNAL_KEYS.has(key)) continue;
    if (key === "error" && typeof child === "string") {
      result[key] = sanitizeErrorDetail(child) ?? child;
      continue;
    }
    result[key] = trimServerInternals(child, SERVER_CONTAINER_KEYS.has(key));
  }
  return result;
}

function isJson(response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return /^application\/json\b/i.test(type.trim());
}

/** Headers `jsonResponse` derives itself for the re-emitted body. */
const BODY_HEADERS = new Set(["content-type", "content-encoding", "content-length", "vary"]);

type RouteHandler<C> = (request: NextRequest, context: C) => Response | Promise<Response>;

// Same overloads as `withApiKey`, so a one-parameter handler stays one-parameter
// and one with dynamic segments keeps its `{ params }` context type.
export function withoutServerInternals(
  handler: (request: NextRequest) => Response | Promise<Response>,
): (request: NextRequest) => Promise<Response>;
export function withoutServerInternals<C>(handler: RouteHandler<C>): (request: NextRequest, context: C) => Promise<Response>;
export function withoutServerInternals<C>(handler: RouteHandler<C>): (request: NextRequest, context: C) => Promise<Response> {
  return async (request: NextRequest, context: C): Promise<Response> => {
    const response = await handler(request, context);
    if (!isJson(response) || response.body === null) return response;

    const raw = new Uint8Array(await response.arrayBuffer());
    const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    const text = encoding === "gzip"
      ? (await gunzipAsync(raw)).toString("utf8")
      : new TextDecoder().decode(raw);
    // An empty JSON body (a 204-ish handler) has nothing to trim — pass the
    // original through rather than re-emit `undefined`.
    if (text.length === 0) return new Response(raw, { status: response.status, headers: response.headers });

    const trimmed = trimServerInternals(JSON.parse(text));
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      if (!BODY_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return jsonResponse(request, trimmed, { status: response.status, headers });
  };
}
