import type { AxiosError, AxiosInstance } from "axios";

const MAX_RETRIES = 3;

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EPROTO",
  "EAI_AGAIN",
]);

// Failures that happen before a request can have reached the server (a DNS
// lookup that did not resolve). Only these are safe to repeat for a write.
const PRE_SEND_CODES = new Set(["EAI_AGAIN"]);

function isIdempotent(error: AxiosError): boolean {
  const method = error.config?.method?.toUpperCase();
  // Treat an unknown method as non-idempotent (conservative — don't double-apply).
  return method === "GET" || method === "HEAD";
}

function isRetryable(error: AxiosError): boolean {
  // Network-level errors — no HTTP response was received.
  if (!error.response) {
    // A timeout, reset, broken pipe or TLS failure mid-exchange does NOT prove
    // the request never reached the server — it may already have been received
    // and applied. Repeating a write then applies it twice: a second quality
    // profile created under the same name (Sonarr does not refuse duplicates),
    // or a bulk episode-file delete sent again after it succeeded, which Sonarr
    // answers with a 500 and the action records as FAILED. So only reads retry
    // these; a write retries only a failure that provably preceded sending.
    if (error.code && RETRYABLE_NETWORK_CODES.has(error.code)) {
      return isIdempotent(error) || PRE_SEND_CODES.has(error.code);
    }
    // SSL/TLS mid-connection failures
    if (
      error.message?.includes("decryption failed") ||
      error.message?.includes("bad record mac") ||
      error.message?.includes("ssl3_get_record")
    )
      return isIdempotent(error);
    return false;
  }
  // Server errors — only retry idempotent methods
  if ([502, 503, 504].includes(error.response.status)) {
    return isIdempotent(error);
  }
  return false;
}

function isNetworkError(error: AxiosError): boolean {
  // No HTTP response was received — request never completed at the protocol level.
  return !error.response;
}

/**
 * Per-request opt-out, spread into an axios request config:
 * `client.get(url, { ...NO_RETRY })`. For interactive connection probes (the
 * settings "Test" buttons), which must report the first failure promptly — a
 * timing-out host would otherwise keep the user waiting through every retry
 * (4 × the client timeout plus backoff) before hearing it failed.
 */
export const NO_RETRY = { __noRetry: true } as const;

declare module "axios" {
  interface AxiosRequestConfig {
    /** Set via `NO_RETRY`: `configureRetry` rethrows this request's failure as-is. */
    __noRetry?: boolean;
  }
}

export interface ConfigureRetryOptions {
  /**
   * Called when a network-level error is final — either retries are exhausted,
   * or the error is a non-retryable network error (e.g., ECONNREFUSED, ENOTFOUND).
   * Use to mark a server as unreachable in a health cache.
   */
  onTerminalNetworkError?: (error: AxiosError) => void;
}

/**
 * Adds automatic retry for transient network/TLS errors to an axios instance.
 * Retries up to 3 times with linear backoff (1s, 2s, 3s).
 */
export function configureRetry(
  instance: AxiosInstance,
  logPrefix: string | (() => string),
  log: { warn: (prefix: string, msg: string) => void },
  options?: ConfigureRetryOptions,
): void {
  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    // Circuit-breaker rejections from a request interceptor never reached the
    // network — propagate without retrying or refreshing the failure timestamp.
    if ((error as unknown as { code?: string }).code === "SERVER_UNREACHABLE") {
      throw error;
    }

    // Mark unreachable on the *first* network error, not just after retries are
    // exhausted. The retry will go through the request interceptor and short-circuit
    // via the breaker, so concurrent in-flight requests fail at ~15s (single timeout)
    // instead of ~51s (full retry cycle). The breaker self-clears on the next success.
    if (isNetworkError(error)) options?.onTerminalNetworkError?.(error);

    const config = error.config;
    if (!config || config.__noRetry || !isRetryable(error)) {
      throw error;
    }

    const meta = config as unknown as Record<string, unknown>;
    const retryCount = ((meta.__retryCount as number) ?? 0) + 1;
    if (retryCount > MAX_RETRIES) {
      throw error;
    }

    meta.__retryCount = retryCount;
    const delay = retryCount * 1000;
    const prefix = typeof logPrefix === "function" ? logPrefix() : logPrefix;
    log.warn(
      prefix,
      `Retryable error (attempt ${retryCount}/${MAX_RETRIES}): ${error.code ?? error.message} — retrying in ${delay}ms`,
    );
    await new Promise((r) => setTimeout(r, delay));
    return instance.request(config);
  });
}
