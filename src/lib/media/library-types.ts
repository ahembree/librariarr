import { prisma } from "@/lib/db";

export interface LibraryTypes {
  /** Types with at least one enabled library on an enabled server. */
  types: string[];
  /** Types with any library on an enabled server, enabled or not. */
  allTypes: string[];
}

/**
 * Which library types the admin's enabled servers hold — what the sidebar's
 * Library links and the dashboard's tiles are built from. Shared by
 * `GET /api/media/library-types` and the authenticated layout's read.
 */
export async function loadLibraryTypes(userId: string): Promise<LibraryTypes> {
  const servers = await prisma.mediaServer.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });
  const serverIds = servers.map((s) => s.id);
  if (serverIds.length === 0) return { types: [], allTypes: [] };

  const [enabledLibraries, allLibraries] = await Promise.all([
    prisma.library.findMany({
      where: { mediaServerId: { in: serverIds }, enabled: true },
      select: { type: true },
      distinct: ["type"],
    }),
    prisma.library.findMany({
      where: { mediaServerId: { in: serverIds } },
      select: { type: true },
      distinct: ["type"],
    }),
  ]);

  return {
    types: enabledLibraries.map((l) => l.type),
    allTypes: allLibraries.map((l) => l.type),
  };
}
