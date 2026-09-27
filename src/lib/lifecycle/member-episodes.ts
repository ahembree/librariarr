import { prisma } from "@/lib/db";
import { loneMemberId, type MemberEpisode, type MemberScope } from "@/lib/lifecycle/action-target";

/**
 * The `memberEpisodes` that name these actions (see `actionTargetTitle`): the
 * one episode each acts on, where that is not the item it is stored against
 * (`loneMemberId`). One query for the whole batch; none when no action needs
 * one. An episode that no longer exists is absent, and its action is then
 * named by its show.
 */
export async function loadMemberEpisodes(
  actions: MemberScope[],
): Promise<Map<string, MemberEpisode>> {
  const ids = [...new Set(actions.map(loneMemberId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.mediaItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, seasonNumber: true, episodeNumber: true },
  });
  return new Map(rows.map(({ id, ...episode }) => [id, episode]));
}
