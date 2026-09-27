import { prisma } from "@/lib/db";
import type { MemberEpisode } from "@/lib/lifecycle/action-target";

/**
 * The title and SxxExx of each given episode, for naming a series action that
 * acts on exactly one episode other than the one it is stored against (the
 * `memberEpisode` of `actionTargetTitle`; the ids come from `loneMemberId`).
 * One query for a whole batch; nothing at all when there is nothing to name.
 * An id that no longer exists is simply absent, and the action is then named
 * by its show.
 */
export async function loadMemberEpisodes(
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, MemberEpisode>> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.mediaItem.findMany({
    where: { id: { in: unique } },
    select: { id: true, title: true, seasonNumber: true, episodeNumber: true },
  });
  return new Map(
    rows.map((r) => [r.id, { title: r.title, seasonNumber: r.seasonNumber, episodeNumber: r.episodeNumber }]),
  );
}
