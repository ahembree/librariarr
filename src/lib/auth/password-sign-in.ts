import { prisma } from "@/lib/db";
import { getSsoSettings, isSsoOverrideActive, isSsoUsable, type SsoSettings } from "@/lib/sso/config";

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
 * or the cookie could open the door first and then walk through it.
 */
export interface PasswordSignInState {
  localAuthEnabled: boolean | null | undefined;
  sso: SsoSettings | null;
}

export function passwordSignInEnabled(state: PasswordSignInState): boolean {
  if (isSsoOverrideActive()) return true;
  return !!state.localAuthEnabled && !isSsoUsable(state.sso);
}

export async function loadPasswordSignInState(): Promise<PasswordSignInState> {
  const [settings, sso] = await Promise.all([
    prisma.appSettings.findFirst({ select: { localAuthEnabled: true } }),
    getSsoSettings(),
  ]);
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
