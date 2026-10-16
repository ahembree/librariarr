// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePlexOAuth } from "@/hooks/use-plex-oauth";

interface FakePopup {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  location: { href: string };
}

const INIT = { authUrl: "https://app.plex.tv/auth#?code=abc", pinId: 42, code: "abc", clientId: "cid", product: "Librariarr", version: "1.0" };

let popup: FakePopup;
const openMock = vi.fn();
const fetchMock = vi.fn();
let pinResponses: Array<Record<string, unknown> | Error>;

function makePopup(): FakePopup {
  const p: FakePopup = { closed: false, close: vi.fn(() => (p.closed = true)), location: { href: "/login/plex/loading" } };
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  popup = makePopup();
  openMock.mockReset().mockImplementation(() => popup);
  pinResponses = [];
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/auth/plex/init") return { ok: true, json: async () => INIT };
    const next = pinResponses.shift() ?? {};
    if (next instanceof Error) throw next;
    return { ok: true, json: async () => next };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("open", openMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pinCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://plex.tv"));
const tick = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});

function setup(onSuccess = vi.fn(async () => {}), onError = vi.fn()) {
  const hook = renderHook(() => usePlexOAuth({ onSuccess, onError }));
  return { ...hook, onSuccess, onError };
}

describe("usePlexOAuth", () => {
  it("opens the loading page, sends it to Plex and polls the pin with the client headers", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(openMock).toHaveBeenCalledWith("/login/plex/loading", "_blank", "width=600,height=700");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/plex/init", expect.objectContaining({ method: "POST" }));
    expect(popup.location.href).toBe(INIT.authUrl);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.authUrl).toBe(INIT.authUrl);

    expect(pinCalls()).toHaveLength(1);
    const [url, init] = pinCalls()[0];
    expect(url).toBe("https://plex.tv/api/v2/pins/42?code=abc");
    expect(init.headers).toMatchObject({
      "X-Plex-Client-Identifier": "cid",
      "X-Plex-Product": "Librariarr",
      "X-Plex-Version": "1.0",
    });

    await tick(2000);
    expect(pinCalls()).toHaveLength(2);
  });

  it("hands the token to onSuccess, closes the popup and stops polling", async () => {
    pinResponses = [{}, { authToken: "tok" }];
    const { result, onSuccess } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    await tick(2000);
    expect(onSuccess).toHaveBeenCalledWith("tok");
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.authUrl).toBeNull();
    const polls = pinCalls().length;
    await tick(10000);
    expect(pinCalls()).toHaveLength(polls);
  });

  it("surfaces an onSuccess failure as the error", async () => {
    pinResponses = [{ authToken: "tok" }];
    const onSuccess = vi.fn(async () => {
      throw new Error("Not the server owner");
    });
    const { result, onError } = setup(onSuccess);
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.error).toBe("Not the server owner");
    expect(onError).toHaveBeenCalledWith("Not the server owner");
    expect(result.current.isLoading).toBe(false);
  });

  it("uses a generic message when onSuccess throws a non-Error", async () => {
    pinResponses = [{ authToken: "tok" }];
    const { result } = setup(vi.fn(async () => {
      throw "nope";
    }));
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.error).toBe("Authentication failed");
  });

  it("keeps polling through a network error", async () => {
    pinResponses = [new Error("offline"), { authToken: "tok" }];
    const { result, onSuccess } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(onSuccess).not.toHaveBeenCalled();
    await tick(2000);
    expect(onSuccess).toHaveBeenCalledWith("tok");
  });

  it("reports the server's error when init fails and closes the popup", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => ({ error: "Too many requests" }) }));
    const { result, onError } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.error).toBe("Too many requests");
    expect(onError).toHaveBeenCalledWith("Too many requests");
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(pinCalls()).toHaveLength(0);
  });

  it("uses a default message for an init failure without a JSON body", async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, json: async () => {
      throw new SyntaxError("bad");
    } }));
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.error).toBe("Failed to start Plex authentication");
  });

  it("reports a thrown init request", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.error).toBe("Failed to start Plex authentication");
    expect(result.current.isLoading).toBe(false);
  });

  it("still polls from the main tab when the popup was blocked", async () => {
    openMock.mockReturnValue(null);
    pinResponses = [{}, { authToken: "tok" }];
    const { result, onSuccess } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    expect(result.current.authUrl).toBe(INIT.authUrl);
    await tick(2000);
    expect(onSuccess).toHaveBeenCalledWith("tok");
  });

  it("cancels when the user closes the popup", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    popup.closed = true;
    await tick(1000);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.authUrl).toBeNull();
    const polls = pinCalls().length;
    await tick(10000);
    expect(pinCalls()).toHaveLength(polls);
  });

  it("gives up after five minutes", async () => {
    // Keep the popup open but unreadable, as a cross-origin Plex page is.
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    Object.defineProperty(popup, "closed", { get: () => {
      throw new Error("cross-origin");
    }, configurable: true });
    await tick(299_000);
    expect(result.current.isLoading).toBe(true);
    await tick(1000);
    expect(result.current.isLoading).toBe(false);
  });

  it("cancel() stops the flow and closes the popup", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    act(() => result.current.cancel());
    expect(popup.close).toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    const polls = pinCalls().length;
    await tick(10000);
    expect(pinCalls()).toHaveLength(polls);
  });

  it("polls immediately when the tab becomes visible again", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    const polls = pinCalls().length;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pinCalls()).toHaveLength(polls + 1);
  });

  it("stops every timer on unmount", async () => {
    const { result, unmount } = setup();
    await act(async () => {
      await result.current.startAuth();
    });
    unmount();
    const polls = pinCalls().length;
    await vi.advanceTimersByTimeAsync(400_000);
    expect(pinCalls()).toHaveLength(polls);
  });
});
