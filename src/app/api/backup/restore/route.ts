import { NextRequest } from "next/server";
import type { IronSession } from "iron-session";
import type { SessionData } from "@/lib/auth/session";
import { withSession } from "@/lib/auth/with-session";
import { restoreBackup, type RestoreProgress } from "@/lib/backup/backup-service";
import { validateRequest, backupRestoreSchema } from "@/lib/validation";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { appCache } from "@/lib/cache/memory-cache";
import { clearImageCache } from "@/lib/image-cache/image-cache";
import { hasRecentLogin } from "@/lib/auth/recent-login";
import { reauthRequired } from "@/lib/auth/reauth";

export const POST = withSession(async (session, request: NextRequest) => {
  // A restore replaces the account itself — its password hash, linked Plex
  // account and SSO identity — with whatever the file holds, so it needs a
  // recent sign-in like the other actions that change how the account can be
  // signed into (see recent-login.ts).
  if (!hasRecentLogin(session)) {
    return reauthRequired(session.userId, "Restoring a backup");
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

          // Clear in-memory cache so stale server/filter data isn't served
          appCache.clear();

          // Clear the on-disk image cache too — the MediaItem rows it was keyed
          // to were truncated and recreated, so the cached artwork (and its
          // stats) no longer correspond to the restored dataset.
          await clearImageCache().catch(() => {});

          // The restore revoked every session (`revokeRestoredSessions`), this
          // one included; clear its cookie so the browser goes to sign-in.
          // Widened from the checked session type, which pins it signed in.
          const cookie: IronSession<SessionData> = session;
          cookie.isLoggedIn = false;
          cookie.userId = undefined;
          await cookie.save();

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
});
