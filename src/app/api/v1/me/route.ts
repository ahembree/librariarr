import { NextResponse } from "next/server";
import { withApiKey } from "@/lib/api/v1";
import { serializeApiKey } from "@/lib/auth/api-key";

/**
 * Self-check endpoint: reports the calling key's own metadata so an integration
 * can discover what it is allowed to do (and when it stops working) without the
 * admin having to relay it out of band.
 *
 * `lastUsedAt` is the value stored before this request — the touch that this
 * call triggers is throttled and fire-and-forget, so it is not reflected here.
 */
export const GET = withApiKey(async (_request, { apiKey }) => {
  return NextResponse.json({ key: serializeApiKey(apiKey) });
});
