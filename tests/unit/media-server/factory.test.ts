import { describe, it, expect, vi } from "vitest";

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
  it("returns a PlexClient for PLEX type", () => {
    const client = createMediaServerClient(
      "PLEX",
      "http://plex:32400",
      "plex-token",
    );
    expect(client).toEqual({ type: "plex" });
    expect(PlexClient).toHaveBeenCalledWith(
      "http://plex:32400",
      "plex-token",
      undefined,
    );
  });

  it("returns a JellyfinClient for JELLYFIN type", () => {
    const client = createMediaServerClient(
      "JELLYFIN",
      "http://jellyfin:8096",
      "jf-token",
    );
    expect(client).toEqual({ type: "jellyfin" });
    expect(JellyfinClient).toHaveBeenCalledWith(
      "http://jellyfin:8096",
      "jf-token",
      undefined,
    );
  });

  it("returns an EmbyClient for EMBY type", () => {
    const client = createMediaServerClient(
      "EMBY",
      "http://emby:8096",
      "emby-token",
    );
    expect(client).toEqual({ type: "emby" });
    expect(EmbyClient).toHaveBeenCalledWith(
      "http://emby:8096",
      "emby-token",
      undefined,
    );
  });

  it("passes options to the client constructor", () => {
    const options = { skipTlsVerify: true };
    createMediaServerClient("PLEX", "http://plex:32400", "token", options);
    expect(PlexClient).toHaveBeenCalledWith(
      "http://plex:32400",
      "token",
      options,
    );
  });

  it("throws an error for unsupported media server type", () => {
    expect(() =>
      createMediaServerClient(
        "UNKNOWN" as never,
        "http://localhost",
        "token",
      ),
    ).toThrow("Unsupported media server type: UNKNOWN");
  });

  it("includes the unsupported type name in the error message", () => {
    expect(() =>
      createMediaServerClient(
        "KODI" as never,
        "http://localhost",
        "token",
      ),
    ).toThrow("KODI");
  });
});
