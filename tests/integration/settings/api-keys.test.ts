import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb, getTestPrisma } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  createTestApiKey,
  createTestUser,
  expectJson,
} from "../../setup/test-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET, POST } from "@/app/api/settings/api-keys/route";
import { PATCH, DELETE } from "@/app/api/settings/api-keys/[id]/route";
import {
  authenticateApiKey,
  hashApiKey,
  resetApiKeyTouchState,
} from "@/lib/auth/api-key";
import { apiLogger } from "@/lib/logger";

interface SerializedKey {
  id: string;
  name: string;
  prefix: string;
  scope: "READ_ONLY" | "READ_WRITE";
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface ErrorBody {
  error: string;
  details?: string[];
}

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
  resetApiKeyTouchState();
  vi.clearAllMocks();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

async function login() {
  const user = await createTestUser();
  setMockSession({ isLoggedIn: true, userId: user.id, plexToken: "tok" });
  return user;
}

function create(body: unknown) {
  return callRoute(POST, { url: "/api/settings/api-keys", method: "POST", body });
}

function patch(id: string, body: unknown) {
  return callRouteWithParams(PATCH, { id }, { method: "PATCH", body });
}

function remove(id: string) {
  return callRouteWithParams(DELETE, { id }, { method: "DELETE" });
}

describe("/api/settings/api-keys — auth", () => {
  it("401s every method when there is no session", async () => {
    await expectJson(await callRoute(GET), 401);
    await expectJson(await create({ name: "k" }), 401);
    await expectJson(await patch("nope", { name: "k" }), 401);
    await expectJson(await remove("nope"), 401);
  });
});

describe("POST /api/settings/api-keys", () => {
  it("mints a key, returns the secret once, and leaks nothing else", async () => {
    await login();
    const body = await expectJson<{ key: SerializedKey; secret: string }>(
      await create({ name: "Homelab script" }),
      201,
    );

    expect(body.secret.startsWith("lbr_")).toBe(true);
    expect(body.key.name).toBe("Homelab script");
    expect(body.key.status).toBe("active");
    // The reveal lives on the envelope, never inside the key object the UI
    // keeps around and re-renders after the one-time display is dismissed.
    expect(JSON.stringify(body.key)).not.toContain(body.secret);
    expect(Object.keys(body.key)).not.toContain("keyHash");
  });

  it("stores only the digest — the raw secret is nowhere in the row", async () => {
    await login();
    const body = await expectJson<{ key: SerializedKey; secret: string }>(
      await create({ name: "k" }),
      201,
    );

    const row = await getTestPrisma().apiKey.findUniqueOrThrow({
      where: { id: body.key.id },
    });
    expect(row.keyHash).toBe(hashApiKey(body.secret));
    expect(JSON.stringify(row)).not.toContain(body.secret);
    // The secret portion after the prefix is what must not survive; the short
    // display prefix legitimately overlaps the head of the raw key.
    expect(JSON.stringify(row)).not.toContain(body.secret.slice("lbr_".length));
    expect(body.secret.startsWith(row.prefix)).toBe(true);
    expect(row.prefix.length).toBeLessThan(body.secret.length);
  });

  it("issues a secret that actually authenticates, until it is revoked", async () => {
    await login();
    const body = await expectJson<{ key: SerializedKey; secret: string }>(
      await create({ name: "k" }),
      201,
    );

    const request = new Request("http://localhost/api/v1/health", {
      headers: { "X-Api-Key": body.secret },
    });
    const auth = await authenticateApiKey(request);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.apiKey.id).toBe(body.key.id);

    await expectJson(await patch(body.key.id, { revoked: true }));
    const after = await authenticateApiKey(
      new Request("http://localhost/api/v1/health", {
        headers: { "X-Api-Key": body.secret },
      }),
    );
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  it("never writes the secret to the log", async () => {
    await login();
    const body = await expectJson<{ key: SerializedKey; secret: string }>(
      await create({ name: "Loggable" }),
      201,
    );

    expect(apiLogger.info).toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(apiLogger.info).mock.calls);
    expect(logged).toContain("Loggable");
    expect(logged).not.toContain(body.secret);
  });

  it("defaults to READ_ONLY and honours an explicit READ_WRITE", async () => {
    await login();
    const readOnly = await expectJson<{ key: SerializedKey }>(
      await create({ name: "ro" }),
      201,
    );
    expect(readOnly.key.scope).toBe("READ_ONLY");

    const readWrite = await expectJson<{ key: SerializedKey }>(
      await create({ name: "rw", scope: "READ_WRITE" }),
      201,
    );
    expect(readWrite.key.scope).toBe("READ_WRITE");

    const rows = await getTestPrisma().apiKey.findMany({ orderBy: { name: "asc" } });
    expect(rows.map((r) => r.scope)).toEqual(["READ_ONLY", "READ_WRITE"]);
  });

  it("treats a missing or null expiry as 'never expires'", async () => {
    await login();
    const omitted = await expectJson<{ key: SerializedKey }>(
      await create({ name: "omitted" }),
      201,
    );
    expect(omitted.key.expiresAt).toBeNull();

    const explicit = await expectJson<{ key: SerializedKey }>(
      await create({ name: "explicit", expiresAt: null }),
      201,
    );
    expect(explicit.key.expiresAt).toBeNull();

    const rows = await getTestPrisma().apiKey.findMany();
    expect(rows.every((r) => r.expiresAt === null)).toBe(true);
  });

  it("stores a future expiry", async () => {
    await login();
    const body = await expectJson<{ key: SerializedKey }>(
      await create({ name: "k", expiresAt: FUTURE }),
      201,
    );
    expect(body.key.expiresAt).toBe(new Date(FUTURE).toISOString());
    expect(body.key.status).toBe("active");
  });

  it("rejects an expiry in the past", async () => {
    await login();
    const body = await expectJson<ErrorBody>(
      await create({ name: "k", expiresAt: PAST }),
      400,
    );
    expect(body.error).toBe("Expiry must be in the future.");
    expect(await getTestPrisma().apiKey.count()).toBe(0);
  });

  it("rejects a duplicate name with 409", async () => {
    await login();
    await expectJson(await create({ name: "Duplicate" }), 201);
    const body = await expectJson<ErrorBody>(await create({ name: "Duplicate" }), 409);
    expect(body.error).toBe("An API key with that name already exists.");
    expect(await getTestPrisma().apiKey.count()).toBe(1);
  });

  it("keeps a revoked key's name reserved", async () => {
    await login();
    const first = await expectJson<{ key: SerializedKey }>(
      await create({ name: "Reused" }),
      201,
    );
    await expectJson(await patch(first.key.id, { revoked: true }));
    // The unique index is unconditional, so the audit row still owns the name.
    await expectJson(await create({ name: "Reused" }), 409);
  });

  it("trims the name and rejects blank or oversized ones", async () => {
    await login();
    const trimmed = await expectJson<{ key: SerializedKey }>(
      await create({ name: "  Padded  " }),
      201,
    );
    expect(trimmed.key.name).toBe("Padded");

    const blank = await expectJson<ErrorBody>(await create({ name: "   " }), 400);
    expect(blank.error).toBe("Validation failed");
    expect(blank.details?.join(" ")).toContain("Name is required");

    const long = await expectJson<ErrorBody>(await create({ name: "x".repeat(81) }), 400);
    expect(long.details?.join(" ")).toContain("80 characters");
  });

  it("rejects an unknown scope and a malformed body", async () => {
    await login();
    await expectJson(await create({ name: "k", scope: "ADMIN" }), 400);

    const noBody = await expectJson<ErrorBody>(
      await callRoute(POST, { url: "/api/settings/api-keys", method: "POST" }),
      400,
    );
    expect(noBody.error).toBe("Invalid JSON in request body");
  });
});

describe("GET /api/settings/api-keys", () => {
  it("returns an empty list when none exist", async () => {
    await login();
    const body = await expectJson<{ keys: SerializedKey[] }>(await callRoute(GET));
    expect(body.keys).toEqual([]);
  });

  it("lists newest-first and never exposes the stored digest", async () => {
    const user = await login();
    const prisma = getTestPrisma();
    const made = [];
    for (const name of ["oldest", "middle", "newest"]) {
      made.push(await createTestApiKey(user.id, { name }));
    }
    // Explicit timestamps: three inserts can land close enough together that
    // the ordering assertion would depend on clock resolution.
    for (const [i, { apiKey }] of made.entries()) {
      await prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { createdAt: new Date(Date.UTC(2026, 0, i + 1)) },
      });
    }

    const response = await callRoute(GET);
    const text = await response.clone().text();
    const body = await expectJson<{ keys: SerializedKey[] }>(response);

    expect(body.keys.map((k) => k.name)).toEqual(["newest", "middle", "oldest"]);
    expect(text).not.toContain("keyHash");
    for (const { apiKey } of made) {
      expect(text).not.toContain(apiKey.keyHash);
    }
  });

