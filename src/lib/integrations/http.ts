import axios, { type AxiosInstance } from "axios";
import { logger } from "@/lib/logger";
import { IntegrationError } from "@/lib/integration-error";
import { configureRetry } from "@/lib/http-retry";

interface IntegrationHttpOptions {
  /** Per-request timeout in milliseconds. */
  timeout: number;
}

/**
 * The axios instance every integration client (Radarr, Sonarr, Lidarr, Seerr,
 * Tracearr, the TRaSH guide client) talks through: trailing slashes stripped
 * from the base URL (only those — an instance may sit under a base path), a
 * start time stamped on each request, transport retries, and every axios
 * failure converted into an `IntegrationError` whose debug line carries the
 * request's duration.
 *
 * The retry is registered BEFORE the conversion, and that order is the reason
 * this lives in one place: axios runs response interceptors in registration
 * order and the retry needs the raw AxiosError (`config`/`response`).
 * Registered after the converter, the retry only ever saw an IntegrationError
 * and rethrew every failure — which is how all six clients once shipped
 * (`tests/unit/integration-clients-retry.test.ts` drives the real chain).
 */
export function createIntegrationHttp(
  appName: string,
  baseURL: string,
  headers: Record<string, string>,
  opts: IntegrationHttpOptions,
): AxiosInstance {
  const client = axios.create({
    baseURL: baseURL.replace(/\/+$/, ""),
    headers,
    timeout: opts.timeout,
  });

  client.interceptors.request.use((config) => {
    (config as unknown as Record<string, unknown>).__startTime = Date.now();
    return config;
  });

  configureRetry(client, appName, logger);

  client.interceptors.response.use(
    (response) => response,
    (error) => {
      if (axios.isAxiosError(error)) {
        const start = (error.config as unknown as Record<string, unknown>)?.__startTime as
          | number
          | undefined;
        const duration = start ? ` (${Date.now() - start}ms)` : "";
        logger.debug(
          appName,
          `ERROR ${error.response?.status ?? "NETWORK"} ${error.config?.url}${duration}`,
          { message: error.message },
        );
        // A concise error rather than the multi-page AxiosError dump; the
        // AxiosError rides along as `cause` for callers that need its body.
        return Promise.reject(new IntegrationError(appName, error));
      }
      return Promise.reject(error);
    },
  );

  return client;
}

/** The headers the *arr apps and Seerr authenticate and negotiate with. */
export function apiKeyHeaders(apiKey: string): Record<string, string> {
  return {
    "X-Api-Key": apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}
