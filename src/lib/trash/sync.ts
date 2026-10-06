import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { fetchTrashCatalog } from "./catalog";
import { guideClientFor, managedInstanceWhere, type ResolvedInstance } from "./status";
import { diffValues } from "./diff";
import {
  trashCfToArr,
  cfComparable,
  projectManagedFields,
  findManagedArrResource,
  applyQualitySizes,
  qualityDefsComparable,
  buildQualityProfile,
  profileComparable,
  applyNaming,
  namingComparable,
} from "./translate";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
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
  QualityProfileSelection,
  PlanItem,
  SyncReport,
  ArrCustomFormat,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  ArrQualityDefinition,
  ArrNamingConfig,
  ArrLanguage,
} from "./types";

type Selection = NamingSelection | ProfileCfSelection | QualityProfileSelection | null;

interface Target {
  resourceType: ResourceType;
  trashId: string;
  name?: string;
  selection?: Selection;
  managedRowId?: string;
  /** App id recorded at the last sync — finds the resource again after a rename. */
  arrId?: number | null;
}

/** A managed PROFILE_CF overlay: the profile it targets and its format scores. */
interface ProfileOverlay {
  profileName: string;
  arrId: number | null;
  formats: ProfileCfSelection["formats"];
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
  items?: Array<{
    resourceType: ResourceType;
    trashId: string;
    selection?: NamingSelection | ProfileCfSelection | QualityProfileSelection;
  }>;
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

// Serialize apply-syncs per instance: two concurrent applies could both read
// "no existing resource" and double-create. Dry-runs are read-only, so they
// don't take the lock. In-process is sufficient (the app runs a single node).
const instanceLocks = new Map<string, Promise<void>>();
async function withInstanceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = instanceLocks.get(key) ?? Promise.resolve();
  let done!: () => void;
  const next = new Promise<void>((res) => (done = res));
  instanceLocks.set(key, next);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    done();
    if (instanceLocks.get(key) === next) instanceLocks.delete(key);
  }
}

export async function runTrashSync(
  userId: string,
  inst: ResolvedInstance,
  opts: SyncOptions,
): Promise<SyncReport> {
  if (opts.dryRun) return runTrashSyncInner(userId, inst, opts);
  return withInstanceLock(`${inst.serviceType}:${inst.id}`, () =>
    runTrashSyncInner(userId, inst, opts),
  );
}

