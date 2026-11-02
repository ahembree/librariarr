import { describe, it, expect } from "vitest";
import { isMediaItemNotFound, MediaItemNotFoundError } from "@/lib/media-server/client";

// The full sync's stale purge deletes a row (and, by cascade, its plays,
// matches and lifecycle exceptions) only on this verdict, so anything that is
// not the server saying "gone" must read as false.
describe("isMediaItemNotFound", () => {
  it("is true for a MediaItemNotFoundError", () => {
    expect(isMediaItemNotFound(new MediaItemNotFoundError("rk1"))).toBe(true);
  });

  it("is true for an HTTP 404 (how Jellyfin/Emby answer a missing item)", () => {
    const error = Object.assign(new Error("Request failed with status code 404"), {
      response: { status: 404 },
    });
    expect(isMediaItemNotFound(error)).toBe(true);
  });

  it.each([
    ["a timeout", Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" })],
    ["a 500", Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } })],
    ["a 401", Object.assign(new Error("Request failed with status code 401"), { response: { status: 401 } })],
    ["the circuit breaker", Object.assign(new Error("Server is unreachable"), { code: "SERVER_UNREACHABLE" })],
    ["an unparseable body", new Error("Unrecognized Plex metadata response for rk1 (no MediaContainer)")],
  ])("is false for %s", (_label, error) => {
    expect(isMediaItemNotFound(error)).toBe(false);
  });

  it.each([null, undefined, "404", 404, {}])("is false for a non-error value (%s)", (value) => {
    expect(isMediaItemNotFound(value)).toBe(false);
  });
});
