import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/plex/client", () => ({
  PlexClient: vi.fn().mockImplementation(function () {
    return { type: "plex" };
  }),
}));
vi.mock("@/lib/jellyfin/client", () => ({
  JellyfinClient: vi.fn().mockImplementation(function () {
    return { type: "jellyfin" };
  }),
}));
vi.mock("@/lib/emby/client", () => ({
  EmbyClient: vi.fn().mockImplementation(function () {
    return { type: "emby" };
  }),
}));

import { createMediaServerClient } from "@/lib/media-server/factory";
import { PlexClient } from "@/lib/plex/client";
import { JellyfinClient } from "@/lib/jellyfin/client";
import { EmbyClient } from "@/lib/emby/client";

describe("createMediaServerClient", () => {
  // The constructor mocks are module-level, so their call records would
  // otherwise accumulate across tests and let `toHaveBeenCalledWith` match a
  // call an earlier test made.
  beforeEach(() => vi.clearAllMocks());

  it("returns a PlexClient for PLEX type", () => {
    const client = createMediaServerClient(
      "PLEX",
      "http://plex:32400",
      "plex-token",
    );
    expect(client).toEqual({ type: "plex" });
    expect(PlexClient).toHaveBeenCalledExactlyOnceWith(
      "http://plex:32400",
      "plex-token",
      undefined,
    );
    expect(JellyfinClient).not.toHaveBeenCalled();
    expect(EmbyClient).not.toHaveBeenCalled();
  });

  it("returns a JellyfinClient for JELLYFIN type", () => {
    const client = createMediaServerClient(
      "JELLYFIN",
      "http://jellyfin:8096",
      "jf-token",
    );
    expect(client).toEqual({ type: "jellyfin" });
    expect(JellyfinClient).toHaveBeenCalledExactlyOnceWith(
      "http://jellyfin:8096",
      "jf-token",
      undefined,
    );
    expect(PlexClient).not.toHaveBeenCalled();
    expect(EmbyClient).not.toHaveBeenCalled();
  });

  it("returns an EmbyClient for EMBY type", () => {
    const client = createMediaServerClient(
      "EMBY",
      "http://emby:8096",
      "emby-token",
    );
    expect(client).toEqual({ type: "emby" });
    expect(EmbyClient).toHaveBeenCalledExactlyOnceWith(
      "http://emby:8096",
      "emby-token",
      undefined,
    );
    expect(PlexClient).not.toHaveBeenCalled();
    expect(JellyfinClient).not.toHaveBeenCalled();
  });

  it("passes options to the client constructor", () => {
    const options = { skipTlsVerify: true };
    createMediaServerClient("PLEX", "http://plex:32400", "token", options);
    expect(PlexClient).toHaveBeenCalledExactlyOnceWith(
      "http://plex:32400",
      "token",
      options,
    );
  });

  it.each(["UNKNOWN", "KODI"])("throws an error naming the unsupported type %s", (type) => {
    expect(() =>
      createMediaServerClient(
        type as never,
        "http://localhost",
        "token",
      ),
    ).toThrow(`Unsupported media server type: ${type}`);
    expect(PlexClient).not.toHaveBeenCalled();
    expect(JellyfinClient).not.toHaveBeenCalled();
    expect(EmbyClient).not.toHaveBeenCalled();
  });
});
