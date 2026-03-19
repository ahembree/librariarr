import { NextRequest } from "next/server";
import { expect } from "vitest";
import { getTestPrisma } from "./test-db";

// ---- Route Handler Invocation ----

export function createTestRequest(
  url: string,
  options?: {
    method?: string;
    body?: unknown;
    searchParams?: Record<string, string>;
  }
): NextRequest {
  const baseUrl = "http://localhost:3000";
  const urlObj = new URL(url, baseUrl);

  if (options?.searchParams) {
    for (const [key, value] of Object.entries(options.searchParams)) {
      urlObj.searchParams.set(key, value);
    }
  }

  const init: RequestInit = {
    method: options?.method ?? "GET",
  };

  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NextRequest(urlObj, init as any);
}

/**
 * Call a route handler that takes no dynamic params.
 */
export async function callRoute(
  handler: (request: NextRequest) => Promise<Response>,
  options?: {
    url?: string;
    method?: string;
    body?: unknown;
    searchParams?: Record<string, string>;
  }
): Promise<Response> {
  const request = createTestRequest(options?.url ?? "/api/test", options);
  return handler(request);
}

/**
 * Call a route handler with dynamic route params.
 * Next.js 16 signature: handler(request, { params: Promise<TParams> })
 */
export async function callRouteWithParams<
  TParams extends Record<string, string>,
>(
  handler: (
    request: NextRequest,
    context: { params: Promise<TParams> }
  ) => Promise<Response>,
  params: TParams,
  options?: {
    url?: string;
    method?: string;
    body?: unknown;
    searchParams?: Record<string, string>;
  }
): Promise<Response> {
  const request = createTestRequest(options?.url ?? "/api/test", options);
  return handler(request, { params: Promise.resolve(params) });
}

/**
 * Parse JSON response and assert status code.
 */
export async function expectJson<T = unknown>(
  response: Response,
  expectedStatus = 200
): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

// ---- Data Factories ----

let counter = 0;
function unique() {
  return `${Date.now()}-${++counter}`;
}

