import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import { callRoute, createTestUser } from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/sso/oidc-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sso/oidc-client")>()),
  invalidateOidcDiscoveryCache: vi.fn(),
}));

import { PUT as authPUT } from "@/app/api/settings/auth/route";
import { PUT as ssoPUT } from "@/app/api/settings/sso/route";
import { POST as revertPOST } from "@/app/api/settings/sso/revert/route";
import { DELETE as unlinkDELETE } from "@/app/api/settings/sso/link/route";

const prisma = getTestPrisma();
const ISSUER = "https://idp.example.com";

/**
 * Local login off, SSO on and linked, a local password, Plex usable (the SSO
 * routes' lockout guards want another way in) — and a sign-in older than the
 * recent-login window. Turning local login on alone keeps the password off
 * (SSO hides it), and so does turning SSO off alone (local login is off), so
 * neither request by itself needs a recent sign-in. Together they turn
 * password sign-in on.
 */
async function seed() {
  const user = await createTestUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: "hash", ssoEnabled: true, ssoSubject: "sub", ssoIssuer: ISSUER },
  });
  await prisma.appSettings.create({
    data: {
      userId: user.id,
      localAuthEnabled: false,
      plexLoginEnabled: true,
      ssoEnabled: true,
      ssoMode: "OIDC",
      oidcIssuer: ISSUER,
      oidcClientId: "client",
      previousSsoConfig: { ssoMode: "OIDC", oidcIssuer: ISSUER, oidcClientId: "client" },
    },
  });
  setMockSession({ isLoggedIn: true, userId: user.id, authenticatedAt: 1 });
}

const turnSsoOff: Record<string, () => Promise<Response>> = {
  "the SSO toggle": () => callRoute(ssoPUT, { method: "PUT", body: { ssoEnabled: false } }),
  revert: () => callRoute(revertPOST, { method: "POST" }),
  unlink: () => callRoute(unlinkDELETE, { method: "DELETE" }),
};

describe("settings writes that can turn password sign-in on", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // Each route checked the change against its own snapshot: two concurrent
  // requests each passed on the other's old state, and both wrote.
  it.each(Object.keys(turnSsoOff))(
    "never let local login on and %s together turn it on without a recent sign-in",
    async (label) => {
      for (let round = 0; round < 8; round++) {
        await cleanDatabase();
        await seed();
        const statuses = (
          await Promise.all([
            callRoute(authPUT, { method: "PUT", body: { localAuthEnabled: true } }),
            turnSsoOff[label](),
          ])
        ).map((r) => r.status);
        const settings = await prisma.appSettings.findFirstOrThrow();
        expect(settings.localAuthEnabled && !settings.ssoEnabled).toBe(false);
        // One went through; the other, now turning the password on, was sent
        // to confirm it's you.
        expect(statuses.sort()).toEqual([200, 403]);
      }
    },
  );
});
