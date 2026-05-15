/**
 * Admin auth-recovery CLI for the truly locked-out case.
 *
 * Use this when you can't sign in via Plex, local credentials, OR SSO and
 * the SSO_DISABLE_OVERRIDE env var doesn't help (no fallback credentials).
 * Requires shell access to the container and a working DATABASE_URL.
 *
 * Usage (inside the running container):
 *
 *   pnpm exec tsx scripts/reset-auth.ts status       # show current auth state
 *   pnpm exec tsx scripts/reset-auth.ts wipe-sso     # clear SSO config (keeps user, Plex, local)
 *   pnpm exec tsx scripts/reset-auth.ts enable-local # force-enable local form
 *   pnpm exec tsx scripts/reset-auth.ts enable-plex  # force-enable Plex login button
 *   pnpm exec tsx scripts/reset-auth.ts delete-user  # NUCLEAR: drop the user row, forces fresh setup
 *
 * The `delete-user` action triggers the setup screen on next page load but
 * keeps all media data (library sync, lifecycle rules, etc.) intact. Use as
 * a last resort when you can't otherwise recover access.
 */

import { PrismaClient, Prisma } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL must be set in the environment.");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

async function status() {
  const user = await prisma.user.findFirst({
    select: {
      id: true,
      username: true,
      localUsername: true,
      passwordHash: true,
      plexId: true,
      ssoSubject: true,
      ssoIssuer: true,
      ssoEnabled: true,
    },
  });
  const settings = await prisma.appSettings.findFirst({
    select: {
      localAuthEnabled: true,
      plexLoginEnabled: true,
      ssoEnabled: true,
      ssoMode: true,
      oidcIssuer: true,
      oidcClientId: true,
    },
  });

  if (!user) {
    console.log("No user exists. The login page will show the setup form.");
    return;
  }

  console.log("User:");
  console.log(`  display name:    ${user.username}`);
  console.log(`  local username:  ${user.localUsername ?? "(none)"}`);
  console.log(`  password set:    ${user.passwordHash ? "yes" : "no"}`);
  console.log(`  plex linked:    ${user.plexId ? "yes" : "no"}`);
  console.log(
    `  sso linked:     ${user.ssoSubject ? `yes (sub=${user.ssoSubject}, issuer=${user.ssoIssuer ?? "n/a"}, user.ssoEnabled=${user.ssoEnabled})` : "no"}`,
  );
  console.log("");
  console.log("AppSettings:");
  if (!settings) {
    console.log("  (no row -- defaults applied)");
  } else {
    console.log(`  localAuthEnabled:  ${settings.localAuthEnabled}`);
    console.log(`  plexLoginEnabled:  ${settings.plexLoginEnabled}`);
    console.log(`  ssoEnabled:        ${settings.ssoEnabled}`);
    console.log(`  ssoMode:           ${settings.ssoMode}`);
    console.log(`  oidcIssuer:        ${settings.oidcIssuer ?? "(empty)"}`);
    console.log(`  oidcClientId:      ${settings.oidcClientId ?? "(empty)"}`);
  }
}

async function wipeSso() {
  const settingsResult = await prisma.appSettings.updateMany({
    data: {
      ssoEnabled: false,
      ssoMode: "OIDC",
      oidcIssuer: null,
      oidcClientId: null,
      oidcClientSecret: null,
      // Json columns use Prisma.JsonNull as the explicit "set to JSON null"
      // sentinel; plain `null` is reserved for "don't touch this field."
      previousSsoConfig: Prisma.JsonNull,
    },
  });
  // Also unlink any user-level SSO state + bump sessionVersion so cookies
  // referencing the old SSO link can't be replayed.
  const userResult = await prisma.user.updateMany({
    data: {
      ssoSubject: null,
      ssoIssuer: null,
      ssoProvider: null,
      ssoEnabled: false,
      sessionVersion: { increment: 1 },
    },
  });
  console.log(
    `Wiped SSO config on ${settingsResult.count} AppSettings row(s) and ${userResult.count} User row(s).`,
  );
  console.log(
    "Restart the container so any cached discovery docs are dropped, then sign in via your remaining method (Plex or local).",
  );
}

async function enableLocal() {
  const result = await prisma.appSettings.updateMany({
    data: { localAuthEnabled: true },
  });
  console.log(
    `Set localAuthEnabled=true on ${result.count} AppSettings row(s). ` +
      `The local username/password form will appear on the login page (provided a password is set on the user record -- check with 'status' if unsure).`,
  );
}

async function enablePlex() {
  const result = await prisma.appSettings.updateMany({
    data: { plexLoginEnabled: true },
  });
  console.log(
    `Set plexLoginEnabled=true on ${result.count} AppSettings row(s). ` +
      `The "Sign in with Plex" button will appear on the login page (provided a Plex account is linked on the user record -- check with 'status').`,
  );
}

async function deleteUser() {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    console.log("No user to delete. The setup screen will already show.");
    return;
  }
  // ON DELETE CASCADE handles AppSettings, mediaServers, etc. Media data
  // attached to MediaServer (via library) also cascades -- so this *does*
  // wipe synced library content. If you want to keep media data, restore
  // from a backup that has a working user instead of using this option.
  const result = await prisma.user.deleteMany();
  console.log(
    `Deleted ${result.count} user(s). The setup screen will appear on next page load. ` +
      `Note: cascading deletes also dropped synced media data, server connections, and lifecycle rules. ` +
      `To preserve media data, prefer 'wipe-sso' or 'enable-local'/'enable-plex' if any credentials still exist.`,
  );
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "status":
      await status();
      break;
    case "wipe-sso":
      await wipeSso();
      break;
    case "enable-local":
      await enableLocal();
      break;
    case "enable-plex":
      await enablePlex();
      break;
    case "delete-user":
      await deleteUser();
      break;
    default:
      console.error(
        `Usage: pnpm exec tsx scripts/reset-auth.ts <status|wipe-sso|enable-local|enable-plex|delete-user>`,
      );
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
