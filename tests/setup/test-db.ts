import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let _prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}

/**
 * Delete all data from tables in reverse-dependency order.
 */
export async function cleanDatabase() {
  const prisma = getTestPrisma();
  await prisma.lifecycleAction.deleteMany();
  await prisma.logEntry.deleteMany();
  await prisma.mediaStream.deleteMany();
  await prisma.mediaItemExternalId.deleteMany();
  await prisma.mediaItem.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.library.deleteMany();
  await prisma.ruleSet.deleteMany();
  await prisma.sonarrInstance.deleteMany();
  await prisma.radarrInstance.deleteMany();
  await prisma.lidarrInstance.deleteMany();
  await prisma.blackoutSchedule.deleteMany();
  await prisma.prerollSchedule.deleteMany();
  await prisma.prerollPreset.deleteMany();
  await prisma.savedQuery.deleteMany();
  await prisma.seerrInstance.deleteMany();
  await prisma.appSettings.deleteMany();
  await prisma.mediaServer.deleteMany();
  await prisma.user.deleteMany();
}

export async function disconnectTestDb() {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}
