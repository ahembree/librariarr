-- AlterTable: add SSO linkage columns to User
ALTER TABLE "User" ADD COLUMN "ssoSubject" TEXT;
ALTER TABLE "User" ADD COLUMN "ssoProvider" TEXT;
ALTER TABLE "User" ADD COLUMN "ssoEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");

-- AlterTable: add SSO configuration columns to AppSettings
ALTER TABLE "AppSettings" ADD COLUMN "ssoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AppSettings" ADD COLUMN "ssoMode" TEXT NOT NULL DEFAULT 'OIDC';
ALTER TABLE "AppSettings" ADD COLUMN "oidcIssuer" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "oidcClientId" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "oidcClientSecret" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "oidcScopes" TEXT NOT NULL DEFAULT 'openid profile email';
ALTER TABLE "AppSettings" ADD COLUMN "oidcUsernameClaim" TEXT NOT NULL DEFAULT 'preferred_username';
ALTER TABLE "AppSettings" ADD COLUMN "forwardAuthUserHeader" TEXT NOT NULL DEFAULT 'Remote-User';
ALTER TABLE "AppSettings" ADD COLUMN "forwardAuthEmailHeader" TEXT NOT NULL DEFAULT 'Remote-Email';
ALTER TABLE "AppSettings" ADD COLUMN "forwardAuthNameHeader" TEXT NOT NULL DEFAULT 'Remote-Name';
