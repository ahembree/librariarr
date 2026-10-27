// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { useCronScheduleSetting, CUSTOM_SCHEDULE } from "@/hooks/use-cron-schedule-setting";

const fetchMock = vi.fn();
const refresh = vi.fn();
const PRESETS = ["HOURLY", "DAILY", "WEEKLY"];

function setup() {
  return renderHook(() =>
    useCronScheduleSetting({
      endpoint: "/api/settings/sync-schedule",
      bodyKey: "syncSchedule",
      successMsg: "Sync schedule saved",
      refresh,
      presets: PRESETS,
      initial: "DAILY",
    }),
  );
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  refresh.mockReset();
  toasts.success.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCronScheduleSetting", () => {
  it("saves a preset at once, toasts, and refreshes", async () => {
    const { result } = setup();
    expect(result.current.schedule).toBe("DAILY");
    await act(async () => result.current.onScheduleChange("HOURLY"));
    expect(result.current.schedule).toBe("HOURLY");
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/sync-schedule", expect.objectContaining({ method: "PUT" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ syncSchedule: "HOURLY" });
    expect(toasts.success).toHaveBeenCalledWith("Sync schedule saved");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.saving).toBe(false);
  });

  it("opens the custom field without saving, then saves the expression", async () => {
    const { result } = setup();
    act(() => result.current.onScheduleChange(CUSTOM_SCHEDULE));
    expect(result.current.isCustom).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.setCustomCron("0 3 * * *"));
    await act(async () => result.current.save(result.current.customCron));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ syncSchedule: "0 3 * * *" });
  });

  it("shows the route's refusal, still refreshing, and a network failure", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Invalid cron expression" }) });
    const { result } = setup();
    await act(async () => result.current.save("nope"));
    expect(result.current.error).toBe("Invalid cron expression");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toasts.success).not.toHaveBeenCalled();

    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => result.current.save("0 * * * *"));
    expect(result.current.error).toBe("Failed to save schedule");
    // Picking a preset clears the error.
    await act(async () => result.current.onScheduleChange("WEEKLY"));
    expect(result.current.error).toBe("");
  });

  it("loads a stored preset as itself and anything else as a custom expression", () => {
    const { result } = setup();
    act(() => result.current.load("WEEKLY"));
    expect([result.current.schedule, result.current.isCustom]).toEqual(["WEEKLY", false]);
    act(() => result.current.load("*/5 * * * *"));
    expect([result.current.schedule, result.current.isCustom, result.current.customCron]).toEqual([
      CUSTOM_SCHEDULE,
      true,
      "*/5 * * * *",
    ]);
  });
});
