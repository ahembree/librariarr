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

function isRetryable(error: AxiosError): boolean {
  // Network-level errors — request never reached the server, safe to retry any method
  if (!error.response) {
    if (error.code && RETRYABLE_NETWORK_CODES.has(error.code)) return true;
    // SSL/TLS mid-connection failures
    if (
      error.message?.includes("decryption failed") ||
      error.message?.includes("bad record mac") ||
      error.message?.includes("ssl3_get_record")
    )
      return true;
    return false;
  }
  // Server errors — only retry idempotent methods
  if ([502, 503, 504].includes(error.response.status)) {
    const method = error.config?.method?.toUpperCase();
    return method === "GET" || method === "HEAD";
  }
  return false;
}

function isNetworkError(error: AxiosError): boolean {
  // No HTTP response was received — request never completed at the protocol level.
  return !error.response;
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
    if (!config || !isRetryable(error)) {
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
