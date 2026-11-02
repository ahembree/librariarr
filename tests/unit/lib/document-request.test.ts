import { describe, it, expect } from "vitest";
import { isDocumentRequest } from "@/lib/document-request";

const headersOf = (values: Record<string, string>) => new Headers(values);

describe("isDocumentRequest", () => {
  it("reads the browser's Fetch Metadata", () => {
    expect(isDocumentRequest(headersOf({ "sec-fetch-dest": "document", accept: "text/html" }))).toBe(true);
    // The router's RSC fetch: Next.js has already removed its own RSC header.
    expect(isDocumentRequest(headersOf({ "sec-fetch-dest": "empty", accept: "*/*" }))).toBe(false);
  });

  it("trusts Fetch Metadata over Accept", () => {
    expect(isDocumentRequest(headersOf({ "sec-fetch-dest": "empty", accept: "text/html" }))).toBe(false);
  });

  it("falls back to Accept for a browser that sends no Fetch Metadata", () => {
    expect(isDocumentRequest(headersOf({ accept: "text/html,application/xhtml+xml,*/*;q=0.8" }))).toBe(true);
    expect(isDocumentRequest(headersOf({ accept: "*/*" }))).toBe(false);
    expect(isDocumentRequest(headersOf({}))).toBe(false);
  });
});
