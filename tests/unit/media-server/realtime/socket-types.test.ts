import { describe, it, expect } from "vitest";
import { buildRealtimeUrl, buildRealtimeHeaders } from "@/lib/media-server/realtime/socket";
import type { MediaServerType } from "@/generated/prisma/client";

describe("realtime URL/header builders for an unknown server type", () => {
  it("refuses to build a URL", () => {
    expect(() => buildRealtimeUrl("KODI" as MediaServerType, "http://h", "t")).toThrow(
      "Unsupported media server type for realtime: KODI",
    );
  });

  it("sends no auth headers", () => {
    expect(buildRealtimeHeaders("KODI" as MediaServerType, "t")).toEqual({});
  });

  it("keeps the Plex client identifier beside the token", () => {
    expect(buildRealtimeHeaders("PLEX", "t")).toEqual({ "X-Plex-Token": "t", "X-Plex-Client-Identifier": "librariarr" });
  });
});
