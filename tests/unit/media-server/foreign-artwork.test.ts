import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: { get: mockGet } }));

import {
  fetchForeignArtwork,
  isFetchableArtworkUrl,
  isServerRelativePath,
} from "@/lib/media-server/foreign-artwork";

const PEOPLE = "https://metadata-static.plex.tv/a/people/2b1c4f0e.jpg";

beforeEach(() => {
  mockGet.mockReset();
});

describe("isServerRelativePath", () => {
  it("accepts a path on the server and refuses anything naming a host", () => {
    expect(isServerRelativePath("/library/metadata/1/thumb/2")).toBe(true);
    expect(isServerRelativePath(PEOPLE)).toBe(false);
    expect(isServerRelativePath("//evil.test/x.jpg")).toBe(false);
    expect(isServerRelativePath("library/metadata/1/thumb")).toBe(false);
    expect(isServerRelativePath("")).toBe(false);
  });
});

describe("isFetchableArtworkUrl", () => {
  it("accepts a public https name", () => {
    expect(isFetchableArtworkUrl(PEOPLE)).toBe(true);
    expect(isFetchableArtworkUrl("https://image.tmdb.org/t/p/original/x.jpg")).toBe(true);
  });

  it.each([
    ["plain http", "http://metadata-static.plex.tv/a.jpg"],
    ["another scheme", "file:///etc/passwd"],
    ["an IPv4 literal", "https://192.168.1.10/a.jpg"],
    ["a public IPv4 literal", "https://203.0.113.7/a.jpg"],
    ["an IPv6 literal", "https://[::1]/a.jpg"],
    ["localhost", "https://localhost/a.jpg"],
    ["a localhost subdomain", "https://app.localhost/a.jpg"],
    ["a single-label intranet name", "https://sonarr/a.jpg"],
    ["credentials in the URL", "https://user:pass@example.com/a.jpg"],
    ["a protocol-relative URL", "//example.com/a.jpg"],
    ["not a URL", "nope"],
  ])("refuses %s", (_label, url) => {
    expect(isFetchableArtworkUrl(url)).toBe(false);
  });
});

describe("fetchForeignArtwork", () => {
  it("fetches with no credential and returns the image", async () => {
    mockGet.mockResolvedValue({ data: Buffer.from("jpeg"), headers: { "content-type": "image/jpeg" } });

    const result = await fetchForeignArtwork(PEOPLE);

    expect(result).toEqual({ data: Buffer.from("jpeg"), contentType: "image/jpeg" });
    const [url, config] = mockGet.mock.calls[0];
    expect(url).toBe(PEOPLE);
    expect(config.headers).toEqual({ Accept: "image/*" });
    expect(config.maxRedirects).toBe(3);
    expect(config.maxContentLength).toBeGreaterThan(0);
  });

  it("makes no request for a URL that is not a public https address", async () => {
    await expect(fetchForeignArtwork("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      "not a public https address",
    );
    await expect(fetchForeignArtwork("https://10.0.0.5/admin")).rejects.toThrow("not a public https address");
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("refuses a redirect to an address it would not have fetched", async () => {
    mockGet.mockResolvedValue({ data: Buffer.from("jpeg"), headers: { "content-type": "image/jpeg" } });
    await fetchForeignArtwork(PEOPLE);
    const { beforeRedirect } = mockGet.mock.calls[0][1];

    expect(() => beforeRedirect({ href: "https://cdn.plex.tv/b.jpg" })).not.toThrow();
    expect(() => beforeRedirect({ href: "http://192.168.1.1/" })).toThrow("not a public https address");
    expect(() => beforeRedirect({})).toThrow("not a public https address");
  });

  it("refuses an answer that is not an image", async () => {
    mockGet.mockResolvedValue({ data: Buffer.from("<html>"), headers: { "content-type": "text/html" } });
    await expect(fetchForeignArtwork(PEOPLE)).rejects.toThrow("did not answer with an image");

    mockGet.mockResolvedValue({ data: Buffer.from("x"), headers: {} });
    await expect(fetchForeignArtwork(PEOPLE)).rejects.toThrow("did not answer with an image");
  });
});
