import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from "axios";
import { configureRetry } from "@/lib/http-retry";
import {
  isUnreachable,
  markUnreachable,
  clearUnreachable,
  getLastFailureMessage,
  ServerUnreachableError,
} from "./health-cache";
import { logger } from "@/lib/logger";
import { stripTrailingSlashes } from "@/lib/url-normalize";

/**
 * A media server's base URL without trailing slashes — the one spelling every
 * client uses for its axios `baseURL`, its circuit-breaker key and the URLs it
 * builds by hand. Plex kept the slash the user typed while Jellyfin/Emby
 * dropped it, so a Plex server saved as `http://plex:32400/` built image URLs
 * with a double slash and named itself differently in breaker errors.
 */
export function normalizeMediaServerUrl(baseURL: string): string {
  return stripTrailingSlashes(baseURL);
}

interface InstrumentOptions {
  /** The normalized base URL — the circuit breaker's key for this server. */
  baseURL: string;
  /** The log source, read per request (subclasses define it as a getter). */
  logPrefix: () => string;
  /** Runs on every request after the breaker check, e.g. to add auth headers. */
  beforeRequest?: (config: InternalAxiosRequestConfig) => void;
  /** Requests too frequent to log at debug level (every item fetch of a sync). */
  quiet?: (url: string | undefined) => boolean;
}

/**
 * The interceptor chain every media-server client installs, in the order it
 * must run:
 *
 *  1. the circuit breaker: a request to a server marked unreachable fails at
 *     once with `ServerUnreachableError`, unless it carries `BYPASS_BREAKER`;
 *  2. request timing and debug logging;
 *  3. on success, clearing the breaker; on failure, a debug log line;
 *  4. `configureRetry`, last, so it sees the raw AxiosError, with a terminal
 *     network failure marking the server unreachable.
 *
 * Kept in one place because Plex and Jellyfin/Emby each carried a copy and the
 * two had already drifted (the base-URL normalization, the error detail).
 */
export function instrumentMediaServerClient(client: AxiosInstance, options: InstrumentOptions): void {
  const { baseURL, logPrefix, beforeRequest, quiet } = options;

  client.interceptors.request.use((config) => {
    if (!config.__bypassBreaker && isUnreachable(baseURL)) {
      return Promise.reject(
        new ServerUnreachableError(baseURL, getLastFailureMessage(baseURL)),
      ) as never;
    }
    beforeRequest?.(config);
    (config as unknown as Record<string, unknown>).__startTime = Date.now();
    if (!quiet?.(config.url)) {
      logger.debug(logPrefix(), `${config.method?.toUpperCase()} ${config.url}`);
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      clearUnreachable(baseURL);
      if (!quiet?.(response.config.url)) {
        const start = (response.config as unknown as Record<string, unknown>).__startTime as number;
        const duration = start ? Date.now() - start : 0;
        logger.debug(logPrefix(), `${response.status} ${response.config.url} (${duration}ms)`);
      }
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error)) {
        const body = error.response?.data;
        const detail = typeof body === "string"
          ? body
          : body?.message ?? body?.title ?? body?.Message ?? body?.Title;
        logger.debug(
          logPrefix(),
          `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}`,
          { message: error.message, ...(detail ? { detail } : {}) },
        );
      }
      return Promise.reject(error);
    },
  );

  configureRetry(client, logPrefix, logger, {
    onTerminalNetworkError: (error) => markUnreachable(baseURL, error),
  });
}
