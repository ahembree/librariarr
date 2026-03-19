import { describe, it, expect } from "vitest";
import { callRoute, expectJson } from "../../setup/test-helpers";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns 200 with status ok", async () => {
    const response = await callRoute(GET, {
      url: "/api/health",
    });
    const body = await expectJson<{ status: string }>(response, 200);
    expect(body.status).toBe("ok");
  });
});
