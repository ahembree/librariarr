import { prisma } from "@/lib/db";
import { sanitizeErrorDetail } from "@/lib/api/sanitize";
import { GuideArrClient } from "./arr-guide-client";
import { fetchTrashCatalog } from "./catalog";
import { findArrCfByName, findArrProfileByName } from "./translate";
import { trashCfHash, trashProfileHash, trashQualitySizeHash, namingSelectionHash } from "./signature";
import { NAMING_TRASH_ID } from "./types";
import type {
  ServiceType,
  ResourceType,
  ItemStatus,
  TrashStatus,
  TrashStatusItem,
  NamingSelection,
  QualityProfileSelection,
} from "./types";

export interface ResolvedInstance {
  serviceType: ServiceType;
  id: string;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
}

/** DB filter selecting the managed rows for one instance. */
export function managedInstanceWhere(serviceType: ServiceType, instanceId: string) {
  return serviceType === "SONARR"
    ? { sonarrInstanceId: instanceId }
    : { radarrInstanceId: instanceId };
}

export async function resolveInstance(
  userId: string,
  serviceType: ServiceType,
  instanceId: string,
): Promise<ResolvedInstance | null> {
  if (serviceType === "SONARR") {
    const i = await prisma.sonarrInstance.findFirst({ where: { id: instanceId, userId } });
    return i ? { serviceType, id: i.id, name: i.name, url: i.url, apiKey: i.apiKey, enabled: i.enabled } : null;
  }
  const i = await prisma.radarrInstance.findFirst({ where: { id: instanceId, userId } });
  return i ? { serviceType, id: i.id, name: i.name, url: i.url, apiKey: i.apiKey, enabled: i.enabled } : null;
}

export function guideClientFor(inst: ResolvedInstance): GuideArrClient {
  return new GuideArrClient(inst.url, inst.apiKey, inst.serviceType);
}

/** Every Sonarr + Radarr instance the user has, tagged with its service type. */
export async function listGuideInstances(userId: string) {
  const [sonarr, radarr] = await Promise.all([
    prisma.sonarrInstance.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.radarrInstance.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
  ]);
  return [
    ...sonarr.map((i) => ({ serviceType: "SONARR" as const, id: i.id, name: i.name, enabled: i.enabled })),
    ...radarr.map((i) => ({ serviceType: "RADARR" as const, id: i.id, name: i.name, enabled: i.enabled })),
  ];
}

interface ManagedRow {
  id: string;
  resourceType: string;
  trashId: string;
  arrId: number | null;
  selection: unknown;
  lastSyncedAt: Date | null;
  lastSyncHash: string | null;
}

/** TRaSH descriptions embed HTML (`<br>`, etc.); render them as plain text. */
function cleanDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const text = desc
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length ? text : undefined;
}

function statusFor(
  existsInArr: boolean,
  managed: ManagedRow | undefined,
  currentHash: string | undefined,
  canGoMissing: boolean,
): ItemStatus {
  if (managed) {
    if (canGoMissing && !existsInArr) return "MANAGED_MISSING";
    // Never synced yet (e.g. an existing resource just taken over) — it hasn't
    // been reconciled with the guide, so surface it as needing a sync rather
    // than green "in sync".
    if (!managed.lastSyncHash) return "MANAGED_OUTDATED";
    if (currentHash && managed.lastSyncHash !== currentHash) {
      return "MANAGED_OUTDATED";
    }
    return "MANAGED";
  }
  return existsInArr ? "UNMANAGED_CONFLICT" : "NEW";
}

/**
 * Cross-reference the guide catalog, the instance's live resources, and the
 * user's managed rows into a per-item status list that drives the UI. When the
 * instance is unreachable, returns `reachable: false` with an error instead of
 * throwing so the page can still render.
 */
