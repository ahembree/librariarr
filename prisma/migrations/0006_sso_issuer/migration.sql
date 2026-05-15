-- Add ssoIssuer column and switch from a single-column unique on ssoSubject
-- to a composite unique on (ssoSubject, ssoIssuer).
--
-- Background: previously, the OIDC callback looked users up by ssoSubject
-- alone. If the admin linked a sub like "abc" while the configured IdP was
-- Authentik, then later switched the issuer to Authelia (without unlinking),
-- any Authelia user with sub "abc" could log in as the linked admin -- a
-- cross-IdP collision admin-takeover.
--
-- The new composite key requires both subject AND issuer to match. The
-- callback reads ssoIssuer from current settings at login time and only
-- accepts a row whose stored ssoIssuer matches.
--
-- Backfill strategy: leave existing rows with ssoIssuer = NULL. The OIDC
-- callback handles the migration transparently — on the first SSO login
-- after upgrade, if the matched user has a NULL ssoIssuer, the callback
-- writes the current configured issuer in. Subsequent logins use strict
-- matching. (Single-admin app, so the brief window between upgrade and
-- the admin's first SSO login is the only exposure.)

ALTER TABLE "User" ADD COLUMN "ssoIssuer" TEXT;

DROP INDEX "User_ssoSubject_key";

CREATE UNIQUE INDEX "User_ssoSubject_ssoIssuer_key" ON "User"("ssoSubject", "ssoIssuer");
