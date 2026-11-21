import { prisma } from "@/lib/db";
import { appCache } from "@/lib/cache/memory-cache";

/**
 * The display prefixes of the API keys that exist, cached for a minute.
 *
 * The lookup floor (`apiKeyUnknownLookupFloor`) bounds how many keys that do
 * not exist are looked up per minute. Once it was full, EVERY key that had not
 * authenticated in the last 15 minutes was refused, real ones included — so
 * about seventeen random well-formed keys a second, from anyone, kept every
 * integration that polls less often than that locked out, and after a restart
 * every integration at all.
 *
 * A key is found by its prefix, and at most 50 keys exist. While the floor is
 * full the guard asks this set instead of the database: a key whose prefix is
 * not issued is refused as before, at the cost of one cached query a minute,
 * and a key whose prefix IS issued goes on to be verified (bounded by the
 * verification floor). Someone who does not know a real prefix — it is shown
 * only in Settings — can no longer shut a real key out.
 *
 * Created and deleted keys drop the cache, so a key made during a flood works
 * at once.
 */
const CACHE_KEY = "api-key-prefixes";
const TTL_MS = 60 * 1000;

export function knownApiKeyPrefixes(): Promise<ReadonlySet<string>> {
  return appCache.getOrSet<ReadonlySet<string>>(
    CACHE_KEY,
    async () => new Set((await prisma.apiKey.findMany({ select: { prefix: true } })).map((row) => row.prefix)),
    TTL_MS,
  );
}

/** Call after creating or deleting a key. */
export function invalidateKnownApiKeyPrefixes(): void {
  appCache.invalidate(CACHE_KEY);
}