async function runTrashSyncInner(
  userId: string,
  inst: ResolvedInstance,
  opts: SyncOptions,
): Promise<SyncReport> {
  const catalog = await fetchTrashCatalog(inst.serviceType);
  const client = guideClientFor(inst);

  const targets = await resolveTargets(userId, inst, opts);
  const overlays = targets.some((t) => t.resourceType === "QUALITY_PROFILE")
    ? await loadProfileOverlays(userId, inst)
    : [];
  targets.sort((a, b) => RESOURCE_ORDER[a.resourceType] - RESOURCE_ORDER[b.resourceType]);

  // Lazily fetched instance state, cached per run. The PROMISE is cached, not
  // the value, so a failed read is remembered too: every target that needs it
  // fails at once (per-item try/catch turns that into an ERROR plan item)
  // instead of re-asking an unreachable instance and paying the client's whole
  // retry budget again for each of dozens of targets. Resolved arrays are
  // shared by reference, exactly as the cached values were.
  const cfMapByTrashId = new Map(catalog.customFormats.map((c) => [c.trash_id, c]));
  let arrCfs: Promise<ArrCustomFormat[]> | undefined;
  let arrProfiles: Promise<ArrQualityProfile[]> | undefined;
  let schema: Promise<ArrQualityProfileSchema> | undefined;
  let qualityDefs: Promise<ArrQualityDefinition[]> | undefined;
  let namingConfig: Promise<ArrNamingConfig> | undefined;
  let languages: Promise<ArrLanguage[]> | undefined;

  // Profiles read for PROFILE_CF overlays are fetched separately (and lazily)
  // so they capture any QUALITY_PROFILE writes made earlier in this same apply.
  let cfOverlayProfiles: Promise<ArrQualityProfile[]> | undefined;

  const getArrCfs = () => (arrCfs ??= client.getCustomFormats());
  const getArrProfiles = () => (arrProfiles ??= client.getQualityProfiles());
  const getSchema = () => (schema ??= client.getQualityProfileSchema());
  const getQualityDefs = () => (qualityDefs ??= client.getQualityDefinitions());
  const getNaming = () => (namingConfig ??= client.getNamingConfig());
  const getLanguages = () => (languages ??= client.getLanguages());
  const getCfOverlayProfiles = () => (cfOverlayProfiles ??= client.getQualityProfiles());

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
            await planQualityProfile(
              target,
              catalog,
              profiles,
              sch,
              langs,
              cfMapByTrashId,
              overlays,
              inst,
              opts,
              client,
              userId,
            ),
          );
          break;
        }
        case "QUALITY_DEFINITION":
          items.push(await planQualityDefinition(target, catalog, await getQualityDefs(), inst, opts, client, userId));
          break;
        case "NAMING":
          items.push(await planNaming(target, catalog, await getNaming(), inst, opts, client, userId));
          break;
        case "PROFILE_CF":
          items.push(
            await planProfileCf(target, await getCfOverlayProfiles(), cfMapByTrashId, opts, client, userId),
          );
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
        error: sanitizeErrorDetail(err instanceof Error ? err.message : undefined) ?? "Unknown error",
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
  const rows = await prisma.trashManagedResource.findMany({
    where: { userId, ...managedInstanceWhere(inst.serviceType, inst.id) },
  });

  // Dry-run of a specific set may include not-yet-assigned items (preview),
  // with the editor's unsaved selection. A managed item still carries the app id
  // its row recorded, or the preview could only match by name and would show a
  // CREATE (or "profile not found") for a renamed item the apply UPDATEs.
  if (opts.dryRun && opts.items?.length) {
    const arrIdByKey = new Map(rows.map((r) => [`${r.resourceType}:${r.trashId}`, r.arrId]));
    return opts.items.map((i) => ({
      resourceType: i.resourceType,
      trashId: i.trashId,
      selection: i.selection ?? null,
      arrId: arrIdByKey.get(`${i.resourceType}:${i.trashId}`) ?? null,
    }));
  }

  // Otherwise operate on the managed set — the consent gate. When `items` is
  // given (a per-item apply, e.g. "sync just this quality profile"), intersect
  // it with the managed rows so nothing outside the managed set is ever
  // written; the stored row selection/metadata is always used.
  let targets: Target[] = rows.map((r) => ({
    resourceType: r.resourceType as ResourceType,
    trashId: r.trashId,
    name: r.name,
    selection: (r.selection ?? null) as Selection,
    managedRowId: r.id,
    arrId: r.arrId,
  }));
  if (opts.items?.length) {
    const wanted = new Set(opts.items.map((i) => `${i.resourceType}:${i.trashId}`));
    targets = targets.filter((t) => wanted.has(`${t.resourceType}:${t.trashId}`));
  }
  return targets;
}

/**
 * Every managed PROFILE_CF overlay on the instance, whatever the run targets: a
 * quality-profile sync folds the overlay for its profile in (see
 * `BuildProfileOptions.scoreOverrides`), including on a per-item apply that
 * doesn't target the overlay itself.
 */
async function loadProfileOverlays(userId: string, inst: ResolvedInstance): Promise<ProfileOverlay[]> {
  const rows = await prisma.trashManagedResource.findMany({
    where: { userId, resourceType: "PROFILE_CF", ...managedInstanceWhere(inst.serviceType, inst.id) },
    select: { trashId: true, arrId: true, selection: true },
  });
  return rows.map((r) => ({
    profileName: r.trashId,
    arrId: r.arrId,
    formats: ((r.selection ?? null) as ProfileCfSelection | null)?.formats ?? [],
  }));
}

/** The current guide name of an overlay format — the stored name goes stale when the guide renames it. */
function overlayFormatName(
  f: ProfileCfSelection["formats"][number],
  cfMapByTrashId: Map<string, TrashCustomFormat>,
): string {
  return cfMapByTrashId.get(f.trashId)?.name ?? f.name;
}

const nameKey = (name: string) => name.trim().toLowerCase();

