import { prisma } from "@/lib/db";

/**
 * Whether the user has added any media server — where the login page sends
 * them next (`/` with one, `/onboarding` without). The sign-in routes answer
 * it as `hasServers`, so the page need not ask `/api/servers` (every server
 * with its libraries' item counts and latest sync jobs) after signing in just
 * to count them.
 */
export async function userHasServers(userId: string): Promise<boolean> {
  return (await prisma.mediaServer.count({ where: { userId } })) > 0;
}
