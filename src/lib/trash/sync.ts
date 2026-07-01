import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fetchTrashCatalog } from "./catalog";
import { guideClientFor, managedInstanceWhere, type ResolvedInstance } from "./status";
import { diffValues } from "./diff";
import {
  trashCfToArr,
  cfComparable,
  projectManagedFields,
  findArrCfByName,
  applyQualitySizes,
  qualityDefsComparable,
  buildQualityProfile,
  profileComparable,
  applyNaming,
  namingComparable,
} from "./translate";
import {
  trashCfHash,
  trashProfileHash,
  trashQualitySizeHash,
  namingSelectionHash,
} from "./signature";
import { hashDefinition } from "./hash";
import { NAMING_TRASH_ID } from "./types";
import type {
  ResourceType,
  TrashCatalog,
  TrashCustomFormat,
  NamingSelection,
  ProfileCfSelection,
  PlanItem,
  SyncReport,
  ArrCustomFormat,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  ArrQualityDefinition,
  ArrNamingConfig,
  ArrLanguage,
} from "./types";

type Selection = NamingSelection | ProfileCfSelection | null;

interface Target {
  resourceType: ResourceType;
  trashId: string;
  name?: string;
  selection?: Selection;
  managedRowId?: string;
}

export interface SyncOptions {
  dryRun: boolean;
  /**
   * Scope the run to specific items.
   *  - Dry-run: previews exactly these items (they may be unassigned).
   *  - Apply: intersected with the managed rows, so it syncs just this subset
   *    (e.g. one quality profile) — never anything outside the managed set, so
   *    the consent gate holds. Omit to run the whole managed set.
   */
  items?: Array<{ resourceType: ResourceType; trashId: string; selection?: NamingSelection | ProfileCfSelection }>;
}

/** Order matters: quality defs / naming, then custom formats, then profiles,
 *  then per-profile custom-format overlays (which read the just-synced
 *  profiles). Profiles reference custom formats, which must exist first. */
const RESOURCE_ORDER: Record<ResourceType, number> = {
  QUALITY_DEFINITION: 0,
  NAMING: 1,
  CUSTOM_FORMAT: 2,
  QUALITY_PROFILE: 3,
  PROFILE_CF: 4,
};

