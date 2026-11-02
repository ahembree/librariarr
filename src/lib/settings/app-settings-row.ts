import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Makes the user's settings row if it is missing, safe to run side by side.
 * Prisma runs an upsert whose `update` is empty as a read then a create, so two
 * at once both saw no row and the second create failed on the unique userId;
 * ON CONFLICT DO NOTHING lets the database settle it.
 */
export async function ensureAppSettingsRow(
  userId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "AppSettings" ("id", "userId", "updatedAt")
    VALUES (${randomUUID()}, ${userId}, NOW())
    ON CONFLICT ("userId") DO NOTHING`;
}
