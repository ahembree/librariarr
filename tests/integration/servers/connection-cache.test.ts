import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import sharp from "sharp";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRouteWithParams,
  expectJson,
  createTestUser,
  createTestServer,
  createTestLibrary,
  createTestMediaItem,
} from "../../setup/test-helpers";

// The real in-process cache and the real image route: the bug is the route's
// `image-meta:` entry outliving an edit of the server it describes.

const { mockFetchImage, mockTestConnection } = vi.hoisted(() => ({
  mockFetchImage: vi.fn(),
  mockTestConnection: vi.fn(),
}));

vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/media-server/factory", () => ({
  createMediaServerClient: vi.fn(() => ({
    fetchImage: mockFetchImage,
    testConnection: mockTestConnection,
  })),
}));

// Import route handlers AFTER mocks
import { PUT } from "@/app/api/servers/[id]/route";
import { GET as ImageGET } from "@/app/api/media/[id]/image/route";
import { createMediaServerClient } from "@/lib/media-server/factory";
import { appCache } from "@/lib/cache/memory-cache";
import { CACHE_WIDTH_GRID } from "@/lib/image-url";

const OLD_URL = "http://plex.old:32400";
const THUMB = "/library/metadata/1/thumb/1706000000";

describe("PUT /api/servers/[id] — cached connection details", () => {
  let itemId: string;
  let serverId: string;

  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    appCache.clear();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, serverName: "Plex" });
    mockFetchImage.mockResolvedValue({
      data: await sharp({ create: { width: 64, height: 96, channels: 3, background: "#123456" } })
        .jpeg()
        .toBuffer(),
      contentType: "image/jpeg",
    });

    const user = await createTestUser();
    const server = await createTestServer(user.id, { url: OLD_URL, accessToken: "old-token" });
    serverId = server.id;
    const library = await createTestLibrary(server.id);
    const item = await createTestMediaItem(library.id, { thumbUrl: THUMB });
    itemId = item.id;
    // A recent sign-in: a new URL or TLS checks off with the stored token kept
    // needs one, and that refusal is not what this file is about.
    setMockSession({ userId: user.id, isLoggedIn: true, authenticatedAt: Date.now() });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  /** Fetch the item's artwork at `width` and return the connection its client used. */
  async function artworkConnection(width?: number) {
    vi.mocked(createMediaServerClient).mockClear();
    const response = await callRouteWithParams(ImageGET, { id: itemId }, {
      url: `/api/media/${itemId}/image${width ? `?w=${width}` : ""}`,
    });
    expect(response.status).toBe(200);
    const [, url, token, options] = vi.mocked(createMediaServerClient).mock.calls[0];
    return { url, token, skipTlsVerify: options?.skipTlsVerify };
  }

  // Exactly what the Settings edit form sends: never `enabled`.
  const editForm = (changes: Record<string, unknown>) => ({
    url: OLD_URL,
    externalUrl: null,
    tlsSkipVerify: false,
    ...changes,
  });

  it.each([
    ["URL", { url: "http://plex.new:32400" }, { url: "http://plex.new:32400", token: "old-token", skipTlsVerify: false }],
    ["token", { accessToken: "new-token" }, { url: OLD_URL, token: "new-token", skipTlsVerify: false }],
    ["TLS setting", { tlsSkipVerify: true }, { url: OLD_URL, token: "old-token", skipTlsVerify: true }],
  ])("fetches artwork with the new %s as soon as the edit is saved", async (_field, changes, expected) => {
    // Warm the image route's `image-meta:` entry with the old connection.
    expect(await artworkConnection()).toEqual({ url: OLD_URL, token: "old-token", skipTlsVerify: false });

    const response = await callRouteWithParams(PUT, { id: serverId }, {
      url: `/api/servers/${serverId}`,
      method: "PUT",
      body: editForm(changes),
    });
    await expectJson(response, 200);

    // Another width misses the on-disk image cache, so the route asks the
    // server again — with whatever connection its metadata cache holds.
    expect(await artworkConnection(CACHE_WIDTH_GRID)).toEqual(expected);
  });

  it("keeps the caches when a save changes no connection setting", async () => {
    await artworkConnection();
    const listing = "media-list:probe";
    appCache.set(listing, { items: [] });

    const response = await callRouteWithParams(PUT, { id: serverId }, {
      url: `/api/servers/${serverId}`,
      method: "PUT",
      // Re-saving the same settings (the form always sends the URL; an empty
      // token field keeps the stored one).
      body: editForm({ url: `${OLD_URL}/`, accessToken: "" }),
    });
    await expectJson(response, 200);

    expect(appCache.get(listing)).toEqual({ items: [] });
    expect(appCache.get(`image-meta:${itemId}`)).toBeTruthy();
  });
});