export async function runTrashSync(
  userId: string,
  inst: ResolvedInstance,
  opts: SyncOptions,
): Promise<SyncReport> {
  const catalog = await fetchTrashCatalog(inst.serviceType);
  const client = guideClientFor(inst);

  const targets = await resolveTargets(userId, inst, opts);
  targets.sort((a, b) => RESOURCE_ORDER[a.resourceType] - RESOURCE_ORDER[b.resourceType]);

  // Lazily fetched instance state, cached per run. Each getter throws on the
  // first failure; per-item try/catch turns that into an ERROR plan item.
  const cfMapByTrashId = new Map(catalog.customFormats.map((c) => [c.trash_id, c]));
  let arrCfs: ArrCustomFormat[] | undefined;
  let arrProfiles: ArrQualityProfile[] | undefined;
  let schema: ArrQualityProfileSchema | undefined;
  let qualityDefs: ArrQualityDefinition[] | undefined;
  let namingConfig: ArrNamingConfig | undefined;
  let languages: ArrLanguage[] | undefined;

  // Profiles read for PROFILE_CF overlays are fetched separately (and lazily)
  // so they capture any QUALITY_PROFILE writes made earlier in this same apply.
  let cfOverlayProfiles: ArrQualityProfile[] | undefined;

  const getArrCfs = async () => (arrCfs ??= await client.getCustomFormats());
  const getArrProfiles = async () => (arrProfiles ??= await client.getQualityProfiles());
  const getSchema = async () => (schema ??= await client.getQualityProfileSchema());
  const getQualityDefs = async () => (qualityDefs ??= await client.getQualityDefinitions());
  const getNaming = async () => (namingConfig ??= await client.getNamingConfig());
  const getLanguages = async () => (languages ??= await client.getLanguages());
  const getCfOverlayProfiles = async () => (cfOverlayProfiles ??= await client.getQualityProfiles());

  const items: PlanItem[] = [];

  for (const target of targets) {
    try {
      switch (target.resourceType) {
        case "CUSTOM_FORMAT":
          items.push(await planCustomFormat(target, catalog, await getArrCfs(), opts, client, userId));
          break;
        case "QUALITY_PROFILE": {
          // Fetch the schema at profile time so custom formats created earlier in
          // this same apply are visible for scoring. Radarr profiles also carry a
          // language, resolved against the instance's language list.
          const [profiles, sch] = [await getArrProfiles(), await getSchema()];
          const langs = inst.serviceType === "RADARR" ? await getLanguages() : undefined;
          items.push(
            await planQualityProfile(target, catalog, profiles, sch, langs, cfMapByTrashId, inst, opts, client, userId),
          );
          break;
        }
        case "QUALITY_DEFINITION":
          items.push(await planQualityDefinition(target, catalog, await getQualityDefs(), opts, client, userId));
          break;
        case "NAMING":
          items.push(await planNaming(target, catalog, await getNaming(), inst, opts, client, userId));
          break;
        case "PROFILE_CF":
          items.push(await planProfileCf(target, await getCfOverlayProfiles(), opts, client, userId));
          break;
      }
    } catch (err) {
      items.push({
        resourceType: target.resourceType,
        trashId: target.trashId,
        name: target.name ?? target.trashId,
        action: "ERROR",
        diff: [],
        warnings: [],
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  if (!opts.dryRun) {
    logger.info(
      "TrashSync",
      `Applied sync to ${inst.serviceType} "${inst.name}": ` +
        items.map((i) => `${i.name}=${i.action}`).join(", "),
    );
  }

  return { serviceType: inst.serviceType, instanceId: inst.id, dryRun: opts.dryRun, items };
}

async function resolveTargets(
  userId: string,
  inst: ResolvedInstance,
  opts: SyncOptions,
): Promise<Target[]> {
  // Dry-run of a specific set may include not-yet-assigned items (preview).
  if (opts.dryRun && opts.items?.length) {
    return opts.items.map((i) => ({
      resourceType: i.resourceType,
      trashId: i.trashId,
      selection: i.selection ?? null,
    }));
  }

  // Otherwise operate on the managed set — the consent gate. When `items` is
  // given (a per-item apply, e.g. "sync just this quality profile"), intersect
  // it with the managed rows so nothing outside the managed set is ever
  // written; the stored row selection/metadata is always used.
  const rows = await prisma.trashManagedResource.findMany({
    where: { userId, ...managedInstanceWhere(inst.serviceType, inst.id) },
  });
  let targets: Target[] = rows.map((r) => ({
    resourceType: r.resourceType as ResourceType,
    trashId: r.trashId,
    name: r.name,
    selection: (r.selection ?? null) as Selection,
    managedRowId: r.id,
  }));
  if (opts.items?.length) {
    const wanted = new Set(opts.items.map((i) => `${i.resourceType}:${i.trashId}`));
    targets = targets.filter((t) => wanted.has(`${t.resourceType}:${t.trashId}`));
  }
  return targets;
}

async function updateManagedRow(
  userId: string,
  managedRowId: string | undefined,
  data: { arrId?: number | null; lastSyncHash: string; selection?: Selection },
) {
  if (!managedRowId) return;
  await prisma.trashManagedResource.update({
    where: { id: managedRowId },
    data: {
      ...(data.arrId !== undefined ? { arrId: data.arrId } : {}),
      ...(data.selection ? { selection: data.selection as object } : {}),
      lastSyncHash: data.lastSyncHash,
      lastSyncedAt: new Date(),
    },
  });
}

async function planCustomFormat(
  target: Target,
  catalog: TrashCatalog,
  arrCfs: ArrCustomFormat[],
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const cf = catalog.customFormats.find((c) => c.trash_id === target.trashId);
  if (!cf) {
    return skip(target, "This custom format is no longer in the guide.");
  }
  const existing = findArrCfByName(arrCfs, cf.name);
  const payload = trashCfToArr(cf, existing?.id);
  const after = cfComparable(payload);
  // Compare only the fields the guide manages, so app-supplied defaults (e.g. a
  // LanguageSpecification's exceptLanguage) don't cause a perpetual diff.
  const before = existing ? projectManagedFields(cfComparable(existing), after) : null;
  const diff = diffValues(before, after);
  const action = existing ? (diff.length ? "UPDATE" : "NOOP") : "CREATE";

  const item: PlanItem = {
    resourceType: "CUSTOM_FORMAT",
    trashId: cf.trash_id,
    name: cf.name,
    action,
    diff,
    warnings: [],
  };

  if (!opts.dryRun) {
    let arrId = existing?.id ?? null;
    if (action === "CREATE") {
      const created = await client.createCustomFormat(payload);
      arrId = created.id ?? null;
    } else if (action === "UPDATE" && existing?.id !== undefined) {
      await client.updateCustomFormat(existing.id, payload);
    }
    await updateManagedRow(userId, target.managedRowId, { arrId, lastSyncHash: trashCfHash(cf) });
    item.applied = true;
  }
  return item;
}

async function planQualityProfile(
  target: Target,
  catalog: TrashCatalog,
  arrProfiles: ArrQualityProfile[],
  schema: ArrQualityProfileSchema,
  languages: ArrLanguage[] | undefined,
  cfMapByTrashId: Map<string, TrashCustomFormat>,
  inst: ResolvedInstance,
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const qp = catalog.qualityProfiles.find((p) => p.trash_id === target.trashId);
  if (!qp) {
    return skip(target, "This quality profile is no longer in the guide.");
  }
  const existing = arrProfiles.find((p) => p.name === qp.name);
  const { payload, warnings } = buildQualityProfile(
    qp,
    schema,
    inst.serviceType,
    cfMapByTrashId,
    existing?.id,
    languages,
  );
  const before = existing ? profileComparable(existing, inst.serviceType) : null;
  const after = profileComparable(payload, inst.serviceType);
  const diff = diffValues(before, after);
  const action = existing ? (diff.length ? "UPDATE" : "NOOP") : "CREATE";

  const item: PlanItem = {
    resourceType: "QUALITY_PROFILE",
    trashId: qp.trash_id,
    name: qp.name,
    action,
    diff,
    warnings,
  };

  if (!opts.dryRun) {
    let arrId = existing?.id ?? null;
    if (action === "CREATE") {
      const created = await client.createQualityProfile(payload);
      arrId = created.id ?? null;
    } else if (action === "UPDATE" && existing?.id !== undefined) {
      await client.updateQualityProfile(existing.id, payload);
    }
    await updateManagedRow(userId, target.managedRowId, { arrId, lastSyncHash: trashProfileHash(qp) });
    item.applied = true;
  }
  return item;
}

async function planQualityDefinition(
  target: Target,
  catalog: TrashCatalog,
  existingDefs: ArrQualityDefinition[],
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const qs = catalog.qualitySize;
  if (!qs || qs.trash_id !== target.trashId) {
    return skip(target, "Quality sizes are no longer in the guide.");
  }
  const newDefs = applyQualitySizes(qs, existingDefs);
  const before = qualityDefsComparable(existingDefs);
  const after = qualityDefsComparable(newDefs);
  const diff = diffValues(before, after);
  const action = diff.length ? "UPDATE" : "NOOP";

  const item: PlanItem = {
    resourceType: "QUALITY_DEFINITION",
    trashId: qs.trash_id,
    name: `Quality Sizes (${qs.type})`,
    action,
    diff,
    warnings: [],
  };

  if (!opts.dryRun) {
    if (action === "UPDATE") await client.updateQualityDefinitions(newDefs);
    await updateManagedRow(userId, target.managedRowId, {
      arrId: null,
      lastSyncHash: trashQualitySizeHash(qs),
    });
    item.applied = true;
  }
  return item;
}

async function planNaming(
  target: Target,
  catalog: TrashCatalog,
  existing: ArrNamingConfig,
  inst: ResolvedInstance,
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const naming = catalog.naming;
  if (!naming) return skip(target, "Naming schemes are no longer in the guide.");
  const selection = target.selection as NamingSelection | null;
  if (!selection || Object.keys(selection).length === 0) {
    return skip(target, "No naming variants selected — choose which formats to apply first.");
  }
  const newConfig = applyNaming(naming, selection, existing, inst.serviceType);
  const before = namingComparable(existing, inst.serviceType);
  const after = namingComparable(newConfig, inst.serviceType);
  const diff = diffValues(before, after);
  const action = diff.length ? "UPDATE" : "NOOP";

  const item: PlanItem = {
    resourceType: "NAMING",
    trashId: NAMING_TRASH_ID,
    name: "File / Folder Naming",
    action,
    diff,
    warnings: [],
  };

  if (!opts.dryRun) {
    if (action === "UPDATE") await client.updateNamingConfig(newConfig);
    await updateManagedRow(userId, target.managedRowId, {
      arrId: null,
      lastSyncHash: namingSelectionHash(naming, selection, inst.serviceType),
      selection,
    });
    item.applied = true;
  }
  return item;
}

function nonZeroFormatScores(items: ArrQualityProfile["formatItems"]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of items ?? []) if (f.score !== 0) out[f.name] = f.score;
  return out;
}

/**
 * Overlay custom-format scores onto a specific quality profile. Only the scores
 * for the assigned custom formats are changed; every other quality-profile
 * setting (qualities, cutoff, other format scores) is preserved. The target
 * profile may be one the user created directly in the app — it is matched by
 * name, and the row is skipped if that profile no longer exists.
 */
async function planProfileCf(
  target: Target,
  arrProfiles: ArrQualityProfile[],
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const profileName = target.trashId;
  const selection = (target.selection ?? null) as ProfileCfSelection | null;
  const formats = selection?.formats ?? [];

  const profile = arrProfiles.find((p) => p.name === profileName);
  if (!profile || profile.id === undefined) {
    return skip(target, `Quality profile "${profileName}" was not found on this instance.`);
  }

  const warnings: string[] = [];
  const present = new Set((profile.formatItems ?? []).map((f) => f.name));
  const desired = new Map(formats.map((f) => [f.name, f.score]));
  for (const f of formats) {
    if (!present.has(f.name)) {
      warnings.push(
        `Custom format "${f.name}" is not present in this instance — add & sync it to apply its score.`,
      );
    }
  }

  const newFormatItems = (profile.formatItems ?? []).map((fi) =>
    desired.has(fi.name) ? { ...fi, score: desired.get(fi.name)! } : fi,
  );
  const before = { formatScores: nonZeroFormatScores(profile.formatItems) };
  const after = { formatScores: nonZeroFormatScores(newFormatItems) };
  const diff = diffValues(before, after);
  const action = diff.length ? "UPDATE" : "NOOP";

  const item: PlanItem = {
    resourceType: "PROFILE_CF",
    trashId: profileName,
    name: profileName,
    action,
    diff,
    warnings,
  };

  if (!opts.dryRun) {
    if (action === "UPDATE") {
      await client.updateQualityProfile(profile.id, { ...profile, formatItems: newFormatItems });
    }
    await updateManagedRow(userId, target.managedRowId, {
      arrId: profile.id,
      lastSyncHash: hashDefinition(formats),
      selection,
    });
    item.applied = true;
  }
  return item;
}

function skip(target: Target, reason: string): PlanItem {
  return {
    resourceType: target.resourceType,
    trashId: target.trashId,
    name: target.name ?? target.trashId,
    action: "SKIP",
    diff: [],
    warnings: [reason],
  };
}
