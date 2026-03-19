import { logger } from "@/lib/logger";

/**
 * Detect PostgreSQL deadlock errors (code 40P01) surfaced through Prisma.
 *
 * Prisma wraps raw-query errors in PrismaClientKnownRequestError with
 * code P2010 ("Raw query failed") and stashes the PG code in `meta`.
 * Interactive-transaction deadlocks surface as P2034.
 */
function isDeadlock(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;

  // Prisma P2034 — "Transaction failed due to a write conflict or a deadlock"
  if (e.code === "P2034") return true;

  // Raw-query wrapper: Prisma P2010 with PG code 40P01 in meta
  if (e.code === "P2010") {
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta?.code === "40P01") return true;
  }

  // Fallback: check the message for the PG error string
  if (typeof e.message === "string" && e.message.includes("deadlock detected"))
    return true;

  return false;
}

/**
 * Retry a database operation on deadlock with exponential backoff.
 *
 * PostgreSQL aborts one of the deadlocking transactions; the application
 * should simply retry. Three attempts with 100/200/400ms delays covers
 * typical transient contention during concurrent syncs.
 */
export async function withDeadlockRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isDeadlock(err) && attempt <= maxRetries) {
        const delay = 100 * Math.pow(2, attempt - 1); // 100, 200, 400ms
        logger.warn(
          "DB",
          `Deadlock detected in ${label}, retrying (attempt ${attempt}/${maxRetries}) after ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}
