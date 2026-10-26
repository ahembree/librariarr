import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export type ArrMediaType = "MOVIE" | "SERIES" | "MUSIC";
export type ArrFamily = "RADARR" | "SONARR" | "LIDARR";

/** The only Arr family whose records correspond to each library type. */
export const ARR_FAMILY_FOR_TYPE: Record<ArrMediaType, ArrFamily> = {
  MOVIE: "RADARR",
  SERIES: "SONARR",
  MUSIC: "LIDARR",
};

export const ARR_TYPE_FOR_FAMILY: Record<ArrFamily, ArrMediaType> = {
  RADARR: "MOVIE",
  SONARR: "SERIES",
  LIDARR: "MUSIC",
};

/** The columns an instance lookup filters on. */
interface ArrInstanceWhere {
  id?: string;
  userId?: string;
  enabled?: boolean;
}

type InstanceSelect = Prisma.RadarrInstanceSelect;
type InstancePayload<S extends InstanceSelect | undefined> = S extends InstanceSelect
  ? Prisma.RadarrInstanceGetPayload<{ select: S }>
  : Prisma.RadarrInstanceGetPayload<object>;

/**
 * The Prisma delegate for a family. The three instance models have the same
 * scalar columns, so one is typed through the Radarr delegate; only scalar
 * filters and selects (`ArrInstanceWhere`) are ever passed through it.
 */
function delegateFor(family: ArrFamily): typeof prisma.radarrInstance {
  if (family === "RADARR") return prisma.radarrInstance;
  if (family === "SONARR") return prisma.sonarrInstance as unknown as typeof prisma.radarrInstance;
  return prisma.lidarrInstance as unknown as typeof prisma.radarrInstance;
}

/** The first instance of `family` matching `where`, or null. */
export async function findArrInstance<S extends InstanceSelect | undefined = undefined>(
  family: ArrFamily,
  where: ArrInstanceWhere,
  select?: S,
): Promise<InstancePayload<S> | null> {
  const row = await delegateFor(family).findFirst({ where, ...(select ? { select } : {}) });
  return row as InstancePayload<S> | null;
}

/** Every instance of `family` matching `where`, oldest first (ties by id). */
export async function findArrInstances(
  family: ArrFamily,
  where: ArrInstanceWhere,
): Promise<Prisma.RadarrInstanceGetPayload<object>[]> {
  return delegateFor(family).findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** How many instances of `family` match `where`. */
export async function countArrInstances(family: ArrFamily, where: ArrInstanceWhere): Promise<number> {
  return delegateFor(family).count({ where });
}

/**
 * Which family an instance id belongs to, with its row — for a configuration
 * that names an instance without a family (a tags-only "Do Nothing" action).
 * The three tables are probed together; ids are cuids, so at most one answers.
 */
export async function familyOfArrInstance(
  instanceId: string,
  userId?: string,
): Promise<{ family: ArrFamily; instance: Prisma.RadarrInstanceGetPayload<object> } | null> {
  const where = { id: instanceId, ...(userId ? { userId } : {}) };
  const families: ArrFamily[] = ["RADARR", "SONARR", "LIDARR"];
  const rows = await Promise.all(families.map((family) => findArrInstance(family, where)));
  const index = rows.findIndex((row) => row !== null);
  return index === -1 ? null : { family: families[index], instance: rows[index]! };
}
