import { NextRequest, NextResponse } from "next/server";
import { withSession } from "@/lib/auth/with-session";
import { runJobNow } from "@/lib/jobs/run-now";
import { logger } from "@/lib/logger";
import { validateRequest, runJobSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export const POST = withSession(async (session, request: NextRequest) => {
  const { data, error } = await validateRequest(request, runJobSchema);
  if (error) return error;
  const { job } = data;

  try {
    const result = await runJobNow(session.userId, job, "from Settings (Run now)");
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ queued: true });
  } catch (error) {
    logger.error("Scheduler", `Manual ${job} failed`, { error: String(error) });
    return NextResponse.json({ error: `Job failed: ${sanitizeErrorDetail(String(error))}` }, { status: 500 });
  }
});
