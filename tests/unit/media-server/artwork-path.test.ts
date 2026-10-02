import { describe, it, expect } from "vitest";
import { isSessionArtworkPath } from "@/lib/media-server/artwork-path";

describe("isSessionArtworkPath", () => {
  it.each([
    "/library/metadata/12345/thumb/1690000000",
    "/library/metadata/12345/thumb",
    "/library/metadata/12345/art/1690000000",
    "/library/metadata/7/clearLogo/1",
  ])("accepts the Plex session artwork path %s", (path) => {
    expect(isSessionArtworkPath("PLEX", path)).toBe(true);
  });

  it.each([
    "/Items/0123456789abcdef0123456789abcdef/Images/Primary",
    "/Items/12345/Images/Backdrop",
    "/Items/12345/Images/Backdrop/0",
  ])("accepts the Jellyfin/Emby session artwork path %s", (path) => {
    expect(isSessionArtworkPath("JELLYFIN", path)).toBe(true);
    expect(isSessionArtworkPath("EMBY", path)).toBe(true);
  });

  // Every one of these, fetched with the server's admin token and returned
  // as-is, would hand a session cookie the server's API.
  it.each([
    "/myplex/account",
    "/:/prefs",
    "/security/token",
    "/library/metadata/12345",
    "/library/metadata/12345/theme/1",
    "/library/metadata/12345/thumb/../../../myplex/account",
    "/library/metadata/12345/thumb/1?X-Plex-Token=x",
    "/library/metadata/abc/thumb",
    "/photo/:/transcode?url=/myplex/account",
    "/Items/12345/Images/Primary",
    "//attacker.example/library/metadata/1/thumb",
    "",
  ])("refuses %s for Plex", (path) => {
    expect(isSessionArtworkPath("PLEX", path)).toBe(false);
  });

  it.each([
    "/Auth/Keys",
    "/System/Configuration",
    "/Users",
    "/Items/12345",
    "/Items/12345/Images/Primary/../../../../Auth/Keys",
    "/Items/12345/Images/Primary?api_key=x",
    "/Items/../Auth/Keys/Images/Primary",
    "/library/metadata/12345/thumb",
  ])("refuses %s for Jellyfin and Emby", (path) => {
    expect(isSessionArtworkPath("JELLYFIN", path)).toBe(false);
    expect(isSessionArtworkPath("EMBY", path)).toBe(false);
  });
});
