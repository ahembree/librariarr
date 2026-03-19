import type { Prisma } from "@/generated/prisma/client";

// Map standardized resolution labels to raw DB patterns
const RESOLUTION_DB_VALUES: Record<string, string[]> = {
  "4K": ["4k", "2160", "2160p"],
  "1080P": ["1080", "1080p"],
  "720P": ["720", "720p"],
  "480P": ["480", "480p"],
  "SD": ["sd", "360", "360p"],
};

/**
 * Parse a multi-select filter value. Values are pipe-separated, e.g. "4K|1080P".
 * Returns null if value is null/empty, or an array of values.
 */
export function parseMulti(value: string | null): string[] | null {
  if (!value) return null;
  const vals = value.split("|").filter(Boolean);
  return vals.length > 0 ? vals : null;
}

/**
 * Build Prisma WHERE clauses from common filter search params.
 * Handles multi-select (pipe-separated), range filters, and date filters.
 */
export function applyCommonFilters(
  where: Prisma.MediaItemWhereInput,
  params: URLSearchParams
): void {
  const andClauses: Prisma.MediaItemWhereInput[] = Array.isArray(where.AND)
    ? [...where.AND]
    : where.AND
      ? [where.AND as Prisma.MediaItemWhereInput]
      : [];

  // Resolution (multi-select with standardized label mapping)
  const resolutions = parseMulti(params.get("resolution"));
  if (resolutions) {
    if (resolutions.length === 1) {
      applyResolutionFilter(where, andClauses, resolutions[0]);
    } else {
      const orClauses: Prisma.MediaItemWhereInput[] = [];
      for (const res of resolutions) {
        const dbValues = RESOLUTION_DB_VALUES[res];
        if (dbValues) {
          orClauses.push({ resolution: { in: dbValues, mode: "insensitive" } });
        } else if (res === "Other") {
          const allKnown = Object.values(RESOLUTION_DB_VALUES).flat();
          orClauses.push({
            AND: [
              { resolution: { not: null } },
              { NOT: { resolution: { in: allKnown, mode: "insensitive" } } },
            ],
          });
        }
      }
      if (orClauses.length > 0) {
        andClauses.push({ OR: orClauses });
      }
    }
  }

  // String multi-select filters (case-insensitive contains for each)
  const multiContains: [string, keyof Prisma.MediaItemWhereInput][] = [
    ["videoCodec", "videoCodec"],
    ["audioCodec", "audioCodec"],
    ["container", "container"],
    ["studio", "studio"],
    ["videoProfile", "videoProfile"],
    ["scanType", "scanType"],
  ];
  for (const [param, field] of multiContains) {
    const values = parseMulti(params.get(param));
    if (values) {
      if (values.length === 1) {
        (where as Record<string, unknown>)[field] = { contains: values[0], mode: "insensitive" };
      } else {
        andClauses.push({
          OR: values.map((v) => ({ [field]: { contains: v, mode: "insensitive" } })),
        });
      }
    }
  }

  // String exact-match multi-select filters
  const multiExact: [string, keyof Prisma.MediaItemWhereInput][] = [
    ["dynamicRange", "dynamicRange"],
    ["audioProfile", "audioProfile"],
    ["contentRating", "contentRating"],
    ["videoFrameRate", "videoFrameRate"],
    ["aspectRatio", "aspectRatio"],
  ];
  for (const [param, field] of multiExact) {
    const values = parseMulti(params.get(param));
    if (values) {
      if (values.length === 1) {
        (where as Record<string, unknown>)[field] = values[0];
      } else {
        (where as Record<string, unknown>)[field] = { in: values };
      }
    }
  }

  // Integer multi-select filters
  const multiInt: [string, keyof Prisma.MediaItemWhereInput][] = [
    ["videoBitDepth", "videoBitDepth"],
    ["audioChannels", "audioChannels"],
    ["audioSamplingRate", "audioSamplingRate"],
  ];
  for (const [param, field] of multiInt) {
    const values = parseMulti(params.get(param));
    if (values) {
      const nums = values.map((v) => parseInt(v)).filter((n) => !isNaN(n));
      if (nums.length === 1) {
        (where as Record<string, unknown>)[field] = nums[0];
      } else if (nums.length > 1) {
        (where as Record<string, unknown>)[field] = { in: nums };
      }
    }
  }

  // Year — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "yearConditions", "yearLogic", "year", parseInt);

  // Genre (case-insensitive match in JSON array)
  const genreValues = parseMulti(params.get("genre"));
  if (genreValues) {
    // For multi-genre, require all genres to be present (AND)
    for (const g of genreValues) {
      andClauses.push({ genres: { array_contains: g } });
    }
  }

  // File size range (BigInt)
  const fileSizeMin = params.get("fileSizeMin");
  const fileSizeMax = params.get("fileSizeMax");
  if (fileSizeMin || fileSizeMax) {
    where.fileSize = {};
    if (fileSizeMin) (where.fileSize as Record<string, bigint>).gte = BigInt(fileSizeMin);
    if (fileSizeMax) (where.fileSize as Record<string, bigint>).lte = BigInt(fileSizeMax);
  }

  // Duration range (milliseconds)
  const durationMin = params.get("durationMin");
  const durationMax = params.get("durationMax");
  if (durationMin || durationMax) {
    where.duration = {};
    if (durationMin) (where.duration as Record<string, number>).gte = parseInt(durationMin);
    if (durationMax) (where.duration as Record<string, number>).lte = parseInt(durationMax);
  }

  // Play count — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "playCountConditions", "playCountLogic", "playCount", parseInt);

  // Rating — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "ratingConditions", "ratingLogic", "rating", parseFloat);

  // Audience Rating — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "audienceRatingConditions", "audienceRatingLogic", "audienceRating", parseFloat);

  // Video Bitrate — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "videoBitrateConditions", "videoBitrateLogic", "videoBitrate", parseInt);

  // Audio Bitrate — multi-condition with AND/OR logic
  applyConditionFilter(where, andClauses, params, "audioBitrateConditions", "audioBitrateLogic", "audioBitrate", parseInt);

  // Last played date — supports date range or "days ago"
  const lastPlayedAtDays = params.get("lastPlayedAtDays");
  const lastPlayedAtMin = params.get("lastPlayedAtMin");
  const lastPlayedAtMax = params.get("lastPlayedAtMax");
  if (lastPlayedAtDays) {
    const days = parseInt(lastPlayedAtDays);
    if (!isNaN(days) && days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
      where.lastPlayedAt = { gte: since };
    }
  } else if (lastPlayedAtMin || lastPlayedAtMax) {
    where.lastPlayedAt = {};
    if (lastPlayedAtMin) (where.lastPlayedAt as Record<string, Date>).gte = new Date(lastPlayedAtMin);
    if (lastPlayedAtMax) {
      const maxDate = new Date(lastPlayedAtMax);
      maxDate.setHours(23, 59, 59, 999);
      (where.lastPlayedAt as Record<string, Date>).lte = maxDate;
    }
  }

  // Added date — supports date range or "days ago"
  const addedAtDays = params.get("addedAtDays");
  const addedAtMin = params.get("addedAtMin");
  const addedAtMax = params.get("addedAtMax");
  if (addedAtDays) {
    const days = parseInt(addedAtDays);
    if (!isNaN(days) && days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
      where.addedAt = { gte: since };
    }
  } else if (addedAtMin || addedAtMax) {
    where.addedAt = {};
    if (addedAtMin) (where.addedAt as Record<string, Date>).gte = new Date(addedAtMin);
    if (addedAtMax) {
      const maxDate = new Date(addedAtMax);
      maxDate.setHours(23, 59, 59, 999);
      (where.addedAt as Record<string, Date>).lte = maxDate;
    }
  }

  // Release date — supports date range or "days ago"
  const originallyAvailableAtDays = params.get("originallyAvailableAtDays");
  const originallyAvailableAtMin = params.get("originallyAvailableAtMin");
  const originallyAvailableAtMax = params.get("originallyAvailableAtMax");
  if (originallyAvailableAtDays) {
    const days = parseInt(originallyAvailableAtDays);
    if (!isNaN(days) && days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
      where.originallyAvailableAt = { gte: since };
    }
  } else if (originallyAvailableAtMin || originallyAvailableAtMax) {
    where.originallyAvailableAt = {};
    if (originallyAvailableAtMin) (where.originallyAvailableAt as Record<string, Date>).gte = new Date(originallyAvailableAtMin);
    if (originallyAvailableAtMax) {
      const maxDate = new Date(originallyAvailableAtMax);
      maxDate.setHours(23, 59, 59, 999);
      (where.originallyAvailableAt as Record<string, Date>).lte = maxDate;
    }
  }

  // Boolean: isWatchlisted
  const isWatchlisted = params.get("isWatchlisted");
  if (isWatchlisted === "true") {
    where.isWatchlisted = true;
  } else if (isWatchlisted === "false") {
    where.isWatchlisted = false;
  }

  // Stream-based relation filters (audio language, subtitle language, stream codec)
  // Note: Prisma's `in` doesn't support `mode: "insensitive"`, so we use OR + equals
  const audioLanguages = parseMulti(params.get("audioLanguage"));
  if (audioLanguages) {
    if (audioLanguages.length === 1) {
      andClauses.push({
        streams: {
          some: {
            streamType: 2,
            language: { equals: audioLanguages[0], mode: "insensitive" },
          },
        },
      });
    } else {
      andClauses.push({
        OR: audioLanguages.map((l) => ({
          streams: {
            some: {
              streamType: 2,
              language: { equals: l, mode: "insensitive" },
            },
          },
        })),
      });
    }
  }

  const subtitleLanguages = parseMulti(params.get("subtitleLanguage"));
  if (subtitleLanguages) {
    if (subtitleLanguages.length === 1) {
      andClauses.push({
        streams: {
          some: {
            streamType: 3,
            language: { equals: subtitleLanguages[0], mode: "insensitive" },
          },
        },
      });
    } else {
      andClauses.push({
        OR: subtitleLanguages.map((l) => ({
          streams: {
            some: {
              streamType: 3,
              language: { equals: l, mode: "insensitive" },
            },
          },
        })),
      });
    }
  }

  const streamAudioCodecs = parseMulti(params.get("streamAudioCodec"));
  if (streamAudioCodecs) {
    if (streamAudioCodecs.length === 1) {
      andClauses.push({
        streams: {
          some: {
            streamType: 2,
            codec: { contains: streamAudioCodecs[0], mode: "insensitive" },
          },
        },
      });
    } else {
      andClauses.push({
        OR: streamAudioCodecs.map((c) => ({
          streams: {
            some: {
              streamType: 2,
              codec: { contains: c, mode: "insensitive" },
            },
          },
        })),
      });
    }
  }

  // Apply accumulated AND clauses
  if (andClauses.length > 0) {
    where.AND = andClauses;
  }
}

