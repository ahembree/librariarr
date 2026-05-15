#!/usr/bin/env node
/**
 * Admin auth-recovery CLI for the truly locked-out case.
 *
 * Use this when you can't sign in via Plex, local credentials, OR SSO and
 * the SSO_DISABLE_OVERRIDE env var doesn't help (no fallback credentials).
 * Requires shell access to the container and a working DATABASE_URL.
 *
 * Usage (inside the running container):
 *
 *   node scripts/reset-auth.js status       # show current auth state
 *   node scripts/reset-auth.js wipe-sso     # clear SSO config (keeps user, Plex, local)
 *   node scripts/reset-auth.js enable-local # force-enable local form
 *   node scripts/reset-auth.js enable-plex  # force-enable Plex login button
 *   node scripts/reset-auth.js delete-user  # NUCLEAR: drop the user row, forces fresh setup
 *
 * Destructive actions (wipe-sso, delete-user) prompt for confirmation in
 * interactive shells. Pass `--force` to skip the prompt (for automation),
 * or pipe `yes |` into the command.
 *
 * Plain Node + pg with no TypeScript runner so it works in any container
 * that has node 18+ and the pg module. Avoids depending on tsx, the Prisma
 * client, or the generated client output being copied into the image.
 */

const { createInterface } = require("readline");
const { Client } = require("pg");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL must be set in the environment.");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

/** Prompt the operator for "yes" before a destructive action. Skipped when
 *  the `--force` flag is on the command line, for automation. Reads from
 *  stdin so piping `yes |` also works. */
async function confirm(prompt) {
  if (process.argv.includes("--force")) return true;
  if (!process.stdin.isTTY) {
    console.error(
      "Refusing destructive action without --force in a non-interactive shell.",
    );
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "y" || a === "yes");
    });
  });
}

/** Sanitize an error before logging — pg errors frequently echo the
 *  connection string back, which would dump credentials to stdout (and
 *  therefore the log-retention pipeline). */
function safeStringifyError(err) {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://[redacted]");
}

async function status() {
  const userResult = await client.query(
    `SELECT id, username, "localUsername", "passwordHash", "plexId",
            "ssoSubject", "ssoIssuer", "ssoEnabled"
       FROM "User"
      LIMIT 1`,
  );
  const settingsResult = await client.query(
    `SELECT "localAuthEnabled", "plexLoginEnabled", "ssoEnabled",
            "ssoMode", "oidcIssuer", "oidcClientId"
       FROM "AppSettings"
      LIMIT 1`,
  );

  const user = userResult.rows[0];
  const settings = settingsResult.rows[0];

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
  if (
    !(await confirm(
      "Wipe all SSO configuration and unlink the SSO subject from the user?",
    ))
  ) {
    console.log("Cancelled.");
    return;
  }
  // Clear AppSettings SSO fields + the previousSsoConfig snapshot. Json
  // columns accept SQL NULL fine; no Prisma.JsonNull sentinel needed.
  const settingsRes = await client.query(
    `UPDATE "AppSettings"
        SET "ssoEnabled" = FALSE,
            "ssoMode" = 'OIDC',
            "oidcIssuer" = NULL,
            "oidcClientId" = NULL,
            "oidcClientSecret" = NULL,
            "previousSsoConfig" = NULL`,
  );
  // Unlink user-level SSO state and bump sessionVersion so cookies
  // referencing the old link can't be replayed.
  const userRes = await client.query(
    `UPDATE "User"
        SET "ssoSubject" = NULL,
            "ssoIssuer" = NULL,
            "ssoProvider" = NULL,
            "ssoEnabled" = FALSE,
            "sessionVersion" = "sessionVersion" + 1`,
  );

  if (settingsRes.rowCount === 0) {
    console.log(
      `No AppSettings row exists yet (typical for a Plex-first deployment that hasn't saved any setting). User-level SSO unlinked on ${userRes.rowCount} row(s).`,
    );
  } else {
    console.log(
      `Wiped SSO config on ${settingsRes.rowCount} AppSettings row(s) and unlinked SSO on ${userRes.rowCount} User row(s).`,
    );
  }
  console.log(
    "Restart the container so any cached discovery docs are dropped, then sign in via your remaining method (Plex or local).",
  );
}

async function enableLocal() {
  const res = await client.query(
    `UPDATE "AppSettings" SET "localAuthEnabled" = TRUE`,
  );
  console.log(
    `Set localAuthEnabled=true on ${res.rowCount} AppSettings row(s). ` +
      `The local username/password form will appear on the login page (provided a password is set on the user record -- check with 'status' if unsure).`,
  );
}

async function enablePlex() {
  const res = await client.query(
    `UPDATE "AppSettings" SET "plexLoginEnabled" = TRUE`,
  );
  console.log(
    `Set plexLoginEnabled=true on ${res.rowCount} AppSettings row(s). ` +
      `The "Sign in with Plex" button will appear on the login page (provided a Plex account is linked on the user record -- check with 'status').`,
  );
}

async function deleteUser() {
  const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM "User"`);
  if (countRes.rows[0].n === 0) {
    console.log("No user to delete. The setup screen will already show.");
    return;
  }
  console.log(
    "WARNING: this drops the user row AND cascades to all data linked to it:",
  );
  console.log("  - synced media items and their metadata");
  console.log("  - server connections and library definitions");
  console.log("  - lifecycle rule sets, matches, pending actions");
  console.log("  - blackout schedules, preroll presets/schedules");
  console.log("  - saved queries, watch history, log entries");
  console.log("");
  console.log(
    "If any credentials still exist (Plex link, local password, SSO link), prefer 'wipe-sso', 'enable-local', or 'enable-plex' instead — those preserve media data.",
  );
  console.log("");
  if (!(await confirm("Proceed with delete-user?"))) {
    console.log("Cancelled.");
    return;
  }
  // DB-level ON DELETE CASCADE on every User-owned FK handles the cleanup.
  const res = await client.query(`DELETE FROM "User"`);
  console.log(
    `Deleted ${res.rowCount} user(s). The setup screen will appear on next page load.`,
  );
}

async function main() {
  const cmd = process.argv[2];
  await client.connect();
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
        `Usage: node scripts/reset-auth.js <status|wipe-sso|enable-local|enable-plex|delete-user>`,
      );
      process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(safeStringifyError(err));
    process.exit(1);
  })
  .finally(() => client.end());