  it("reports derived status per key", async () => {
    const user = await login();
    await createTestApiKey(user.id, { name: "active" });
    await createTestApiKey(user.id, { name: "expired", expiresAt: new Date(PAST) });
    await createTestApiKey(user.id, {
      name: "revoked",
      revokedAt: new Date(),
      // Revocation wins over expiry in the display.
      expiresAt: new Date(PAST),
    });

    const body = await expectJson<{ keys: SerializedKey[] }>(await callRoute(GET));
    const byName = new Map(body.keys.map((k) => [k.name, k.status]));
    expect(byName.get("active")).toBe("active");
    expect(byName.get("expired")).toBe("expired");
    expect(byName.get("revoked")).toBe("revoked");
  });

  it("only lists keys owned by the session user", async () => {
    const user = await login();
    await createTestApiKey(user.id, { name: "mine" });
    const other = await createTestUser({ plexId: "other", username: "other" });
    await createTestApiKey(other.id, { name: "theirs" });

    const body = await expectJson<{ keys: SerializedKey[] }>(await callRoute(GET));
    expect(body.keys.map((k) => k.name)).toEqual(["mine"]);
  });
});

describe("PATCH /api/settings/api-keys/[id]", () => {
  it("renames a key", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id, { name: "before" });

    const body = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { name: "after" }),
    );
    expect(body.key.name).toBe("after");
    expect(body.key.status).toBe("active");

    const row = await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.name).toBe("after");
    // A rename must not disturb the credential itself.
    expect(row.keyHash).toBe(apiKey.keyHash);
    expect(row.prefix).toBe(apiKey.prefix);
  });

  it("revokes a key and flips its status", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id);

    const body = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { revoked: true }),
    );
    expect(body.key.status).toBe("revoked");
    expect(body.key.revokedAt).not.toBeNull();

    const row = await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.revokedAt).toBeInstanceOf(Date);
    // Soft delete: the audit trail survives.
    expect(row.name).toBe(apiKey.name);
    expect(row.prefix).toBe(apiKey.prefix);
  });

  it("rejects a second revoke without moving revokedAt", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id);
    const first = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { revoked: true }),
    );

    const body = await expectJson<ErrorBody>(await patch(apiKey.id, { revoked: true }), 400);
    expect(body.error).toBe("This API key is already revoked.");

    const row = await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.revokedAt?.toISOString()).toBe(first.key.revokedAt);
  });

  it("still allows renaming a revoked key", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id, { name: "leaked" });
    await expectJson(await patch(apiKey.id, { revoked: true }));

    const body = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { name: "leaked (rotated out)" }),
    );
    expect(body.key.name).toBe("leaked (rotated out)");
    expect(body.key.status).toBe("revoked");
  });

  it("sets and clears the expiry", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id);

    const set = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { expiresAt: FUTURE }),
    );
    expect(set.key.expiresAt).toBe(new Date(FUTURE).toISOString());

    const cleared = await expectJson<{ key: SerializedKey }>(
      await patch(apiKey.id, { expiresAt: null }),
    );
    expect(cleared.key.expiresAt).toBeNull();
    const row = await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(row.expiresAt).toBeNull();
  });

  it("rejects an expiry in the past", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id);
    const body = await expectJson<ErrorBody>(
      await patch(apiKey.id, { expiresAt: PAST }),
      400,
    );
    expect(body.error).toBe("Expiry must be in the future.");
  });

  it("rejects an empty patch, a scope change and un-revoking", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id, { scope: "READ_ONLY" });

    const empty = await expectJson<ErrorBody>(await patch(apiKey.id, {}), 400);
    expect(empty.error).toBe("Validation failed");
    expect(empty.details?.join(" ")).toContain("Provide at least one field to update");

    // `scope` is not in the update schema, so it is stripped and the body then
    // has nothing left to apply.
    await expectJson(await patch(apiKey.id, { scope: "READ_WRITE" }), 400);
    expect(
      (await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: apiKey.id } })).scope,
    ).toBe("READ_ONLY");

    // Revocation is one-way: the schema accepts only the literal `true`.
    await expectJson(await patch(apiKey.id, { revoked: false }), 400);
  });

  it("409s on a name that is already taken", async () => {
    const user = await login();
    await createTestApiKey(user.id, { name: "taken" });
    const { apiKey } = await createTestApiKey(user.id, { name: "mine" });

    const body = await expectJson<ErrorBody>(await patch(apiKey.id, { name: "taken" }), 409);
    expect(body.error).toBe("An API key with that name already exists.");
  });

  it("404s for an unknown id, and for a key outside the session user's scope", async () => {
    const user = await login();
    const other = await createTestUser({ plexId: "other", username: "other" });
    const { apiKey: theirs } = await createTestApiKey(other.id, { name: "theirs" });

    const unknown = await expectJson<ErrorBody>(await patch("does-not-exist", { name: "x" }), 404);
    expect(unknown.error).toBe("API key not found");

    await expectJson(await patch(theirs.id, { name: "x" }), 404);
    expect(
      (await getTestPrisma().apiKey.findUniqueOrThrow({ where: { id: theirs.id } })).name,
    ).toBe("theirs");
    expect(user.id).not.toBe(other.id);
  });

  it("resolves the id before the body, so a bad body on an unknown id is still 404", async () => {
    await login();
    await expectJson(await patch("does-not-exist", {}), 404);
    await expectJson(
      await callRouteWithParams(PATCH, { id: "does-not-exist" }, { method: "PATCH" }),
      404,
    );
  });
});