export async function computeTrashStatus(
  userId: string,
  inst: ResolvedInstance,
): Promise<TrashStatus> {
  const client = guideClientFor(inst);

  const managedRows = (await prisma.trashManagedResource.findMany({
    where: { userId, ...managedInstanceWhere(inst.serviceType, inst.id) },
  })) as ManagedRow[];
  const managedByKey = new Map<string, ManagedRow>();
  for (const m of managedRows) {
    managedByKey.set(`${m.resourceType}:${m.trashId}`, m);
  }
  const keyOf = (rt: ResourceType, trashId: string) => managedByKey.get(`${rt}:${trashId}`);
  // PROFILE_CF assignments aren't cross-referenced into `items` (they live in the
  // Profile Formats tab), but they ARE managed resources a full sync writes — so
  // surface their count for the managed total / global sync buttons.
  const managedProfileCf = managedRows.filter((m) => m.resourceType === "PROFILE_CF").length;

  // Load the guide catalog. A guide (GitHub) outage must not blank the whole
  // page when the Arr instance itself is fine — report it as a distinct
  // `catalogError` so the instance stays selected and the user can retry.
  let catalog;
  try {
    catalog = await fetchTrashCatalog(inst.serviceType);
  } catch (err) {
    return {
      serviceType: inst.serviceType,
      instanceId: inst.id,
      instanceName: inst.name,
      reachable: true,
      items: [],
      managedProfileCf,
      catalogError:
        sanitizeErrorDetail(err instanceof Error ? err.message : undefined) ??
        "The TRaSH guide catalog is temporarily unavailable.",
    };
  }
  const cfMapByTrashId = new Map(catalog.customFormats.map((c) => [c.trash_id, c]));

  let arrCfs, arrProfiles;
  try {
    [arrCfs, arrProfiles] = await Promise.all([
      client.getCustomFormats(),
      client.getQualityProfiles(),
    ]);
  } catch (err) {
    return {
      serviceType: inst.serviceType,
      instanceId: inst.id,
      instanceName: inst.name,
      reachable: false,
      error:
        sanitizeErrorDetail(err instanceof Error ? err.message : undefined) ??
        "Unable to reach instance",
      items: [],
      managedProfileCf,
    };
  }

  const items: TrashStatusItem[] = [];

  for (const cf of catalog.customFormats) {
    const existing = findArrCfByName(arrCfs, cf.name);
    const m = keyOf("CUSTOM_FORMAT", cf.trash_id);
    items.push({
      resourceType: "CUSTOM_FORMAT",
      trashId: cf.trash_id,
      name: cf.name,
      status: statusFor(!!existing, m, trashCfHash(cf), true),
      existsInArr: !!existing,
      managed: !!m,
      arrId: existing?.id ?? m?.arrId ?? null,
      managedResourceId: m?.id,
      lastSyncedAt: m?.lastSyncedAt?.toISOString() ?? null,
    });
  }

  for (const qp of catalog.qualityProfiles) {
    const existing = findArrProfileByName(arrProfiles, qp.name);
    const m = keyOf("QUALITY_PROFILE", qp.trash_id);
    items.push({
      resourceType: "QUALITY_PROFILE",
      trashId: qp.trash_id,
      name: qp.name,
      description: cleanDescription(qp.trash_description),
      status: statusFor(
        !!existing,
        m,
        trashProfileHash(qp, cfMapByTrashId, (m?.selection ?? null) as QualityProfileSelection | null),
        true,
      ),
      existsInArr: !!existing,
      managed: !!m,
      arrId: existing?.id ?? m?.arrId ?? null,
      managedResourceId: m?.id,
      lastSyncedAt: m?.lastSyncedAt?.toISOString() ?? null,
      // Per-profile options (score set / reset-unmatched-scores) so the UI can
      // prefill the options dialog for a managed profile.
      selection: (m?.selection ?? null) as QualityProfileSelection | null,
    });
  }

  // Quality sizes + naming always exist on an instance, so they can never be
  // "NEW" or "MISSING" — only unmanaged (needs consent) or managed.
  if (catalog.qualitySize) {
    const qs = catalog.qualitySize;
    const m = keyOf("QUALITY_DEFINITION", qs.trash_id);
    items.push({
      resourceType: "QUALITY_DEFINITION",
      trashId: qs.trash_id,
      name: `Quality Sizes (${qs.type})`,
      description: "Per-quality min / preferred / max file sizes",
      status: statusFor(true, m, trashQualitySizeHash(qs), false),
      existsInArr: true,
      managed: !!m,
      arrId: null,
      managedResourceId: m?.id,
      lastSyncedAt: m?.lastSyncedAt?.toISOString() ?? null,
    });
  }

  if (catalog.naming) {
    const m = keyOf("NAMING", NAMING_TRASH_ID);
    const selection = (m?.selection ?? null) as NamingSelection | null;
    const currentHash = selection
      ? namingSelectionHash(catalog.naming, selection, inst.serviceType)
      : undefined;
    items.push({
      resourceType: "NAMING",
      trashId: NAMING_TRASH_ID,
      name: "File / Folder Naming",
      description: "Recommended media naming scheme",
      status: statusFor(true, m, currentHash, false),
      existsInArr: true,
      managed: !!m,
      arrId: null,
      managedResourceId: m?.id,
      lastSyncedAt: m?.lastSyncedAt?.toISOString() ?? null,
      selection,
    });
  }

  return {
    serviceType: inst.serviceType,
    instanceId: inst.id,
    instanceName: inst.name,
    reachable: true,
    items,
    managedProfileCf,
  };
}
