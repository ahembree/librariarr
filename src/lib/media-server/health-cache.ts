import { stripTrailingSlashes } from "@/lib/url-normalize";

const FAILURE_TTL_MS = 45_000;

interface FailureEntry {
  at: number;
  message: string;
}

// Pinned to globalThis: the job worker and the enforcer (started from
// instrumentation) and the route handlers each load their own copy of this
// module in a production build, so an unpinned map was one circuit breaker per
// side — a server the enforcer had just found down cost every route its full
// retry budget again, and the shell's unreachable banner disagreed with it.
const globalForHealth = globalThis as unknown as {
  mediaServerFailures: Map<string, FailureEntry> | undefined;
};
const failures = (globalForHealth.mediaServerFailures ??= new Map<string, FailureEntry>());

/**
 * Per-request opt-out of the breaker, spread into an axios request config:
 * `client.get(url, { ...BYPASS_BREAKER })`. For connection tests only. The
 * breaker is shared with the job worker and the enforcer and keyed by URL
 * alone, so a background failure would otherwise answer the Settings Test
 * button — and the server edit, which tests before it saves — without asking
 * the server, even when it is back or the edit (Skip TLS verification, say)
 * is what fixes it.
 */
export const BYPASS_BREAKER = { __bypassBreaker: true } as const;

declare module "axios" {
  interface AxiosRequestConfig {
    /** Set via `BYPASS_BREAKER`: the client sends the request even while its server is marked unreachable. */
    __bypassBreaker?: boolean;
  }
}

function normalize(baseURL: string): string {
  return stripTrailingSlashes(baseURL);
}

export class ServerUnreachableError extends Error {
  readonly code = "SERVER_UNREACHABLE";
  readonly baseURL: string;
  constructor(baseURL: string, lastErrorMessage?: string) {
    super(
      lastErrorMessage
        ? `Server ${baseURL} is unreachable (last error: ${lastErrorMessage})`
        : `Server ${baseURL} is unreachable`,
    );
    this.name = "ServerUnreachableError";
    this.baseURL = baseURL;
  }
}

export function markUnreachable(baseURL: string, error?: unknown): void {
  const message = error instanceof Error ? error.message : error != null ? String(error) : "";
  failures.set(normalize(baseURL), { at: Date.now(), message });
}

export function isUnreachable(baseURL: string): boolean {
  const entry = failures.get(normalize(baseURL));
  if (!entry) return false;
  if (Date.now() - entry.at > FAILURE_TTL_MS) {
    failures.delete(normalize(baseURL));
    return false;
  }
  return true;
}

export function clearUnreachable(baseURL: string): void {
  failures.delete(normalize(baseURL));
}

export function getLastFailureMessage(baseURL: string): string | undefined {
  return failures.get(normalize(baseURL))?.message;
}

export function _resetForTesting(): void {
  failures.clear();
}