export async function createTestUser(
  overrides?: Partial<{
    plexId: string;
    plexToken: string;
    username: string;
    email: string;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.user.create({
    data: {
      plexId: overrides?.plexId ?? `plex-${unique()}`,
      plexToken: overrides?.plexToken ?? "test-plex-token",
      username: overrides?.username ?? "testuser",
      email: overrides?.email ?? "test@example.com",
    },
  });
}

export async function createTestServer(
  userId: string,
  overrides?: Partial<{
    name: string;
    url: string;
    accessToken: string;
    machineId: string;
    tlsSkipVerify: boolean;
    enabled: boolean;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.mediaServer.create({
    data: {
      userId,
      type: "PLEX",
      name: overrides?.name ?? "Test Server",
      url: overrides?.url ?? "http://plex.test:32400",
      accessToken: overrides?.accessToken ?? "test-access-token",
      machineId: overrides?.machineId ?? `machine-${unique()}`,
      tlsSkipVerify: overrides?.tlsSkipVerify ?? false,
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestLibrary(
  mediaServerId: string,
  overrides?: Partial<{
    key: string;
    title: string;
    type: "MOVIE" | "SERIES" | "MUSIC";
    enabled: boolean;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.library.create({
    data: {
      mediaServerId,
      key: overrides?.key ?? `lib-${unique()}`,
      title: overrides?.title ?? "Test Library",
      type: overrides?.type ?? "MOVIE",
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestMediaItem(
  libraryId: string,
  overrides?: Partial<{
    ratingKey: string;
    title: string;
    year: number;
    type: "MOVIE" | "SERIES" | "MUSIC";
    summary: string;
    thumbUrl: string;
    resolution: string;
    videoCodec: string;
    audioCodec: string;
    dynamicRange: string;
    audioProfile: string;
    fileSize: bigint;
    playCount: number;
    lastPlayedAt: Date;
    addedAt: Date;
    parentTitle: string;
    albumTitle: string;
    seasonNumber: number;
    episodeNumber: number;
    container: string;
    duration: number;
    genres: string[];
    contentRating: string;
    studio: string;
    filePath: string;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.mediaItem.create({
    data: {
      libraryId,
      ratingKey: overrides?.ratingKey ?? `rk-${unique()}`,
      title: overrides?.title ?? "Test Movie",
      year: overrides?.year ?? 2024,
      type: overrides?.type ?? "MOVIE",
      summary: overrides?.summary,
      thumbUrl: overrides?.thumbUrl,
      resolution: overrides?.resolution ?? "1080p",
      videoCodec: overrides?.videoCodec ?? "h264",
      audioCodec: overrides?.audioCodec ?? "aac",
      dynamicRange: overrides?.dynamicRange ?? "SDR",
      audioProfile: overrides?.audioProfile,
      fileSize: overrides?.fileSize ?? BigInt(1073741824),
      playCount: overrides?.playCount ?? 0,
      lastPlayedAt: overrides?.lastPlayedAt,
      addedAt: overrides?.addedAt ?? new Date(),
      parentTitle: overrides?.parentTitle,
      albumTitle: overrides?.albumTitle,
      seasonNumber: overrides?.seasonNumber,
      episodeNumber: overrides?.episodeNumber,
      container: overrides?.container ?? "mkv",
      duration: overrides?.duration ?? 7200000,
      genres: overrides?.genres,
      contentRating: overrides?.contentRating,
      studio: overrides?.studio,
      filePath: overrides?.filePath,
    },
  });
}

export async function createTestRuleSet(
  userId: string,
  overrides?: Partial<{
    name: string;
    type: "MOVIE" | "SERIES" | "MUSIC";
    rules: unknown;
    enabled: boolean;
    seriesScope: boolean;
    actionEnabled: boolean;
    actionType: string;
    actionDelayDays: number;
    arrInstanceId: string;
    addImportExclusion: boolean;
    addArrTags: string[];
    removeArrTags: string[];
    collectionEnabled: boolean;
    collectionName: string;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.ruleSet.create({
    data: {
      userId,
      name: overrides?.name ?? `Rule Set ${unique()}`,
      type: overrides?.type ?? "MOVIE",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rules: (overrides?.rules ?? []) as any,
      enabled: overrides?.enabled ?? true,
      seriesScope: overrides?.seriesScope,
      actionEnabled: overrides?.actionEnabled ?? false,
      actionType: overrides?.actionType ?? null,
      actionDelayDays: overrides?.actionDelayDays,
      arrInstanceId: overrides?.arrInstanceId ?? null,
      addImportExclusion: overrides?.addImportExclusion,
      addArrTags: overrides?.addArrTags,
      removeArrTags: overrides?.removeArrTags,
      collectionEnabled: overrides?.collectionEnabled,
      collectionName: overrides?.collectionName,
    },
  });
}

export async function createTestSonarrInstance(
  userId: string,
  overrides?: Partial<{ name: string; url: string; apiKey: string; enabled: boolean }>
) {
  const prisma = getTestPrisma();
  return prisma.sonarrInstance.create({
    data: {
      userId,
      name: overrides?.name ?? "Test Sonarr",
      url: overrides?.url ?? "http://sonarr.test:8989",
      apiKey: overrides?.apiKey ?? "test-api-key",
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestRadarrInstance(
  userId: string,
  overrides?: Partial<{ name: string; url: string; apiKey: string; enabled: boolean }>
) {
  const prisma = getTestPrisma();
  return prisma.radarrInstance.create({
    data: {
      userId,
      name: overrides?.name ?? "Test Radarr",
      url: overrides?.url ?? "http://radarr.test:7878",
      apiKey: overrides?.apiKey ?? "test-api-key",
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestLidarrInstance(
  userId: string,
  overrides?: Partial<{ name: string; url: string; apiKey: string; enabled: boolean }>
) {
  const prisma = getTestPrisma();
  return prisma.lidarrInstance.create({
    data: {
      userId,
      name: overrides?.name ?? "Test Lidarr",
      url: overrides?.url ?? "http://lidarr.test:8686",
      apiKey: overrides?.apiKey ?? "test-api-key",
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestSeerrInstance(
  userId: string,
  overrides?: Partial<{ name: string; url: string; apiKey: string; type: string; enabled: boolean }>
) {
  const prisma = getTestPrisma();
  return prisma.seerrInstance.create({
    data: {
      userId,
      name: overrides?.name ?? "Test Seerr",
      url: overrides?.url ?? "http://seerr.test:5055",
      apiKey: overrides?.apiKey ?? "test-api-key",
      enabled: overrides?.enabled ?? true,
    },
  });
}

export async function createTestExternalId(
  mediaItemId: string,
  source: string,
  externalId: string
) {
  const prisma = getTestPrisma();
  return prisma.mediaItemExternalId.create({
    data: { mediaItemId, source, externalId },
  });
}

export async function createTestMediaStream(
  mediaItemId: string,
  overrides: Partial<{
    streamType: number;
    index: number;
    codec: string;
    profile: string;
    bitrate: number;
    isDefault: boolean;
    displayTitle: string;
    extendedDisplayTitle: string;
    language: string;
    languageCode: string;
    width: number;
    height: number;
    frameRate: number;
    scanType: string;
    colorPrimaries: string;
    colorRange: string;
    chromaSubsampling: string;
    bitDepth: number;
    videoRangeType: string;
    channels: number;
    samplingRate: number;
    audioChannelLayout: string;
    forced: boolean;
  }> = {},
) {
  const prisma = getTestPrisma();
  return prisma.mediaStream.create({
    data: {
      mediaItemId,
      streamType: overrides.streamType ?? 1,
      ...overrides,
    },
  });
}

export async function createTestRuleMatch(
  ruleSetId: string,
  mediaItemId: string,
  itemData: Record<string, unknown> = {},
) {
  const prisma = getTestPrisma();
  return prisma.ruleMatch.create({
    data: {
      ruleSetId,
      mediaItemId,
      itemData: itemData as object,
      detectedAt: new Date(),
    },
  });
}

export async function createTestLogEntry(
  overrides?: Partial<{
    level: "DEBUG" | "INFO" | "WARN" | "ERROR";
    category: "BACKEND" | "API" | "DB";
    source: string;
    message: string;
  }>
) {
  const prisma = getTestPrisma();
  return prisma.logEntry.create({
    data: {
      level: overrides?.level ?? "INFO",
      category: overrides?.category ?? "BACKEND",
      source: overrides?.source ?? "test",
      message: overrides?.message ?? "test log message",
    },
  });
}
