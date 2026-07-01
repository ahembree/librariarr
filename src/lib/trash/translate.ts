/**
 * Pure translation between TRaSH Guides JSON and Sonarr/Radarr v3 payloads.
 *
 * Everything here is side-effect free and unit-tested against real guide
 * fixtures. The sync orchestrator feeds these outputs to the Arr client.
 */
import type {
  ServiceType,
  TrashCustomFormat,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
  TrashSpecification,
  ArrCustomFormat,
  ArrField,
  ArrQualityDefinition,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  ArrProfileItem,
  ArrQualityRef,
  ArrFormatItem,
  ArrLanguage,
  ArrNamingConfig,
  NamingSelection,
} from "./types";

// ─── Custom formats ───

/** TRaSH stores spec fields as an object ({ value: x }); the Arr API wants [{ name, value }]. */
export function specFieldsToArray(fields: TrashSpecification["fields"]): ArrField[] {
  if (!fields) return [];
  if (Array.isArray(fields)) {
    return fields.map((f) => ({ name: f.name, value: f.value }));
  }
  return Object.entries(fields).map(([name, value]) => ({ name, value }));
}

export function trashCfToArr(cf: TrashCustomFormat, id?: number): ArrCustomFormat {
  const payload: ArrCustomFormat = {
    name: cf.name,
    includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
    specifications: (cf.specifications ?? []).map((s) => ({
      name: s.name,
      implementation: s.implementation,
      negate: s.negate ?? false,
      required: s.required ?? false,
      fields: specFieldsToArray(s.fields),
    })),
  };
  if (id !== undefined) payload.id = id;
  return payload;
}

interface RawSpec {
  name?: string;
  implementation?: string;
  negate?: boolean;
  required?: boolean;
  fields?: unknown;
}

/** Reduce a spec's fields (array or object form) to a name→value map. */
function fieldsToMap(fields: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (Array.isArray(fields)) {
    for (const f of fields as Array<{ name?: string; value?: unknown }>) {
      if (f && f.name != null) out[String(f.name)] = f.value;
    }
  } else if (fields && typeof fields === "object") {
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) out[k] = v;
  }
  return out;
}

interface CfComparableSpec {
  implementation: string;
  negate: boolean;
  required: boolean;
  fields: Record<string, unknown>;
}

export interface CfComparable {
  name: string;
  includeCustomFormatWhenRenaming: boolean;
  /** Keyed by spec name, so ordering never matters. */
  specifications: Record<string, CfComparableSpec>;
}

/** Normalize an Arr/guide custom format to a comparable shape (ids + field metadata stripped). */
export function cfComparable(cf: ArrCustomFormat): CfComparable {
  const specifications: Record<string, CfComparableSpec> = {};
  for (const raw of (cf.specifications ?? []) as RawSpec[]) {
    specifications[raw.name ?? ""] = {
      implementation: raw.implementation ?? "",
      negate: raw.negate ?? false,
      required: raw.required ?? false,
      fields: fieldsToMap(raw.fields),
    };
  }
  return {
    name: cf.name,
    includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
    specifications,
  };
}

/**
 * Project the existing (Arr) comparable down to only the fields the guide
 * actually manages. Sonarr/Radarr add default fields to some specifications
 * (e.g. a LanguageSpecification stores `exceptLanguage` even when the guide
 * only sets `value`), which the guide never sends — so without this, those
 * defaults register as a perpetual diff and the format never reports "in sync".
 */
export function projectManagedFields(before: CfComparable, after: CfComparable): CfComparable {
  const specifications: Record<string, CfComparableSpec> = {};
  for (const [name, beforeSpec] of Object.entries(before.specifications)) {
    const afterSpec = after.specifications[name];
    if (!afterSpec) {
      // Spec exists in the app but not the guide — a real change (it'll be dropped).
      specifications[name] = beforeSpec;
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(beforeSpec.fields)) {
      if (k in afterSpec.fields) fields[k] = v;
    }
    specifications[name] = { ...beforeSpec, fields };
  }
  return { ...before, specifications };
}

