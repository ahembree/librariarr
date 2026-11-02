import { describe, it, expect } from "vitest";
import { MASKED_VALUE } from "@/lib/api/sanitize";
import {
  addRequestBody,
  changesConnection,
  editFormOf,
  editRequestBody,
  testConnectionBody,
  type IntegrationInstance,
} from "@/app/(authenticated)/settings/integration-instances";

const stored: IntegrationInstance = {
  id: "i1",
  name: "Main",
  url: "http://sonarr.lan:8989",
  apiKey: MASKED_VALUE,
  externalUrl: "https://sonarr.example.com",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ARR = { hasExternalUrl: true };
const TRACEARR = { hasExternalUrl: false };

describe("changesConnection", () => {
  it("is false for a rename or an External URL change", () => {
    expect(changesConnection({ url: stored.url, apiKey: "" }, stored)).toBe(false);
  });

  it("ignores a trailing slash or surrounding spaces on the URL", () => {
    expect(changesConnection({ url: " http://sonarr.lan:8989/// ", apiKey: "" }, stored)).toBe(false);
  });

  it("is true for a new URL or a new key", () => {
    expect(changesConnection({ url: "http://other:8989", apiKey: "" }, stored)).toBe(true);
    expect(changesConnection({ url: stored.url, apiKey: "new-key" }, stored)).toBe(true);
  });

  it("reads the mask a GET returned as no new key", () => {
    expect(changesConnection({ url: stored.url, apiKey: MASKED_VALUE }, stored)).toBe(false);
  });
});

describe("editFormOf", () => {
  it("starts from the stored values with a blank key", () => {
    expect(editFormOf(stored)).toEqual({
      name: "Main",
      url: "http://sonarr.lan:8989",
      apiKey: "",
      externalUrl: "https://sonarr.example.com",
    });
    expect(editFormOf({ ...stored, externalUrl: undefined }).externalUrl).toBe("");
  });
});

describe("addRequestBody", () => {
  const form = { name: "N", url: "http://x", apiKey: "k", externalUrl: "" };
  it("sends the External URL only for a type that stores one", () => {
    expect(addRequestBody(form, ARR)).toEqual({ name: "N", url: "http://x", apiKey: "k", externalUrl: "" });
    expect(addRequestBody(form, TRACEARR)).toEqual({ name: "N", url: "http://x", apiKey: "k" });
  });
});

describe("editRequestBody", () => {
  it("leaves the External URL out when it is unchanged", () => {
    const body = editRequestBody(editFormOf(stored), stored, ARR);
    expect(body).toEqual({ name: "Main", url: "http://sonarr.lan:8989" });
  });

  it("sends a changed External URL, including a cleared one", () => {
    expect(editRequestBody({ ...editFormOf(stored), externalUrl: "https://new.example.com" }, stored, ARR).externalUrl).toBe(
      "https://new.example.com",
    );
    expect(editRequestBody({ ...editFormOf(stored), externalUrl: "" }, stored, ARR)).toHaveProperty("externalUrl", "");
  });

  it("compares against no External URL for an instance without one", () => {
    const bare = { ...stored, externalUrl: null };
    expect(editRequestBody(editFormOf(bare), bare, ARR)).not.toHaveProperty("externalUrl");
  });

  it("never sends an External URL for a type without one", () => {
    expect(editRequestBody({ ...editFormOf(stored), externalUrl: "https://x" }, stored, TRACEARR)).not.toHaveProperty(
      "externalUrl",
    );
  });

  it("sends a typed key, never a blank or masked one", () => {
    expect(editRequestBody({ ...editFormOf(stored), apiKey: "new" }, stored, ARR).apiKey).toBe("new");
    expect(editRequestBody({ ...editFormOf(stored), apiKey: MASKED_VALUE }, stored, ARR)).not.toHaveProperty("apiKey");
  });
});

describe("testConnectionBody", () => {
  it("sends what is on screen and lets the route use the stored key otherwise", () => {
    expect(testConnectionBody({})).toEqual({});
    expect(testConnectionBody({ url: "http://x", apiKey: "" })).toEqual({ url: "http://x" });
    expect(testConnectionBody({ url: "http://x", apiKey: MASKED_VALUE })).toEqual({ url: "http://x" });
    expect(testConnectionBody({ url: "http://x", apiKey: "k" })).toEqual({ url: "http://x", apiKey: "k" });
  });
});
