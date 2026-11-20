import { prisma } from "@/lib/db";

/**
 * Where the addresses a sign-in has succeeded from are kept between restarts
 * (`KnownSignInAddress`). The rate limiter holds the working copy in memory;
 * this is only its storage. See `rate-limiter.ts`, "Addresses a sign-in has
 * succeeded from".
 */

/** As long as the limiter remembers an address. */
export const KNOWN_ADDRESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** As many as the limiter holds. */
export const MAX_KNOWN_ADDRESSES = 10_000;

/** Every stored address still within its 30 days, most recent sign-in first, with when it expires. */
export async function loadKnownAddresses(now = Date.now()): Promise<Array<{ address: string; until: number }>> {
  const rows = await prisma.knownSignInAddress.findMany({
    where: { lastSignInAt: { gt: new Date(now - KNOWN_ADDRESS_TTL_MS) } },
    orderBy: { lastSignInAt: "desc" },
    take: MAX_KNOWN_ADDRESSES,
  });
  return rows.map((row) => ({ address: row.address, until: row.lastSignInAt.getTime() + KNOWN_ADDRESS_TTL_MS }));
}

/** Record a successful sign-in from `address`, and drop the rows that have aged out. */
export async function saveKnownAddress(address: string, now = Date.now()): Promise<void> {
  const lastSignInAt = new Date(now);
  await prisma.knownSignInAddress.upsert({
    where: { address },
    create: { address, lastSignInAt },
    update: { lastSignInAt },
  });
  await prisma.knownSignInAddress.deleteMany({
    where: { lastSignInAt: { lte: new Date(now - KNOWN_ADDRESS_TTL_MS) } },
  });
}