export function findArrCfByName(
  arrCfs: ArrCustomFormat[],
  name: string,
): ArrCustomFormat | undefined {
  const lower = name.trim().toLowerCase();
  return (
    arrCfs.find((c) => c.name === name) ??
    arrCfs.find((c) => c.name.trim().toLowerCase() === lower)
  );
}

// ─── Quality definitions (sizes) ───

/**
 * Merge TRaSH quality sizes into the instance's existing definitions. Existing
 * definitions are preserved (id/quality/title/weight); only the size fields for
 * qualities named in the guide are updated. The full array is returned because
 * the Arr bulk-update endpoint replaces the whole set.
 */
export function applyQualitySizes(
  trash: TrashQualitySize,
  existing: ArrQualityDefinition[],
): ArrQualityDefinition[] {
  const byName = new Map(trash.qualities.map((q) => [q.quality, q]));
  return existing.map((def) => {
    const t = byName.get(def.quality.name);
    if (!t) return def;
    return {
      ...def,
      minSize: t.min,
      maxSize: t.max,
      preferredSize: t.preferred ?? def.preferredSize ?? null,
    };
  });
}

export function qualityDefsComparable(defs: ArrQualityDefinition[]) {
  const out: Record<string, { min: number | null; max: number | null; preferred: number | null }> =
    {};
  for (const d of defs) {
    out[d.quality.name] = {
      min: d.minSize,
      max: d.maxSize,
      preferred: d.preferredSize ?? null,
    };
  }
  return out;
}

// ─── Quality profiles ───

function flattenSchemaQualities(items: ArrProfileItem[]): Map<string, ArrQualityRef> {
  const map = new Map<string, ArrQualityRef>();
  const walk = (list: ArrProfileItem[]) => {
    for (const it of list) {
      if (it.quality) map.set(it.quality.name, it.quality);
      if (it.items?.length) walk(it.items);
    }
  };
  walk(items);
  return map;
}

function pickScore(scores: Record<string, number> | undefined, scoreSet?: string): number {
  if (!scores) return 0;
  if (scoreSet && scoreSet in scores) return scores[scoreSet];
  return scores.default ?? 0;
}

function resolveLanguage(
  trashLanguage: string | undefined,
  schema: ArrQualityProfileSchema,
  languages: ArrLanguage[] | undefined,
  warnings: string[],
): ArrLanguage | undefined {
  if (!trashLanguage) return schema.language;
  const lower = trashLanguage.toLowerCase();
  if (lower === "any") return { id: -1, name: "Any" };
  if (lower === "original") return { id: -2, name: "Original" };
  // Named language (e.g. "French") — resolve against the instance's language
  // list. Never silently substitute the schema default: a wrong language
  // silently breaks the user's language filtering.
  const match = languages?.find((l) => l.name.toLowerCase() === lower);
  if (match) return match;
  warnings.push(
    `Language "${trashLanguage}" could not be resolved on this instance — keeping the profile's existing language.`,
  );
  return schema.language;
}

export interface BuildProfileResult {
  payload: ArrQualityProfile;
  warnings: string[];
}

/**
 * Build a Sonarr/Radarr quality profile payload from a TRaSH profile, resolving
 * quality names/groups and custom-format scores against the live instance schema.
 *
 * TRaSH lists qualities highest-priority-first; the Arr API stores them
 * lowest-first, so the constructed list is reversed. Custom-format scores are
 * only applied to formats that already exist in the instance — a profile never
 * silently creates a custom format (that would need its own assignment), so
 * missing formats are surfaced as warnings instead.
 */
