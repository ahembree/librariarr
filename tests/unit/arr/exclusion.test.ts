import { describe, it, expect } from "vitest";
import { IntegrationError } from "@/lib/integration-error";
import { isExistingExclusionError } from "@/lib/arr/exclusion";

function arrError(status: number, data: unknown): IntegrationError {
  return new IntegrationError("Radarr", {
    config: { url: "/api/v3/exclusions", method: "post" },
    response: { status, data },
    code: "ERR_BAD_REQUEST",
  } as never);
}

describe("isExistingExclusionError", () => {
  it("recognises the duplicate-exclusion validation failure", () => {
    expect(isExistingExclusionError(arrError(400, [
      { propertyName: "TmdbId", errorMessage: "This exclusion has already been added." },
    ]))).toBe(true);
  });

  it("does not swallow a failure that also carries another validation error", () => {
    expect(isExistingExclusionError(arrError(400, [
      { propertyName: "TmdbId", errorMessage: "This exclusion has already been added." },
      { propertyName: "MovieTitle", errorMessage: "'Movie Title' must not be empty." },
    ]))).toBe(false);
  });

  it("does not swallow other statuses or bodies", () => {
    expect(isExistingExclusionError(arrError(500, [
      { errorMessage: "This exclusion has already been added." },
    ]))).toBe(false);
    expect(isExistingExclusionError(arrError(400, { message: "Bad request" }))).toBe(false);
    expect(isExistingExclusionError(new Error("This exclusion has already been added."))).toBe(false);
  });
});
