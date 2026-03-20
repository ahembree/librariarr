import { NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { restoreBackup, type RestoreProgress } from "@/lib/backup/backup-service";
import { validateRequest, backupRestoreSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, backupRestoreSchema);
  if (error) return error;

  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: RestoreProgress & { type: "progress" } | { type: "complete" } | { type: "error"; message: string }) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          } catch {
            // Stream may be closed
          }
        };

        try {
          await restoreBackup(data.filename, data.passphrase, (progress) => {
            send({ type: "progress", ...progress });
          });

          // Destroy current session since user data may have changed
          session.isLoggedIn = false;
          session.userId = undefined;
          await session.save();

          send({ type: "complete" });
        } catch (err) {
          send({ type: "error", message: sanitizeErrorDetail(err instanceof Error ? err.message : "Restore failed") ?? "Restore failed" });
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