describe("DELETE /api/settings/api-keys/[id]", () => {
  it("hard-deletes the row", async () => {
    const user = await login();
    const { apiKey } = await createTestApiKey(user.id);
    const keep = await createTestApiKey(user.id, { name: "keep" });

    const body = await expectJson<{ success: boolean }>(await remove(apiKey.id));
    expect(body.success).toBe(true);

    expect(await getTestPrisma().apiKey.findUnique({ where: { id: apiKey.id } })).toBeNull();
    expect(
      await getTestPrisma().apiKey.findUnique({ where: { id: keep.apiKey.id } }),
    ).not.toBeNull();
  });

  it("stops the deleted key from authenticating", async () => {
    const user = await login();
    const { apiKey, raw } = await createTestApiKey(user.id);
    await expectJson(await remove(apiKey.id));

    const auth = await authenticateApiKey(
      new Request("http://localhost/api/v1/health", { headers: { "X-Api-Key": raw } }),
    );
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe("invalid");
  });

  it("404s for an unknown id, and for a key outside the session user's scope", async () => {
    await login();
    const other = await createTestUser({ plexId: "other", username: "other" });
    const { apiKey: theirs } = await createTestApiKey(other.id, { name: "theirs" });

    const unknown = await expectJson<ErrorBody>(await remove("does-not-exist"), 404);
    expect(unknown.error).toBe("API key not found");

    await expectJson(await remove(theirs.id), 404);
    expect(await getTestPrisma().apiKey.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});
