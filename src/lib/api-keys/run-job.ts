import { NextResponse } from "next/server";
import { runJobNow, type RunNowJob } from "@/lib/jobs/run-now";
import { logger } from "@/lib/logger";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { getApiKeyPrincipal } from "./principal";

/**
 * `POST /api/v1/jobs/{sync|detection|execution}` — queue a scheduled job now,
 * exactly as the Settings "Run now" buttons do. One endpoint per job rather
 * than one taking `{ job }`, because each needs its own scope: queueing a sync
 * is harmless, queueing lifecycle execution can delete media.
 *
 * Answers 202 with `jobs`, how many were queued: the job is queued on the
 * serial main queue and may wait behind whatever is running, and its outcome
 * is not part of this response. A sync queues one job per enabled server not
 * already syncing, so `jobs` is 0 when every server already is. An execution
 * run queued here is held — nothing deleted, everything left pending — when it
 * would exceed the API's destructive limits (see `limits.ts`).
 */
export async function runJobForApiKey(job: RunNowJob): Promise<Response> {
  const principal = getApiKeyPrincipal();
  if (!principal) {
    // Only reachable if a route forgot `withApiKey` — fail closed.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runJobNow(principal.userId, job, `via API key "${principal.name}"`, {
      viaApiKey: principal.name,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ queued: true, jobs: result.jobs }, { status: 202 });
  } catch (error) {
    logger.error("Scheduler", `API-triggered ${job} failed`, { error: String(error) });
    return NextResponse.json(
      { error: `Job failed: ${sanitizeErrorDetail(String(error))}` },
      { status: 500 },
    );
  }
}