/**
 * Convert a comparison operator string to a Prisma filter object.
 */
function comparisonOpToFilter(value: number, op: string): number | Record<string, number> {
  switch (op) {
    case "gt": return { gt: value };
    case "lt": return { lt: value };
    case "gte": return { gte: value };
    case "lte": return { lte: value };
    case "eq":
    default: return value;
  }
}

/**
 * Parse and apply multi-condition comparison filters (e.g. "gte:2020|lte:2024").
 * Conditions are pipe-separated `op:value` pairs combined with AND or OR logic.
 */
function applyConditionFilter(
  where: Prisma.MediaItemWhereInput,
  andClauses: Prisma.MediaItemWhereInput[],
  params: URLSearchParams,
  conditionsKey: string,
  logicKey: string,
  field: keyof Prisma.MediaItemWhereInput,
  parse: (v: string) => number
): void {
  const raw = params.get(conditionsKey);
  if (!raw) return;

  const logic = params.get(logicKey) ?? "and";
  const parts = raw.split("|").filter(Boolean);
  const conditions: { op: string; value: number }[] = [];

  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) {
      const num = parse(part);
      if (!isNaN(num)) conditions.push({ op: "eq", value: num });
    } else {
      const op = part.slice(0, idx);
      const num = parse(part.slice(idx + 1));
      if (!isNaN(num)) conditions.push({ op, value: num });
    }
  }

  if (conditions.length === 0) return;

  if (conditions.length === 1) {
    (where as Record<string, unknown>)[field] = comparisonOpToFilter(conditions[0].value, conditions[0].op);
    return;
  }

  // Multiple conditions: combine with AND or OR
  const clauseList = conditions.map((c) => ({
    [field]: comparisonOpToFilter(c.value, c.op),
  }));

  if (logic === "or") {
    andClauses.push({ OR: clauseList });
  } else {
    // AND — push each condition individually
    for (const clause of clauseList) {
      andClauses.push(clause);
    }
  }
}