async function updateManagedRow(
  userId: string,
  managedRowId: string | undefined,
  data: { arrId?: number | null; lastSyncHash: string | null },
) {
  if (!managedRowId) return;
  // updateMany, not update: the row may have been unmanaged while this sync ran,
  // and by now the app write has landed — a P2025 would report it as an ERROR.
  // The selection is never written back: it is the one the run started with,
  // and an edit saved while the sync ran would be reverted to it.
  await prisma.trashManagedResource.updateMany({
    where: { id: managedRowId, userId },
    data: {
      ...(data.arrId !== undefined ? { arrId: data.arrId } : {}),
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
  const existing = findManagedArrResource(arrCfs, cf.name, target.arrId);
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
  overlays: ProfileOverlay[],
  inst: ResolvedInstance,
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const qp = catalog.qualityProfiles.find((p) => p.trash_id === target.trashId);
  if (!qp) {
    return skip(target, "This quality profile is no longer in the guide.");
  }
  const existing = findManagedArrResource(arrProfiles, qp.name, target.arrId);
  // The PROFILE_CF overlay targeting this profile — matched by name (either the
  // app's current one or the guide's) or by the profile id it last wrote to.
  const profileNames = new Set([nameKey(qp.name), ...(existing ? [nameKey(existing.name)] : [])]);
  const scoreOverrides = new Map<string, number>();
  for (const o of overlays) {
    const targetsThis =
      profileNames.has(nameKey(o.profileName)) ||
      (existing?.id !== undefined && o.arrId === existing.id);
    if (!targetsThis) continue;
    for (const f of o.formats) scoreOverrides.set(nameKey(overlayFormatName(f, cfMapByTrashId)), f.score);
  }
  // Per-profile options (score set + reset-unmatched-scores) live on the managed
  // row's selection. Dry-run previews may carry an unsaved selection.
  const selection = (target.selection ?? null) as QualityProfileSelection | null;
  const { payload, warnings, missingFormats } = buildQualityProfile(
    qp,
    schema,
    inst.serviceType,
    cfMapByTrashId,
    existing,
    languages,
    { ...(selection ?? {}), scoreOverrides },
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
    await updateManagedRow(userId, target.managedRowId, {
      arrId,
      // Guide scores left unapplied (their formats aren't in the app yet) mean
      // the profile is not in sync with the guide: record no hash, so status
      // keeps it "update available" until a sync applies them.
      lastSyncHash: missingFormats.length ? null : trashProfileHash(qp, cfMapByTrashId, selection),
    });
    item.applied = true;
  }
  return item;
}

async function planQualityDefinition(
  target: Target,
  catalog: TrashCatalog,
  existingDefs: ArrQualityDefinition[],
  inst: ResolvedInstance,
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const qs = catalog.qualitySize;
  if (!qs || qs.trash_id !== target.trashId) {
    return skip(target, "Quality sizes are no longer in the guide.");
  }
  const newDefs = applyQualitySizes(qs, existingDefs, inst.serviceType);
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
  cfMapByTrashId: Map<string, TrashCustomFormat>,
  opts: SyncOptions,
  client: ReturnType<typeof guideClientFor>,
  userId: string,
): Promise<PlanItem> {
  const profileName = target.trashId;
  const selection = (target.selection ?? null) as ProfileCfSelection | null;
  const formats = selection?.formats ?? [];

  // Matched by name, falling back to the profile id recorded at the last sync
  // so a renamed profile keeps its overlay.
  const profile = findManagedArrResource(arrProfiles, profileName, target.arrId);
  if (!profile || profile.id === undefined) {
    return skip(target, `Quality profile "${profileName}" was not found on this instance.`);
  }

  const warnings: string[] = [];
  // Format names resolve through the guide by trash_id (the stored name goes
  // stale on an upstream rename) and match case-insensitively, as the custom
  // format sync itself does.
  const present = new Set((profile.formatItems ?? []).map((f) => nameKey(f.name)));
  const desired = new Map<string, number>();
  for (const f of formats) {
    const name = overlayFormatName(f, cfMapByTrashId);
    desired.set(nameKey(name), f.score);
    if (!present.has(nameKey(name))) {
      warnings.push(
        `Custom format "${name}" is not present in this instance — add & sync it to apply its score.`,
      );
    }
  }

  const newFormatItems = (profile.formatItems ?? []).map((fi) =>
    desired.has(nameKey(fi.name)) ? { ...fi, score: desired.get(nameKey(fi.name))! } : fi,
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
