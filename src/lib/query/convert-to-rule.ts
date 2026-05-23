import { z } from "zod/v4";
import type { LibraryType } from "@/lib/conditions";
import type { ruleSetCreateSchema } from "@/lib/validation";
import type { QueryDefinition } from "@/lib/query/types";
import { dropIncompatibleRules } from "@/components/builder/library-type-validity";

export type RuleSetCreateBody = z.infer<typeof ruleSetCreateSchema>;

export interface ConvertOptions {
  name: string;
  targetLibraryType: LibraryType;
  serverIds: string[];
}

export class ConvertQueryError extends Error {
  constructor(
    public readonly code:
      | "EMPTY_NAME"
      | "EMPTY_SERVERS"
      | "ALL_RULES_INCOMPATIBLE",
    message: string,
  ) {
    super(message);
    this.name = "ConvertQueryError";
  }
}

export function convertQueryToRuleSetBody(
  query: QueryDefinition,
  opts: ConvertOptions,
): RuleSetCreateBody {
  if (!opts.name.trim()) {
    throw new ConvertQueryError("EMPTY_NAME", "Name is required");
  }
  if (opts.serverIds.length === 0) {
    throw new ConvertQueryError(
      "EMPTY_SERVERS",
      "At least one server is required for a lifecycle rule set",
    );
  }
  const cleaned = dropIncompatibleRules(query.groups, opts.targetLibraryType);
  if (cleaned.length === 0) {
    throw new ConvertQueryError(
      "ALL_RULES_INCOMPATIBLE",
      `No rules in this query are compatible with library type ${opts.targetLibraryType}`,
    );
  }
  const arrInstanceId = arrInstanceIdForType(
    opts.targetLibraryType,
    query.arrServerIds,
  );
  return {
    name: opts.name.trim(),
    type: opts.targetLibraryType,
    rules: cleaned as unknown as RuleSetCreateBody["rules"],
    serverIds: opts.serverIds,
    enabled: true,
    actionEnabled: false,
    ...(opts.targetLibraryType === "SERIES" ? { seriesScope: true } : {}),
    ...(arrInstanceId ? { arrInstanceId } : {}),
  };
}

/**
 * The query builder lets a user pick an Arr instance per Arr type (radarr,
 * sonarr, lidarr). A lifecycle rule set is scoped to a single library type
 * and has one `arrInstanceId`, so we project the per-type selection down to
 * the one that matches the target library type.
 */
export function arrInstanceIdForType(
  targetLibraryType: LibraryType,
  arrServerIds: QueryDefinition["arrServerIds"],
): string | undefined {
  if (!arrServerIds) return undefined;
  switch (targetLibraryType) {
    case "MOVIE":
      return arrServerIds.radarr || undefined;
    case "SERIES":
      return arrServerIds.sonarr || undefined;
    case "MUSIC":
      return arrServerIds.lidarr || undefined;
  }
}
