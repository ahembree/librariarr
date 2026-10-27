// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reauth = vi.hoisted(() => ({ fetchWithReauth: vi.fn() }));
vi.mock("@/lib/auth/reauth-client", () => reauth);
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PlexLoginPrompt } from "@/components/plex-login-prompt";

beforeEach(() => {
  reauth.fetchWithReauth.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe("PlexLoginPrompt", () => {
  it("turns Plex login on and reports it", async () => {
    let finish: (res: Response) => void = () => {};
    reauth.fetchWithReauth.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    const onDone = vi.fn();
    render(createElement(PlexLoginPrompt, { open: true, onDone }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable Plex login" }));
    });
    expect(reauth.fetchWithReauth).toHaveBeenCalledWith("/api/settings/auth", expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(reauth.fetchWithReauth.mock.calls[0][1].body)).toEqual({ plexLoginEnabled: true });
    // Nothing can be dismissed while the save runs.
    expect((screen.getByRole("button", { name: "Keep it off" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      finish(new Response("{}", { status: 200 }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(true);
    expect(toast.success).toHaveBeenCalled();
  });

  it("closes with Plex login still off when the save is refused", async () => {
    reauth.fetchWithReauth.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 400 }));
    const onDone = vi.fn();
    render(createElement(PlexLoginPrompt, { open: true, onDone }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable Plex login" }));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith(false);
    expect(toast.error).toHaveBeenCalled();
  });

  it("closes with Plex login still off on Keep it off", async () => {
    const onDone = vi.fn();
    render(createElement(PlexLoginPrompt, { open: true, onDone }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep it off" }));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(false);
    expect(reauth.fetchWithReauth).not.toHaveBeenCalled();
  });
});
