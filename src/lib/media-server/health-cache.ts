const FAILURE_TTL_MS = 45_000;

interface FailureEntry {
  at: number;
  message: string;
}

const failures = new Map<string, FailureEntry>();

function normalize(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
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
