import { describe, it, expect } from "vitest";
import { toWsBase, buildRealtimeUrl, buildRealtimeHeaders } from "@/lib/media-server/realtime/socket";

describe("toWsBase", () => {
  it("maps http→ws and https→wss and strips trailing slashes", () => {
    expect(toWsBase("http://plex:32400")).toBe("ws://plex:32400");
    expect(toWsBase("https://jf.example.com/")).toBe("wss://jf.example.com");
    expect(toWsBase("https://host//")).toBe("wss://host");
  });

  it("passes through ws/wss and defaults a bare host to ws", () => {
    expect(toWsBase("wss://host")).toBe("wss://host");
    expect(toWsBase("ws://host")).toBe("ws://host");
    expect(toWsBase("host:8096")).toBe("ws://host:8096");
  });
});

describe("buildRealtimeUrl", () => {
  it("builds the Plex notifications URL with a URL-encoded token", () => {
    expect(buildRealtimeUrl("PLEX", "http://plex:32400", "tok en")).toBe(
      "ws://plex:32400/:/websockets/notifications?X-Plex-Token=tok%20en",
    );
  });

  it("builds the Jellyfin socket URL", () => {
    expect(buildRealtimeUrl("JELLYFIN", "https://jf/", "abc")).toBe(
      "wss://jf/socket?api_key=abc&deviceId=librariarr",
    );
  });

  it("builds the Emby websocket URL", () => {
    expect(buildRealtimeUrl("EMBY", "http://emby:8096", "k")).toBe(
      "ws://emby:8096/embywebsocket?api_key=k&deviceId=librariarr",
    );
  });
});

describe("buildRealtimeHeaders", () => {
  it("carries the token in the per-type auth header", () => {
    expect(buildRealtimeHeaders("PLEX", "t")["X-Plex-Token"]).toBe("t");
    expect(buildRealtimeHeaders("JELLYFIN", "t").Authorization).toContain('Token="t"');
    expect(buildRealtimeHeaders("EMBY", "t")["X-Emby-Token"]).toBe("t");
  });
});
