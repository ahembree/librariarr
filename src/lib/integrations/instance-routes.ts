import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod/v4";
import { withSession } from "@/lib/auth/with-session";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { appCache } from "@/lib/cache/memory-cache";
import { jsonResponse } from "@/lib/api/json-response";
import { MASKED_VALUE, sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
import { refuseStoredKeyToNewUrl } from "@/lib/integrations/stored-key-guard";
import { detachDeletedArrInstance } from "@/lib/arr/detach-instance";
import { invalidateArrMetadataCache } from "@/lib/lifecycle/fetch-arr-metadata";
import { RadarrClient } from "@/lib/arr/radarr-client";
import { SonarrClient } from "@/lib/arr/sonarr-client";
import { LidarrClient } from "@/lib/arr/lidarr-client";
import { SeerrClient } from "@/lib/seerr/seerr-client";
import { invalidateSeerrCaches } from "@/lib/seerr/request-stats";
import { TracearrClient } from "@/lib/tracearr/tracearr-client";
import {
  validateRequest,
  arrInstanceCreateSchema,
  arrInstanceUpdateSchema,
  arrTestSchema,
  arrTestConnectionSchema,
  seerrInstanceCreateSchema,
  seerrInstanceUpdateSchema,
  tracearrInstanceCreateSchema,
  tracearrInstanceUpdateSchema,
} from "@/lib/validation";
import { stripTrailingSlashes } from "@/lib/url-normalize";

/**
 * The routes every integration instance type answers — the list and create,
 * the edit and delete, the connection tests and (for the Arr apps) the recycle
 * bin probe and the cached metadata — built from one definition per type.
 *
 * The five types' route files were near-copies of each other (~1,100 lines),
 * and the copies had drifted: Seerr and Tracearr reported a failed re-test as
 * "Failed to connect" where the Arr types named the app, and only Tracearr
 * treated the masked key the settings form echoes back as "keep the stored
 * key" — an Arr or Seerr edit that echoed it tested the literal mask and, with
 * the instance disabled, saved it as the key. Every type now does what the
 * best copy did.
 *
 * What every route keeps, exactly:
 * - `refuseStoredKeyToNewUrl` before any request that would send the STORED
 *   key to a new URL (see stored-key-guard.ts);
 * - an edit re-tests the connection only when the URL (trailing slashes aside)
 *   or the key changes, and never for an instance being turned off;
 * - every instance in a response goes through `sanitize()`, every failed
 *   test's error through `sanitizeErrorDetail`;
 * - the External URL is validated by `externalLinkUrlSchema` in the schemas.
 *
 * Each builder declares its handlers as `const METHOD = withSession(…)` on
 * purpose: `tests/unit/auth/reauth-callers.test.ts` finds the routes that can
 * answer `reauth_required` by reading the guard call in each method's body,
 * and follows a route file's `export const { … } = builder(…)` into the
 * builder.
 */

export type IntegrationType = "radarr" | "sonarr" | "lidarr" | "seerr" | "tracearr";

type RouteContext = { params: Promise<{ id: string }> };

interface ConnectionResult {
  ok: boolean;
  error?: string;
}

interface ConnectionClient {
  testConnection(): Promise<ConnectionResult>;
}

/** The columns every instance model has (Tracearr's has no External URL). */
export interface InstanceRow {
  id: string;
  userId: string;
  name: string;
  url: string;
  apiKey: string;
  externalUrl?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface InstanceCreateInput {
  name: string;
  url: string;
  apiKey: string;
  externalUrl?: string;
}

interface InstanceUpdateInput {
  name?: string;
  url?: string;
  apiKey?: string;
  externalUrl?: string;
  enabled?: boolean;
}

/**
 * The five instance models share every column the routes read and write, so
 * they are driven through one delegate shape rather than five typed copies.
 */
interface InstanceDelegate {
  findMany(args: unknown): Promise<InstanceRow[]>;
  findFirst(args: unknown): Promise<InstanceRow | null>;
  create(args: unknown): Promise<InstanceRow>;
  update(args: unknown): Promise<InstanceRow>;
  delete(args: unknown): Promise<InstanceRow>;
}

type InstanceModel = "radarrInstance" | "sonarrInstance" | "lidarrInstance" | "seerrInstance" | "tracearrInstance";

export interface IntegrationConfig<C extends ConnectionClient = ConnectionClient> {
  type: IntegrationType;
  /** The app's name in messages: "Failed to connect to Radarr". */
  label: string;
  model: InstanceModel;
  client: (url: string, apiKey: string) => C;
  createSchema: z.ZodType<InstanceCreateInput>;
  updateSchema: z.ZodType<InstanceUpdateInput>;
  /** Whether the model stores a browser-facing External URL. */
  hasExternalUrl: boolean;
  /**
   * The Arr apps only: lifecycle rule sets and actions name the instance by a
   * plain id, so the delete detaches them in the same transaction.
   */
  detachOnDelete: boolean;
  /** After a create, edit or delete — Seerr drops its request caches. */
  afterChange?: () => void;
}

export const RADARR: IntegrationConfig<RadarrClient> = {
  type: "radarr",
  label: "Radarr",
  model: "radarrInstance",
  client: (url, apiKey) => new RadarrClient(url, apiKey),
  createSchema: arrInstanceCreateSchema,
  updateSchema: arrInstanceUpdateSchema,
  hasExternalUrl: true,
  detachOnDelete: true,
};

export const SONARR: IntegrationConfig<SonarrClient> = {
  type: "sonarr",
  label: "Sonarr",
  model: "sonarrInstance",
  client: (url, apiKey) => new SonarrClient(url, apiKey),
  createSchema: arrInstanceCreateSchema,
  updateSchema: arrInstanceUpdateSchema,
  hasExternalUrl: true,
  detachOnDelete: true,
};

export const LIDARR: IntegrationConfig<LidarrClient> = {
  type: "lidarr",
  label: "Lidarr",
  model: "lidarrInstance",
  client: (url, apiKey) => new LidarrClient(url, apiKey),
  createSchema: arrInstanceCreateSchema,
  updateSchema: arrInstanceUpdateSchema,
  hasExternalUrl: true,
  detachOnDelete: true,
};

export const SEERR: IntegrationConfig<SeerrClient> = {
  type: "seerr",
  label: "Seerr",
  model: "seerrInstance",
  client: (url, apiKey) => new SeerrClient(url, apiKey),
  createSchema: seerrInstanceCreateSchema,
  updateSchema: seerrInstanceUpdateSchema,
  hasExternalUrl: true,
  detachOnDelete: false,
  afterChange: invalidateSeerrCaches,
};

export const TRACEARR: IntegrationConfig<TracearrClient> = {
  type: "tracearr",
  label: "Tracearr",
  model: "tracearrInstance",
  client: (url, apiKey) => new TracearrClient(url, apiKey),
  createSchema: tracearrInstanceCreateSchema,
  updateSchema: tracearrInstanceUpdateSchema,
  hasExternalUrl: false,
  detachOnDelete: false,
};

/** Every instance type, in the order the settings page and the instances route list them. */
export const INTEGRATIONS = { sonarr: SONARR, radarr: RADARR, lidarr: LIDARR, seerr: SEERR, tracearr: TRACEARR } as const;

function delegateOf(config: IntegrationConfig, db: Prisma.TransactionClient = prisma): InstanceDelegate {
  return (db as unknown as Record<InstanceModel, InstanceDelegate>)[config.model];
}

/**
 * The key a request brings, or `undefined` for "keep the stored one": the
 * settings form shows the stored key masked and echoes whatever it holds back,
 * so `MASKED_VALUE` (or a blank field) is no new key — the stored-key guard
 * already reads both that way.
 */
function newApiKey(apiKey: string | undefined): string | undefined {
  return apiKey === undefined || apiKey === "" || apiKey === MASKED_VALUE ? undefined : apiKey;
}

const failedToConnect = (config: IntegrationConfig, result: ConnectionResult) =>
  NextResponse.json(
    { error: `Failed to connect to ${config.label}`, detail: sanitizeErrorDetail(result.error) },
    { status: 400 },
  );
/** A test's answer as the client gave it, its error scrubbed. */
const testResponse = (result: ConnectionResult) =>
  NextResponse.json(result.ok ? result : { ...result, error: sanitizeErrorDetail(result.error) });

/** The user's instances of a type, newest first. */
export function listInstances(
  config: IntegrationConfig,
  userId: string,
  options?: { enabledOnly?: boolean },
): Promise<InstanceRow[]> {
  return delegateOf(config).findMany({
    where: { userId, ...(options?.enabledOnly ? { enabled: true } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Something an instance's cached reads depend on changed (its URL, key,
 * enabled state, or the instance itself).
 */
function instanceChanged(config: IntegrationConfig, id: string): void {
  invalidateInstanceMetadata(config.type, id);
  // The rule editor's preview, diff and Test Media read Arr data through a
  // short cache; an edited or deleted instance must not answer from it.
  if (config.detachOnDelete) invalidateArrMetadataCache();
  config.afterChange?.();
}

/** `GET` (the user's instances) and `POST` (add one, after a passing test). */
export function instanceCollectionRoutes(config: IntegrationConfig) {
  // Reads no request: the settings bundle runs this handler with no
  // arguments, as it runs every bundled one.
  const GET = withSession(async (session) => {
    const instances = await listInstances(config, session.userId);
    return NextResponse.json({ instances: sanitize(instances) });
  });

  const POST = withSession(async (session, request: NextRequest) => {
    const { data, error } = await validateRequest(request, config.createSchema);
    if (error) return error;
    const { name, url, apiKey, externalUrl } = data;

    const result = await config.client(url, apiKey).testConnection();
    if (!result.ok) return failedToConnect(config, result);

    const instance = await delegateOf(config).create({
      data: {
        userId: session.userId,
        name,
        url: stripTrailingSlashes(url),
        apiKey,
        ...(config.hasExternalUrl && { externalUrl: externalUrl ? stripTrailingSlashes(externalUrl) : null }),
      },
    });
    // A new instance changes what an unscoped Arr read covers, so the preview
    // cache must not answer from the instances that existed before it.
    instanceChanged(config, instance.id);

    return NextResponse.json({ instance: sanitize(instance) }, { status: 201 });
  });

  return { GET, POST };
}

/** `PUT` (edit, re-testing a changed connection) and `DELETE` for one instance. */
export function instanceItemRoutes(config: IntegrationConfig) {
  const PUT = withSession(async (session, request: NextRequest, { params }: RouteContext) => {
    const { id } = await params;

    const { data, error } = await validateRequest(request, config.updateSchema);
    if (error) return error;
    const { name, url, externalUrl, enabled } = data;
    const apiKey = newApiKey(data.apiKey);

    const existing = await delegateOf(config).findFirst({ where: { id, userId: session.userId } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const refused = await refuseStoredKeyToNewUrl(session, existing.url, url, apiKey, config.label);
    if (refused) return refused;

    // Test the connection only when it changes — a new URL or API key (skip if
    // just toggling enabled). The edit form sends its URL on every save, so
    // testing on its mere presence refused a rename or a new external URL
    // whenever the instance happened to be unreachable.
    const urlChanged = url !== undefined && stripTrailingSlashes(url) !== existing.url;
    if ((urlChanged || apiKey) && enabled !== false) {
      const result = await config.client(url ?? existing.url, apiKey ?? existing.apiKey).testConnection();
      if (!result.ok) return failedToConnect(config, result);
    }

    const instance = await delegateOf(config).update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(url && { url: stripTrailingSlashes(url) }),
        ...(apiKey && { apiKey }),
        ...(config.hasExternalUrl &&
          externalUrl !== undefined && { externalUrl: externalUrl ? stripTrailingSlashes(externalUrl) : null }),
        ...(enabled !== undefined && { enabled }),
      },
    });
    instanceChanged(config, id);

    return NextResponse.json({ instance: sanitize(instance) });
  });

  const DELETE = withSession(async (session, _request: NextRequest, { params }: RouteContext) => {
    const { id } = await params;

    const existing = await delegateOf(config).findFirst({ where: { id, userId: session.userId } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (config.detachOnDelete) {
      await prisma.$transaction(async (tx) => {
        await detachDeletedArrInstance(tx, session.userId, id, config.label);
        await delegateOf(config, tx).delete({ where: { id } });
      });
    } else {
      await delegateOf(config).delete({ where: { id } });
    }
    instanceChanged(config, id);

    return NextResponse.json({ success: true });
  });

  return { PUT, DELETE };
}

/** `POST [id]/test-connection`: re-test a saved instance, optionally at a new URL or key. */
export function instanceTestConnectionRoutes(config: IntegrationConfig) {
  const POST = withSession(async (session, request: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    const { data, error } = await validateRequest(request, arrTestConnectionSchema);
    if (error) return error;
    const apiKey = newApiKey(data.apiKey);

    const existing = await delegateOf(config).findFirst({ where: { id, userId: session.userId } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const refused = await refuseStoredKeyToNewUrl(session, existing.url, data.url, apiKey, config.label);
    if (refused) return refused;

    const result = await config.client(data.url ?? existing.url, apiKey ?? existing.apiKey).testConnection();
    return testResponse(result);
  });

  return { POST };
}

/** `POST test`: test an unsaved URL and key (the add form). */
export function instanceTestRoutes(config: IntegrationConfig) {
  const POST = withSession(async (session, request: NextRequest) => {
    const { data, error } = await validateRequest(request, arrTestSchema);
    if (error) return error;

    return testResponse(await config.client(data.url, data.apiKey).testConnection());
  });

  return { POST };
}

interface RecycleBinClient extends ConnectionClient {
  getMediaManagementConfig(): Promise<{ recycleBin?: string | null; recycleBinCleanupDays?: number }>;
}

/**
 * `GET [id]/recycle-bin` (Arr apps): whether the app keeps deleted files in a
 * recycle bin. `arrUrl` is the browser-facing base the rule editor links to.
 */
export function instanceRecycleBinRoutes(config: IntegrationConfig<RecycleBinClient>) {
  const GET = withSession(async (session, _request: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    const instance = await delegateOf(config).findFirst({ where: { id, userId: session.userId } });
    if (!instance) return NextResponse.json({ error: "Instance not found" }, { status: 404 });

    const arrUrl = instance.externalUrl || instance.url;
    try {
      const mediaConfig = await config.client(instance.url, instance.apiKey).getMediaManagementConfig();
      const path = mediaConfig.recycleBin ?? null;
      return NextResponse.json({
        enabled: !!path && path.trim().length > 0,
        path,
        cleanupDays: mediaConfig.recycleBinCleanupDays,
        arrUrl,
      });
    } catch (error: unknown) {
      const fallback = `Failed to query ${config.label}`;
      const raw = error instanceof Error ? error.message : fallback;
      return NextResponse.json({ enabled: null, error: sanitizeErrorDetail(raw) ?? fallback, arrUrl });
    }
  });

  return { GET };
}

// ─── Instance metadata (dropdown values) ───

/**
 * How long an instance's metadata answer is kept: the rule editor and the
 * Query page read it on every visit and every instance pick, and each read
 * walked the app's whole library (every movie, series or artist) to list a
 * few tags and profiles.
 */
export const INSTANCE_METADATA_TTL_MS = 60_000;
const METADATA_CACHE_PREFIX = "integration-metadata:";
const metadataKey = (type: IntegrationType, id: string) => `${METADATA_CACHE_PREFIX}${type}:${id}`;

export function invalidateInstanceMetadata(type: IntegrationType, id: string): void {
  appCache.invalidate(metadataKey(type, id));
}

export type InstanceMetadataResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * An instance's metadata, computed by `load` once per instance per
 * `INSTANCE_METADATA_TTL_MS` however many readers ask together. A failure is
 * answered (scrubbed) but never kept.
 */
export function readInstanceMetadata<C extends ConnectionClient>(
  config: IntegrationConfig<C>,
  instance: InstanceRow,
  load: (client: C, instance: InstanceRow) => Promise<Record<string, unknown>>,
): Promise<InstanceMetadataResult> {
  return appCache.getOrSet<InstanceMetadataResult>(
    metadataKey(config.type, instance.id),
    async () => {
      try {
        return { ok: true, body: await load(config.client(instance.url, instance.apiKey), instance) };
      } catch (err: unknown) {
        const fallback = `Failed to query ${config.label}`;
        const raw = err instanceof Error ? err.message : fallback;
        return { ok: false, error: sanitizeErrorDetail(raw) ?? fallback };
      }
    },
    INSTANCE_METADATA_TTL_MS,
    { shouldCache: (result) => result.ok },
  );
}

/** `GET [id]/metadata`: the instance's dropdown values, cached (`readInstanceMetadata`). */
export function instanceMetadataRoutes<C extends ConnectionClient>(
  config: IntegrationConfig<C>,
  load: (client: C, instance: InstanceRow) => Promise<Record<string, unknown>>,
) {
  const GET = withSession(async (session, request: NextRequest, { params }: RouteContext) => {
    const { id } = await params;
    const instance = await delegateOf(config).findFirst({ where: { id, userId: session.userId } });
    if (!instance) return NextResponse.json({ error: "Instance not found" }, { status: 404 });

    const result = await readInstanceMetadata(config, instance, load);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return jsonResponse(request, result.body);
  });

  return { GET };
}
