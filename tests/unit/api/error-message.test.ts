import { describe, it, expect } from "vitest";
import { responseErrorMessage, readResponseError } from "@/lib/api/error-message";

describe("responseErrorMessage", () => {
  it("appends the first validation detail, as a string or a Zod issue", () => {
    expect(responseErrorMessage({ error: "Validation failed", details: ["name: Too long"] }, "x"))
      .toBe("Validation failed — name: Too long");
    expect(responseErrorMessage({ error: "Validation failed", details: [{ message: "Required" }] }, "x"))
      .toBe("Validation failed — Required");
  });

  it("falls back to `detail`, then to the error alone, then to the fallback", () => {
    expect(responseErrorMessage({ error: "Failed", detail: "timeout" }, "x")).toBe("Failed — timeout");
    expect(responseErrorMessage({ error: "These criteria are not valid for the selected media types: arrTag" }, "x"))
      .toBe("These criteria are not valid for the selected media types: arrTag");
    expect(responseErrorMessage(null, "Couldn't save")).toBe("Couldn't save");
  });
});

describe("readResponseError", () => {
  it("reads the server's reason from a JSON body", async () => {
    const resp = new Response(JSON.stringify({ error: "Name taken" }), { status: 409 });
    expect(await readResponseError(resp, "fallback")).toBe("Name taken");
  });

  it("uses the fallback when the body is not JSON", async () => {
    expect(await readResponseError(new Response("<html>", { status: 502 }), "fallback")).toBe("fallback");
  });
});
