import { describe, it, expect, vi, beforeEach } from "vitest";

const { count } = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { mediaServer: { count } } }));

import { userHasServers } from "@/lib/api/has-servers";

describe("userHasServers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts the user's servers, enabled or not", async () => {
    count.mockResolvedValueOnce(2);
    expect(await userHasServers("u1")).toBe(true);
    expect(count).toHaveBeenCalledWith({ where: { userId: "u1" } });
  });

  it("is false for a user with none", async () => {
    count.mockResolvedValueOnce(0);
    expect(await userHasServers("u1")).toBe(false);
  });
});
