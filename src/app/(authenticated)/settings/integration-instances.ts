import { MASKED_VALUE } from "@/lib/api/sanitize";
import { stripTrailingSlashes } from "@/lib/url-normalize";

/**
 * The integration instance types Settings → Integrations lists, in the order
 * it lists them. Each answers the same routes (`src/lib/integrations/
 * instance-routes.ts`): `/api/integrations/<type>` and `/<type>/[id]`.
 */
export const INTEGRATION_TYPES = ["sonarr", "radarr", "lidarr", "seerr", "tracearr"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** A saved instance as `GET /api/integrations/<type>` lists it (key masked). */
export interface IntegrationInstance {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  /** Absent on Tracearr, which has no browser-facing URL. */
  externalUrl?: string | null;
  enabled: boolean;
  createdAt: string;
}

/** What an add or edit form holds. `externalUrl` stays "" for a type without one. */
export interface InstanceForm {
  name: string;
  url: string;
  apiKey: string;
  externalUrl: string;
}

export const EMPTY_INSTANCE_FORM: InstanceForm = { name: "", url: "", apiKey: "", externalUrl: "" };

/** How one type's forms behave; everything else about the types is copy. */
export interface IntegrationBehavior {
  type: IntegrationType;
  /** The app's name in messages: "Sonarr instance added". */
  label: string;
  /** Whether the type stores an External URL for "Open in" links. */
  hasExternalUrl: boolean;
  /**
   * Whether the add form has a Test button whose pass Save waits for. Tracearr
   * has no unsaved-instance test route, so its create tests the connection
   * itself and the form shows the failure.
   */
  testBeforeAdd: boolean;
  /** The enable toggle's toast: "<noun> enabled", "Failed to update <noun>". */
  toggleNoun: string;
}

/** A key the form holds that is no new key: blank, or the mask a GET returned. */
function isNewKey(apiKey: string): boolean {
  return apiKey !== "" && apiKey !== MASKED_VALUE;
}

const withoutTrailingSlash = (url: string) => stripTrailingSlashes(url.trim());

/**
 * Whether an edit changes how the instance is reached: a new API key, or a URL
 * other than the stored one. Only such an edit has to pass a connection test
 * before it can be saved — a rename or a new external URL must stay possible
 * while the instance is down (the route re-tests on the same rule).
 */
export function changesConnection(form: Pick<InstanceForm, "url" | "apiKey">, stored: { url: string }): boolean {
  return isNewKey(form.apiKey) || withoutTrailingSlash(form.url) !== withoutTrailingSlash(stored.url);
}

/** The edit form for a saved instance: its values, with no key (blank keeps the stored one). */
export function editFormOf(instance: IntegrationInstance): InstanceForm {
  return { name: instance.name, url: instance.url, apiKey: "", externalUrl: instance.externalUrl ?? "" };
}

/** `POST /api/integrations/<type>`'s body. */
export function addRequestBody(form: InstanceForm, behavior: Pick<IntegrationBehavior, "hasExternalUrl">) {
  const { name, url, apiKey, externalUrl } = form;
  return behavior.hasExternalUrl ? { name, url, apiKey, externalUrl } : { name, url, apiKey };
}

/**
 * `PUT /api/integrations/<type>/[id]`'s body: the fields the form fills, and
 * the External URL only when it differs from the stored one — one stored
 * under an older, looser rule must not make every rename or re-point fail
 * validation.
 */
export function editRequestBody(
  form: InstanceForm,
  stored: IntegrationInstance | undefined,
  behavior: Pick<IntegrationBehavior, "hasExternalUrl">,
): Record<string, string> {
  const body: Record<string, string> = {};
  if (form.name) body.name = form.name;
  if (form.url) body.url = form.url;
  if (isNewKey(form.apiKey)) body.apiKey = form.apiKey;
  if (behavior.hasExternalUrl && form.externalUrl !== (stored?.externalUrl ?? "")) body.externalUrl = form.externalUrl;
  return body;
}

/**
 * `POST /api/integrations/<type>/[id]/test-connection`'s body: what is on
 * screen, with neither a blank nor a masked key sent — the route uses the
 * stored key for both.
 */
export function testConnectionBody(overrides: { url?: string; apiKey?: string }): Record<string, string> {
  const body: Record<string, string> = {};
  if (overrides.url) body.url = overrides.url;
  if (overrides.apiKey && isNewKey(overrides.apiKey)) body.apiKey = overrides.apiKey;
  return body;
}
