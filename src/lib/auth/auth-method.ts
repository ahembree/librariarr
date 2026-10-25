/**
 * The admin's primary sign-in method as a display label for the user chip,
 * mirroring how the login surfaces are gated: SSO when linked, else Plex, else
 * the local password.
 */
export function authMethodLabel(user: {
  plexId: string | null;
  ssoEnabled: boolean;
  ssoProvider: string | null;
}): string {
  if (user.ssoEnabled && user.ssoProvider) return user.ssoProvider;
  return user.plexId ? "Plex" : "Local";
}