const AZ_LETTERS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));

/**
 * Apply a "starts with" alphabetical filter to a Prisma WHERE clause.
 * - Letters A-Z: filter by case-insensitive startsWith
 * - "#": filter to items NOT starting with any letter A-Z (numbers, special chars)
 */
export function applyStartsWithFilter(
  where: Prisma.MediaItemWhereInput,
  field: "title" | "parentTitle",
  startsWith: string,
): void {
  if (startsWith === "#") {
    const andClauses: Prisma.MediaItemWhereInput[] = Array.isArray(where.AND)
      ? [...where.AND]
      : where.AND
        ? [where.AND as Prisma.MediaItemWhereInput]
        : [];
    andClauses.push({
      NOT: {
        OR: AZ_LETTERS.map((l) => ({ [field]: { startsWith: l, mode: "insensitive" as const } })),
      },
    });
    where.AND = andClauses;
  } else {
    // Merge with existing field filter if present (e.g. parentTitle: { not: null })
    const existing = where[field];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      (where as Record<string, unknown>)[field] = {
        ...existing,
        startsWith,
        mode: "insensitive",
      };
    } else {
      (where as Record<string, unknown>)[field] = { startsWith, mode: "insensitive" };
    }
  }
}

function applyResolutionFilter(
  where: Prisma.MediaItemWhereInput,
  andClauses: Prisma.MediaItemWhereInput[],
  resolution: string
): void {
  const dbValues = RESOLUTION_DB_VALUES[resolution];
  if (dbValues) {
    where.resolution = { in: dbValues, mode: "insensitive" };
  } else if (resolution === "Other") {
    const allKnown = Object.values(RESOLUTION_DB_VALUES).flat();
    andClauses.push(
      { resolution: { not: null } },
      { NOT: { resolution: { in: allKnown, mode: "insensitive" } } }
    );
  } else {
    where.resolution = resolution;
  }
}
