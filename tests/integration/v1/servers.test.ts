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

import { GET } from "@/app/api/v1/servers/route";

interface V1Library {
  id: string;
  key: string;
  title: string;
  type: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  itemCount: number;
}

interface V1Server {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  createdAt: string;
  itemCount: number;
  libraries: V1Library[];
}

const URL_SERVERS = "/api/v1/servers";

beforeEach(async () => {
  await cleanDatabase();
  clearMockSession();
});
afterAll(async () => {
  await cleanDatabase();
  await disconnectTestDb();
});

describe("GET /api/v1/servers", () => {
  it("returns an empty list when nothing is connected", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);

    const body = await expectJson<{ servers: V1Server[] }>(
      await callV1(GET, { url: URL_SERVERS, key: raw }),
    );
    expect(body.servers).toEqual([]);
  });

  it("returns servers with their libraries and item counts", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const server = await createTestServer(user.id, { name: "Living Room" });
    const movies = await createTestLibrary(server.id, { title: "Movies", type: "MOVIE" });
    const tv = await createTestLibrary(server.id, { title: "TV", type: "SERIES" });
    await createTestMediaItem(movies.id, { title: "Arrival" });
    await createTestMediaItem(movies.id, { title: "Dune" });
    await createTestMediaItem(tv.id, { title: "Pilot", type: "SERIES", parentTitle: "Show" });

    const body = await expectJson<{ servers: V1Server[] }>(
      await callV1(GET, { url: URL_SERVERS, key: raw }),
    );

    expect(body.servers).toHaveLength(1);
    const [got] = body.servers;
    expect(got.id).toBe(server.id);
    expect(got.name).toBe("Living Room");
    expect(got.type).toBe("PLEX");
    expect(got.url).toBe(server.url);
    expect(got.enabled).toBe(true);
    expect(got.itemCount).toBe(3);
    expect(got.libraries.map((l) => [l.title, l.itemCount])).toEqual([
      ["Movies", 2],
      ["TV", 1],
    ]);
    expect(got.libraries[0].id).toBe(movies.id);
    expect(got.libraries[0].type).toBe("MOVIE");
    expect(got.libraries[0].lastSyncedAt).toBeNull();
  });

  it("never exposes the server access token", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    await createTestServer(user.id, { accessToken: "super-secret-plex-token" });

    const response = await callV1(GET, { url: URL_SERVERS, key: raw });
    const text = await response.text();
    expect(text).not.toContain("super-secret-plex-token");
    expect(text).not.toContain("accessToken");
  });

  it("orders servers by name and libraries by title", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    const zeta = await createTestServer(user.id, { name: "Zeta" });
    const alpha = await createTestServer(user.id, { name: "Alpha" });
    await createTestLibrary(zeta.id, { title: "Zoo" });
    await createTestLibrary(zeta.id, { title: "Anime" });
    await createTestLibrary(alpha.id, { title: "Films" });

    const body = await expectJson<{ servers: V1Server[] }>(
      await callV1(GET, { url: URL_SERVERS, key: raw }),
    );
    expect(body.servers.map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
    expect(body.servers[1].libraries.map((l) => l.title)).toEqual(["Anime", "Zoo"]);
  });

  it("includes disabled servers with their enabled flag", async () => {
    const user = await createTestUser();
    const { raw } = await createTestApiKey(user.id);
    await createTestServer(user.id, { name: "Offline", enabled: false });

    const body = await expectJson<{ servers: V1Server[] }>(
      await callV1(GET, { url: URL_SERVERS, key: raw }),
    );
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].enabled).toBe(false);
  });

  it("excludes another user's servers", async () => {
    const owner = await createTestUser({ plexId: "owner", username: "owner" });
    const stranger = await createTestUser({ plexId: "stranger", username: "stranger" });
    const { raw } = await createTestApiKey(owner.id);
    await createTestServer(owner.id, { name: "Mine" });
    await createTestServer(stranger.id, { name: "Theirs" });

    const body = await expectJson<{ servers: V1Server[] }>(
      await callV1(GET, { url: URL_SERVERS, key: raw }),
    );
    expect(body.servers.map((s) => s.name)).toEqual(["Mine"]);
  });
});