export function buildQualityProfile(
  trash: TrashQualityProfile,
  schema: ArrQualityProfileSchema,
  service: ServiceType,
  catalogCfsByTrashId: Map<string, TrashCustomFormat>,
  existing?: ArrQualityProfile,
  languages?: ArrLanguage[],
  scoreSet?: string,
): BuildProfileResult {
  const warnings: string[] = [];
  const baseByName = flattenSchemaQualities(schema.items);
  // The profile's declared score set selects which entry of each custom
  // format's `trash_scores` to use. Many formats have no `default`, so this
  // must be honored or their scores collapse to 0.
  const resolvedScoreSet = scoreSet ?? trash.trash_score_set;

  const items: ArrProfileItem[] = [];
  const used = new Set<string>();
  let groupId = 1000;

  for (const t of trash.items) {
    if (t.items && t.items.length) {
      const children: ArrProfileItem[] = [];
      for (const qn of t.items) {
        const q = baseByName.get(qn);
        if (!q) {
          warnings.push(`Unknown quality "${qn}" in group "${t.name}" — skipped.`);
          continue;
        }
        used.add(qn);
        children.push({ quality: q, items: [], allowed: t.allowed });
      }
      if (children.length) {
        items.push({ name: t.name, id: groupId++, items: children, allowed: t.allowed });
      }
    } else {
      const q = baseByName.get(t.name);
      if (!q) {
        warnings.push(`Unknown quality "${t.name}" — skipped.`);
        continue;
      }
      used.add(t.name);
      items.push({ quality: q, items: [], allowed: t.allowed });
    }
  }

  // Any base quality the guide didn't mention must still appear (Arr requires
  // every quality present); park it at the lowest priority, disallowed.
  for (const [name, q] of baseByName) {
    if (!used.has(name)) {
      items.push({ quality: q, items: [], allowed: false });
    }
  }

  // TRaSH is highest→lowest; Arr wants lowest→highest.
  items.reverse();

  // Resolve the cutoff name to its quality/group id.
  const nameToId = new Map<string, number>();
  for (const it of items) {
    if (it.quality) nameToId.set(it.quality.name, it.quality.id);
    else if (it.name && it.id !== undefined) nameToId.set(it.name, it.id);
  }
  let cutoff = nameToId.get(trash.cutoff);
  if (cutoff === undefined) {
    warnings.push(`Cutoff "${trash.cutoff}" not found in profile — using highest allowed quality.`);
    const highestAllowed = [...items].reverse().find((it) => it.allowed);
    cutoff = highestAllowed?.quality?.id ?? highestAllowed?.id ?? items[items.length - 1]?.quality?.id ?? 0;
  }

  // Format scores. Seed from the profile's EXISTING scores rather than zeroing
  // everything, so custom formats the guide profile doesn't manage (e.g. ones
  // assigned via PROFILE_CF or set manually) are preserved. This mirrors
  // Recyclarr's default (`reset_unmatched_scores` off): only the CFs the guide
  // profile references are changed; all other scores are left untouched.
  const existingScoreByName = new Map(
    (existing?.formatItems ?? []).map((f) => [f.name, f.score]),
  );
  const formatItems: ArrFormatItem[] = (schema.formatItems ?? []).map((f) => ({
    format: f.format,
    name: f.name,
    score: existingScoreByName.get(f.name) ?? 0,
  }));
  const byName = new Map(formatItems.map((f) => [f.name, f]));
  for (const [cfName, cfTrashId] of Object.entries(trash.formatItems ?? {})) {
    const catalogCf = catalogCfsByTrashId.get(cfTrashId);
    const score = pickScore(catalogCf?.trash_scores, resolvedScoreSet);
    const target = byName.get(cfName) ?? byName.get(catalogCf?.name ?? "");
    if (target) {
      target.score = score;
    } else if (score !== 0) {
      warnings.push(
        `Custom format "${cfName}" (score ${score}) is not present in this instance — ` +
          `manage & sync it to apply its score.`,
      );
    }
  }

  const payload: ArrQualityProfile = {
    name: trash.name,
    upgradeAllowed: trash.upgradeAllowed ?? true,
    cutoff,
    items,
    minFormatScore: trash.minFormatScore ?? 0,
    cutoffFormatScore: trash.cutoffFormatScore ?? 0,
    minUpgradeFormatScore: trash.minUpgradeFormatScore ?? 1,
    formatItems,
  };
  if (existing?.id !== undefined) payload.id = existing.id;

  // Radarr profiles carry a language; Sonarr sets language per item, so we
  // leave it off the Sonarr payload.
  if (service === "RADARR") {
    const language = resolveLanguage(trash.language, schema, languages, warnings);
    if (language) payload.language = language;
  }

  return { payload, warnings };
}

