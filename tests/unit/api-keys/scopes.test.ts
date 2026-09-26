import { describe, it, expect } from "vitest";
import {
  API_SCOPES,
  API_SCOPE_GROUPS,
  API_SCOPE_INFO,
  READ_ONLY_SCOPES,
  hasDestructiveScope,
  isApiScope,
  isReadOnlyScopeSet,
  normalizeScopes,
} from "@/lib/api-keys/scopes";

describe("scope registry", () => {
  it("a read-only key gets every read scope and no write scope", () => {
    expect(READ_ONLY_SCOPES.length).toBeGreaterThan(0);
    for (const scope of READ_ONLY_SCOPES) expect(API_SCOPE_INFO[scope].access).toBe("read");
    const reads = API_SCOPES.filter((s) => API_SCOPE_INFO[s].access === "read");
    expect([...READ_ONLY_SCOPES].sort()).toEqual([...reads].sort());
  });

  it("names scopes resource:action, with read scopes ending :read", () => {
    for (const scope of API_SCOPES) {
      expect(scope).toMatch(/^[a-z]+:[a-z]+$/);
      expect(scope.endsWith(":read")).toBe(API_SCOPE_INFO[scope].access === "read");
    }
  });

  it("only implies read scopes, and only from write scopes", () => {
    for (const scope of API_SCOPES) {
      const implies = API_SCOPE_INFO[scope].implies ?? [];
      if (API_SCOPE_INFO[scope].access === "read") expect(implies).toEqual([]);
      for (const implied of implies) expect(API_SCOPE_INFO[implied].access).toBe("read");
    }
  });

  it("the settings UI groups list every scope exactly once", () => {
    const grouped = API_SCOPE_GROUPS.flatMap((g) => g.scopes);
    expect([...grouped].sort()).toEqual([...API_SCOPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("marks only lifecycle execution as destructive", () => {
    const destructive = API_SCOPES.filter((s) => API_SCOPE_INFO[s].destructive);
    expect(destructive).toEqual(["lifecycle:execute"]);
  });
});

describe("normalizeScopes", () => {
  it("adds the read scope a write scope needs", () => {
    expect(normalizeScopes(["sync:write"])).toEqual(["servers:read", "sync:write"]);
    expect(normalizeScopes(["lifecycle:execute"])).toEqual(["lifecycle:read", "lifecycle:execute"]);
    expect(normalizeScopes(["streams:write"])).toEqual(["streams:read", "streams:write"]);
  });

  it("deduplicates and returns registry order", () => {
    expect(
      normalizeScopes(["system:read", "media:read", "media:read", "lifecycle:write", "lifecycle:read"]),
    ).toEqual(["media:read", "lifecycle:read", "lifecycle:write", "system:read"]);
  });

  it("returns every read scope unchanged for a read-only key", () => {
    expect(normalizeScopes(READ_ONLY_SCOPES)).toEqual([...READ_ONLY_SCOPES]);
  });
});

describe("scope predicates", () => {
  it("isApiScope accepts only registry scopes", () => {
    expect(isApiScope("media:read")).toBe(true);
    expect(isApiScope("media:write")).toBe(false);
    expect(isApiScope("*")).toBe(false);
    expect(isApiScope("")).toBe(false);
  });

  it("isReadOnlyScopeSet: read scopes only", () => {
    expect(isReadOnlyScopeSet(READ_ONLY_SCOPES)).toBe(true);
    expect(isReadOnlyScopeSet(["media:read", "sync:write"])).toBe(false);
  });

  it("isReadOnlyScopeSet never calls an unknown scope harmless", () => {
    expect(isReadOnlyScopeSet(["media:read", "admin:everything"])).toBe(false);
  });

  it("hasDestructiveScope", () => {
    expect(hasDestructiveScope(["lifecycle:read", "lifecycle:execute"])).toBe(true);
    expect(hasDestructiveScope(["lifecycle:read", "lifecycle:write"])).toBe(false);
    expect(hasDestructiveScope(["unknown:scope"])).toBe(false);
  });
});
