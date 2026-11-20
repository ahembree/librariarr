import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));

import {
  SESSION_RECHECK_INTERVAL_MS,
  endWhenSessionRevoked,
  sessionStanding,
} from "@/lib/auth/session-standing";

beforeEach(() => {
  findUnique.mockReset();
});

describe("sessionStanding", () => {
  it("is current while the row carries the session's version", async () => {
    findUnique.mockResolvedValue({ sessionVersion: 7 });
    expect(await sessionStanding("u1", 7)).toBe("current");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { sessionVersion: true } });
  });

  it("is revoked once the version moved or the account is gone", async () => {
    findUnique.mockResolvedValue({ sessionVersion: 8 });
    expect(await sessionStanding("u1", 7)).toBe("revoked");
    findUnique.mockResolvedValue(null);
    expect(await sessionStanding("u1", 7)).toBe("revoked");
  });

  it("is revoked, without a read, for a session that names no user or version", async () => {
    expect(await sessionStanding(undefined, 7)).toBe("revoked");
    expect(await sessionStanding("u1", undefined)).toBe("revoked");
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("is unknown when the row cannot be read", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await sessionStanding("u1", 7)).toBe("unknown");
  });
});

describe("endWhenSessionRevoked", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-checks every 30 seconds and ends once, when the session is revoked", async () => {
    expect(SESSION_RECHECK_INTERVAL_MS).toBe(30_000);
    findUnique.mockResolvedValue({ sessionVersion: 1 });
    const end = vi.fn();
    endWhenSessionRevoked({ userId: "u1", sessionVersion: 1 }, end);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();

    findUnique.mockResolvedValue({ sessionVersion: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(end).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(end).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it("reads the session's identity once, when the stream opens", async () => {
    findUnique.mockResolvedValue({ sessionVersion: 1 });
    const session = { userId: "u1" as string | undefined, sessionVersion: 1 as number | undefined };
    const end = vi.fn();
    endWhenSessionRevoked(session, end);
    // The request's session object is reused or cleared after the response.
    session.userId = undefined;
    session.sessionVersion = undefined;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, select: { sessionVersion: true } });
    expect(end).not.toHaveBeenCalled();
  });

  it("does not end on a database error, and does not stack checks behind a slow one", async () => {
    let release: (value: { sessionVersion: number }) => void = () => {};
    findUnique.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const end = vi.fn();
    endWhenSessionRevoked({ userId: "u1", sessionVersion: 1 }, end, 1000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(findUnique).toHaveBeenCalledTimes(1);
    release({ sessionVersion: 1 });
    await vi.advanceTimersByTimeAsync(0);

    findUnique.mockReset().mockRejectedValue(new Error("db down"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(end).not.toHaveBeenCalled();
  });

  it("stops when told to", async () => {
    findUnique.mockResolvedValue({ sessionVersion: 2 });
    const end = vi.fn();
    const stop = endWhenSessionRevoked({ userId: "u1", sessionVersion: 1 }, end);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(findUnique).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