/**
 * Normalize a profile (Arr or built) to a comparable shape for diffing. The
 * language is only compared for Radarr, where it lives on the profile payload;
 * Sonarr profiles always carry a language field we never set, so including it
 * would produce a spurious diff on every sync.
 */
export function profileComparable(profile: ArrQualityProfile, service: ServiceType) {
  const idToName = new Map<number, string>();
  const orderedQualities: Array<{ name: string; allowed: boolean }> = [];
  for (const it of profile.items ?? []) {
    const name = it.name ?? it.quality?.name ?? "?";
    if (it.quality) idToName.set(it.quality.id, name);
    else if (it.id !== undefined) idToName.set(it.id, name);
    orderedQualities.push({ name, allowed: it.allowed });
  }
  const formatScores: Record<string, number> = {};
  for (const f of profile.formatItems ?? []) {
    if (f.score !== 0) formatScores[f.name] = f.score;
  }
  return {
    name: profile.name,
    upgradeAllowed: profile.upgradeAllowed,
    cutoff: idToName.get(profile.cutoff) ?? String(profile.cutoff),
    minFormatScore: profile.minFormatScore,
    cutoffFormatScore: profile.cutoffFormatScore,
    minUpgradeFormatScore: profile.minUpgradeFormatScore ?? null,
    ...(service === "RADARR"
      ? { language: profile.language?.name ?? profile.language?.id ?? null }
      : {}),
    qualities: orderedQualities,
    formatScores,
  };
}

// ─── Naming ───

export function applyNaming(
  trash: TrashNaming,
  selection: NamingSelection,
  existing: ArrNamingConfig,
  service: ServiceType,
): ArrNamingConfig {
  const config: ArrNamingConfig = { ...existing };
  if (service === "RADARR") {
    if (selection.file && trash.file?.[selection.file]) {
      config.standardMovieFormat = trash.file[selection.file];
    }
    if (selection.folder && trash.folder?.[selection.folder]) {
      config.movieFolderFormat = trash.folder[selection.folder];
    }
  } else {
    if (selection.series && trash.series?.[selection.series]) {
      config.seriesFolderFormat = trash.series[selection.series];
    }
    if (selection.season && trash.season?.[selection.season]) {
      config.seasonFolderFormat = trash.season[selection.season];
    }
    if (selection.standard && trash.episodes?.standard?.[selection.standard]) {
      config.standardEpisodeFormat = trash.episodes.standard[selection.standard];
    }
    if (selection.daily && trash.episodes?.daily?.[selection.daily]) {
      config.dailyEpisodeFormat = trash.episodes.daily[selection.daily];
    }
    if (selection.anime && trash.episodes?.anime?.[selection.anime]) {
      config.animeEpisodeFormat = trash.episodes.anime[selection.anime];
    }
  }
  return config;
}

export function namingComparable(config: ArrNamingConfig, service: ServiceType) {
  if (service === "RADARR") {
    return {
      standardMovieFormat: config.standardMovieFormat ?? null,
      movieFolderFormat: config.movieFolderFormat ?? null,
    };
  }
  return {
    standardEpisodeFormat: config.standardEpisodeFormat ?? null,
    dailyEpisodeFormat: config.dailyEpisodeFormat ?? null,
    animeEpisodeFormat: config.animeEpisodeFormat ?? null,
    seriesFolderFormat: config.seriesFolderFormat ?? null,
    seasonFolderFormat: config.seasonFolderFormat ?? null,
  };
}
