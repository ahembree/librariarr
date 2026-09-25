import { describe, it, expect } from "vitest";
import { IntegrationError } from "@/lib/integration-error";
import { isHostLevelFailure, UnreachableInstances } from "@/lib/lifecycle/unreachable-instances";

function integrationError(status: number | null) {
  return new IntegrationError("Radarr", {
    config: { url: "/api/v3/movie" },
    code: status === null ? "ECONNABORTED" : "ERR_BAD_RESPONSE",
    response: status === null ? undefined : { status, data: {} },
  } as never);
}

describe("isHostLevelFailure", () => {
  it.each([null, 502, 503, 504])("is true for %s", (status) => {
    expect(isHostLevelFailure(integrationError(status))).toBe(true);
  });

  it.each([400, 401, 404, 500])("is false for the item-specific %s", (status) => {
    expect(isHostLevelFailure(integrationError(status))).toBe(false);
  });

  it("is false for anything that is not an IntegrationError", () => {
    expect(isHostLevelFailure(new Error("Movie not found in Radarr"))).toBe(false);
    expect(isHostLevelFailure(undefined)).toBe(false);
  });
});

describe("UnreachableInstances", () => {
  it("records only host-level failures, keeping the first", () => {
    const u = new UnreachableInstances();
    expect(u.record("r1", integrationError(404))).toBe(false);
    expect(u.get("r1")).toBeUndefined();

    const first = integrationError(503);
    expect(u.record("r1", first)).toBe(true);
    u.record("r1", integrationError(null));
    expect(u.get("r1")).toBe(first);
    expect(u.get("r2")).toBeUndefined();
  });

  it("ignores actions with no instance", () => {
    const u = new UnreachableInstances();
    expect(u.record(null, integrationError(null))).toBe(false);
    expect(u.get(null)).toBeUndefined();
  });
});
