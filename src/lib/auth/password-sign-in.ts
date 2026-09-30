import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  getSsoSettings,
  isSsoOverrideActive,
  isSsoUsable,
  type SettingsReader,
  type SsoSettings,
} from "@/lib/sso/config";

/**
 * Whether the account password is accepted — for anything. One rule, the
 * local login's, shared by every place a password is proof: the login itself,
 * the API-key step-up, the in-place "Confirm it's you" (and whether it offers
 * the password at all), and the current-password check on a credential
 * change. Password sign-in is on while `localAuthEnabled` is on and SSO is
 * not usable (SSO replaces the local form); `SSO_DISABLE_OVERRIDE`, the
 * recovery path when SSO is down, turns it on regardless.
 *
 * While it is off the password is accepted for nothing: a stolen cookie plus
 * an old password must not get past a door the admin closed. Turning it back
 * on is itself refused without a recent sign-in (`turnsPasswordSignInOn`),
 * or the cookie could open the door first and then walk through it. The same
 * holds for Plex sign-in (`turnsPlexSignInOn`), which is turned off where a
 * household shares the Plex account.
 */
export interface PasswordSignInState {
  localAuthEnabled: boolean | null | undefined;
  sso: SsoSettings | null;
}

export function passwordSignInEnabled(state: PasswordSignInState): boolean {
  if (isSsoOverrideActive()) return true;
  return !!state.localAuthEnabled && !isSsoUsable(state.sso);
}

/** `db` is a transaction's client for a read under `lockSignInSettings`. */
export async function loadPasswordSignInState(db: SettingsReader = prisma): Promise<PasswordSignInState> {
  // One after the other: a transaction's client runs its queries in sequence.
  const settings = await db.appSettings.findFirst({ select: { localAuthEnabled: true } });
  const sso = await getSsoSettings(db);
  return { localAuthEnabled: settings?.localAuthEnabled, sso };
}

export async function isPasswordSignInEnabled(): Promise<boolean> {
  return passwordSignInEnabled(await loadPasswordSignInState());
}

/**
 * A settings change that would give an existing password its power back:
 * turning local login on, or turning off the SSO that was hiding it. The
 * routes that make such a change require a recent sign-in for it — confirmed
 * by some other method, since the password counts for nothing until then.
 */
export function turnsPasswordSignInOn(
  before: PasswordSignInState,
  after: PasswordSignInState,
  hasPassword: boolean,
): boolean {
  return hasPassword && !passwordSignInEnabled(before) && passwordSignInEnabled(after);
}

/**
 * Whether a Plex login is accepted — the rule `/api/auth/plex/token` and
 * `loadReauthContext` apply: the toggle, or `SSO_DISABLE_OVERRIDE`.
 */
export function plexSignInEnabled(plexLoginEnabled: boolean | null | undefined): boolean {
  return isSsoOverrideActive() || plexLoginEnabled !== false;
}

/**
 * Turning Plex login back on for an account with a linked Plex identity. Off
 * is where a household shares the Plex account, so whoever holds it could
 * sign in — or confirm "it's you" — once a stolen cookie switched it on: the
 * same recent sign-in as for the password.
 */
export function turnsPlexSignInOn(
  before: boolean | null | undefined,
  after: boolean | null | undefined,
  hasPlex: boolean,
): boolean {
  return hasPlex && !plexSignInEnabled(before) && plexSignInEnabled(after);
}

/**
 * Serialises the settings writes that can switch a way of signing in back on
 * — local login, turning SSO off (the save, revert and unlink), Plex login.
 * Each takes this lock inside its transaction, re-reads the state through the
 * transaction, applies its recent-sign-in check to that, and writes; the lock
 * is released at commit. Checked against a snapshot read outside it, two such
 * writes each passed on the other's old state — local login on while SSO hid
 * it, SSO off while local login was off — and together turned password
 * sign-in on without a recent sign-in.
 */
export async function lockSignInSettings(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('sign-in-settings'))`);
}
