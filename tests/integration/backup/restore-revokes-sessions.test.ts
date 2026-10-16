/**
 * A restore never undoes a session revocation.
 *
 * Revoking a session is bumping `User.sessionVersion` (logout, a password
 * change); `getSession()` refuses a cookie sealed with any other version. The
 * backup holds the version as it was when it was taken, and restore used to
 * re-insert it verbatim — moving it back, so every cookie sealed at that value
 * (a stolen one the admin had revoked by logging out everywhere included) was
 * honoured again. Restore now gives every user a version above both the file's
 * and the one in use, which signs every session out.
 *
 * Runs the REAL session module (iron-session over an in-memory cookie jar),
 * the real logout route and the real backup service against the test database.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";

vi.unmock("@/lib/auth/session");

const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "librariarr-restore-sessions-"));
process.env.BACKUP_DIR = backupDir;

/** Minimal stand-in for the cookie store `next/headers` cookies() returns. */
function makeCookieStore() {
  const jar = new Map<string, string>();
  return {
    jar,
    get(name: string) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      return [...jar.entries()].map(([name, value]) => ({ name, value }));
    },
    has(name: string) {
      return jar.has(name);
    },
    set(name: string | { name: string; value: string }, value?: string) {
      if (typeof name === "object") jar.set(name.name, name.value);
      else jar.set(name, value ?? "");
    },
    delete(name: string) {
      jar.delete(name);
    },
  };
}

const COOKIE = "librariarr_session";
let store: ReturnType<typeof makeCookieStore>;
const prisma = getTestPrisma();
const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(async () => {
  vi.resetModules();
  store = makeCookieStore();
  vi.doMock("next/headers", () => ({
    cookies: async () => store,
    headers: async () => new Headers(),
  }));
  vi.doMock("@/lib/db", () => ({ prisma }));
  vi.doMock("@/lib/logger", () => ({ logger: silent, apiLogger: silent, dbLogger: silent }));
  await cleanDatabase();
});

afterEach(() => {
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/db");
  vi.doUnmock("@/lib/logger");
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
  await fs.rm(backupDir, { recursive: true, force: true });
});

async function load() {
  const session = await import("@/lib/auth/session");
  const backup = await import("@/lib/backup/backup-service");
  return { ...session, ...backup };
}

/** Sign `userId` in on the jar and return the sealed cookie. */
async function signIn(rotateSession: typeof import("@/lib/auth/session").rotateSession, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const session = await rotateSession();
  session.userId = user.id;
  session.isLoggedIn = true;
  session.sessionVersion = user.sessionVersion;
  await session.save();
  return store.jar.get(COOKIE)!;
}

describe("restore vs session revocation", () => {
  it("a cookie revoked by logout after the backup stays revoked after restoring it", async () => {
    const { rotateSession, getSession, createBackup, restoreBackup } = await load();
    const { POST: logout } = await import("@/app/api/auth/logout/route");
    const { NextRequest } = await import("next/server");

    const user = await prisma.user.create({
      data: { username: "admin", localUsername: "admin", passwordHash: "x" },
    });

    // The admin signs in; someone copies the cookie.
    const stolen = await signIn(rotateSession, user.id);
    expect((await getSession()).isLoggedIn).toBe(true);

    const filename = await createBackup(undefined, true);

    // The admin logs out everywhere — the documented revocation.
    const res = await logout(new NextRequest("http://localhost/api/auth/logout", { method: "POST" }));
    expect(res.status).toBe(200);
    store.jar.set(COOKIE, stolen);
    expect((await getSession()).isLoggedIn).toBe(false);

    await restoreBackup(filename);

    store.jar.set(COOKIE, stolen);
    expect((await getSession()).isLoggedIn).toBe(false);
  });

  it("signs out every session that was valid before the restore, and a new sign-in works", async () => {
    const { rotateSession, getSession, createBackup, restoreBackup } = await load();

    const user = await prisma.user.create({ data: { username: "admin" } });
    const filename = await createBackup(undefined, true);
    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 4 } } });

    const current = await signIn(rotateSession, user.id);
    expect((await getSession()).isLoggedIn).toBe(true);

    await restoreBackup(filename);

    const restored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(restored.sessionVersion).toBe(5);
    store.jar.set(COOKIE, current);
    expect((await getSession()).isLoggedIn).toBe(false);

    await signIn(rotateSession, user.id);
    const fresh = await getSession();
    expect(fresh.isLoggedIn).toBe(true);
    expect(fresh.userId).toBe(user.id);
  });
});
