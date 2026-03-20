import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { restoreBackup, type RestoreProgress } from "@/lib/backup/backup-service";
import { validateRequest, backupRestoreSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";

export async function POST(request: NextRequest) {
  // Only allowed when no users exist (initial setup)
  const userCount = await prisma.user.count();
  if (userCount > 0) {
    return Response.json({ error: "Setup already completed" }, { status: 403 });
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
