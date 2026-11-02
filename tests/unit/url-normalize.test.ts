import { describe, it, expect } from "vitest";
import { stripTrailingSlashes } from "@/lib/url-normalize";

describe("stripTrailingSlashes", () => {
  it("drops every trailing slash", () => {
    expect(stripTrailingSlashes("http://radarr:7878/")).toBe("http://radarr:7878");
    expect(stripTrailingSlashes("http://radarr:7878///")).toBe("http://radarr:7878");
    expect(stripTrailingSlashes("https://idp.example/realms/home/")).toBe("https://idp.example/realms/home");
  });

  it("leaves a URL without one, and slashes elsewhere, alone", () => {
    expect(stripTrailingSlashes("http://radarr:7878")).toBe("http://radarr:7878");
    expect(stripTrailingSlashes("http://host/base/path")).toBe("http://host/base/path");
    expect(stripTrailingSlashes("/library/movies")).toBe("/library/movies");
  });

  it("empties a value made only of slashes", () => {
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
  });
});
