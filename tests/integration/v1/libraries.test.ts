import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { clearMockSession } from "../../setup/mock-session";
import {
  createTestUser,
  createTestApiKey,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
  expectJson,
} from "../../setup/test-helpers";
import { callV1 } from "./v1-helpers";

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/v1/libraries/route";

interface V1FlatLibrary {
  id: string;
  key: string;
  title: string;
  type: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  itemCount: number;
  server: { id: string; name: string; type: string };
}

const URL_LIBRARIES = "/api/v1/libraries";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/v1/libraries", () => {
  it("returns an empty list when nothing is connected", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw }),
    );
    expect(body.libraries).toEqual([]);
  });

  it("flattens every library and names its owning server", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id, { name: "Attic" });
    const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    await createTestMediaItem(movies.id);
    await createTestMediaItem(movies.id);

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw }),
    );
    expect(body.libraries).toHaveLength(1);
    const [lib] = body.libraries;
    expect(lib.id).toBe(movies.id);
    expect(lib.key).toBe(movies.key);
    expect(lib.title).toBe("Movies");
    expect(lib.type).toBe("MOVIE");
    expect(lib.enabled).toBe(true);
    expect(lib.itemCount).toBe(2);
    expect(lib.server).toEqual({ id: server.id, name: "Attic", type: "PLEX" });
  });

  it("orders by title", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { title: "Zeta" });
    await createTestLibrary(server.id, { title: "Alpha" });
    await createTestLibrary(server.id, { title: "Mid" });

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw }),
    );
    expect(body.libraries.map((l) => l.title)).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  it("filters by library type", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id);
    await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    await createTestLibrary(server.id, { title: "Shows", type: "SERIES" });
    await createTestLibrary(server.id, { title: "Tunes", type: "MUSIC" });

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw, searchParams: { type: "MUSIC" } }),
    );
    expect(body.libraries.map((l) => l.title)).toEqual(["Tunes"]);
  });

  it("rejects an unknown type with 400", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<{ error: string }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw, searchParams: { type: "EPISODE" } }),
      400,
    );
    expect(body.error).toBe("type must be one of MOVIE, SERIES, MUSIC");
  });

  it("rejects a lower-cased type with 400", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    await expectJson(
      await callV1(GET, { url: URL_LIBRARIES, key: raw, searchParams: { type: "movie" } }),
      400,
    );
  });

  it("narrows to one server with serverId", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const one = await createTestServer(user.id, { name: "One" });
    const two = await createTestServer(user.id, { name: "Two" });
    await createTestLibrary(one.id, { title: "From One" });
    await createTestLibrary(two.id, { title: "From Two" });

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw, searchParams: { serverId: two.id } }),
    );
    expect(body.libraries.map((l) => l.title)).toEqual(["From Two"]);
  });

  it("returns nothing for a serverId that belongs to another user", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const { raw } = await createTestApiKey(owner.id);
    const theirs = await createTestServer(stranger.id, { name: "Theirs" });
    await createTestLibrary(theirs.id, { title: "Private" });

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw, searchParams: { serverId: theirs.id } }),
    );
    expect(body.libraries).toEqual([]);
  });

  it("excludes another user's libraries from the unfiltered list", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const { raw } = await createTestApiKey(owner.id);
    const mine = await createTestServer(owner.id, { name: "Mine" });
    const theirs = await createTestServer(stranger.id, { name: "Theirs" });
    await createTestLibrary(mine.id, { title: "Mine" });
    await createTestLibrary(theirs.id, { title: "Theirs" });

    const body = await expectJson<{ libraries: V1FlatLibrary[] }>(
      await callV1(GET, { url: URL_LIBRARIES, key: raw }),
    );
    expect(body.libraries.map((l) => l.title)).toEqual(["Mine"]);
  });
});
