import { NextResponse } from "next/server";
import { withApiKey, v1Error } from "@/lib/api/v1";
import { prisma } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/client";
import { MAIN_QUEUE, TASK_SYNC_SERVER } from "@/lib/jobs/constants";
import { validateRequest, v1SyncTriggerSchema } from "@/lib/validation";
import { apiLogger } from "@/lib/logger";

/**
 * Trigger a library sync.
 *
 * Always enqueued as a durable job on the serial main queue — never run inline.
 * A sync is minutes of work against a remote server; running it in the request
 * would hold the connection open and, worse, let two API calls scan the same
 * server at once. The `sync:<serverId>` job key collapses repeat calls into one
 * queued run.
 *
 * With no `serverId` this syncs every *enabled* server. An explicit `serverId`
 * is honoured even when that server is disabled: naming it is an explicit
 * instruction, not a sweep.
 */
export const POST = withApiKey(
  async (request, { userId, apiKey }) => {
    const { data, error } = await validateRequest(request, v1SyncTriggerSchema, {
      allowEmptyBody: true,
    });
    if (error) return error;

    const { serverId } = data;

    const servers = await prisma.mediaServer.findMany({
      where: serverId ? { id: serverId, userId } : { userId, enabled: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    });

    // A named server that produced no row either does not exist or belongs to
    // nobody the key can reach — the same 404 either way, so the response can't
    // be used to probe for ids.
    if (serverId && servers.length === 0) {
      return v1Error("Server not found", 404);
    }

    const results: { id: string; name: string; status: "enqueued" | "skipped" }[] = [];
    let enqueued = 0;
    let skipped = 0;

    for (const server of servers) {
      const active = await prisma.syncJob.findFirst({
        where: { mediaServerId: server.id, status: { in: ["RUNNING", "PENDING"] } },
        select: { id: true },
      });
      if (active) {
        skipped++;
        results.push({ id: server.id, name: server.name, status: "skipped" });
        continue;
      }

      const ok = await enqueueJob(
        TASK_SYNC_SERVER,
        { serverId: server.id },
        { jobKey: `sync:${server.id}`, queueName: MAIN_QUEUE, maxAttempts: 3 },
      );
      if (!ok) {
        // Surfaced as a hard failure rather than folded into `skipped`, which
        // means "already running" and would hide a broken queue. Retrying is
        // safe: the job key dedupes anything already enqueued above.
        return v1Error("Failed to enqueue sync job", 500);
      }

      enqueued++;
      results.push({ id: server.id, name: server.name, status: "enqueued" });
    }

    apiLogger.info("api-v1", "Sync triggered via API key", {
      keyName: apiKey.name,
      enqueued,
      skipped,
    });

    return NextResponse.json({ enqueued, skipped, servers: results });
  },
  { scope: "READ_WRITE" },
);
