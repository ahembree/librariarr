// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderHook, act, render, screen, fireEvent, waitFor } from "@testing-library/react";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { useRuleSetTypeFilter, LIFECYCLE_TAB_TO_TYPE } from "@/hooks/use-rule-set-type-filter";
import { RuleSetGroupCard, LIFECYCLE_MEDIA_TYPE_TABS } from "@/components/rule-set-group-card";
import { useLifecycleExceptions, fetchExceptedItemIds, LIFECYCLE_EXCEPTIONS_URL } from "@/hooks/use-lifecycle-exceptions";
import { ExcludeReasonDialog } from "@/components/exclude-reason-dialog";

const fetchMock = vi.fn();
beforeEach(() => {
  toasts.error.mockReset();
  toasts.success.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useRuleSetTypeFilter", () => {
  const groups = [
    { ruleSet: { type: "MOVIE" }, n: 1 },
    { ruleSet: { type: "SERIES" }, n: 2 },
    { ruleSet: { type: "MOVIE" }, n: 3 },
  ];
  const ruleSetOf = (g: (typeof groups)[number]) => g.ruleSet;

  it("shows everything on All and only the tab's type otherwise", () => {
    const { result } = renderHook(() => useRuleSetTypeFilter(groups, ruleSetOf));
    expect(result.current.tab).toBe("all");
    expect(result.current.filtered).toBe(groups);
    act(() => result.current.setTab("movies"));
    expect(result.current.filtered.map((g) => g.n)).toEqual([1, 3]);
    act(() => result.current.setTab("music"));
    expect(result.current.filtered).toEqual([]);
  });

  it("has a tab for every type the map names", () => {
    expect(LIFECYCLE_MEDIA_TYPE_TABS.map((t) => t.value)).toEqual(Object.keys(LIFECYCLE_TAB_TO_TYPE));
  });
});

describe("RuleSetGroupCard", () => {
  const ruleSet = {
    id: "rs",
    name: "Old movies",
    type: "MOVIE",
    deleted: true,
    actionType: "DELETE_RADARR",
    addArrTags: ["keep"],
    removeArrTags: ["new"],
  };

  it("toggles from its header and keeps clicks on its buttons to themselves", () => {
    const onToggle = vi.fn();
    const onRun = vi.fn();
    const { rerender } = render(
      createElement(
        RuleSetGroupCard,
        {
          ruleSet,
          countLabel: "3 matches",
          expanded: false,
          onToggle,
          meta: createElement("span", null, "Collection: Leaving"),
          actions: createElement("button", { onClick: onRun }, "Re-evaluate"),
        },
        createElement("p", null, "The items"),
      ),
    );
    expect(screen.getByText("Old movies")).toBeTruthy();
    expect(screen.getByText("(Deleted)")).toBeTruthy();
    expect(screen.getByText("3 matches")).toBeTruthy();
    expect(screen.getByText("+keep")).toBeTruthy();
    expect(screen.getByText("-new")).toBeTruthy();
    expect(screen.getByText("Collection: Leaving")).toBeTruthy();
    expect(screen.getByText(/^Action:/)).toBeTruthy();
    expect(screen.queryByText("The items")).toBeNull();

    fireEvent.click(screen.getByText("Old movies"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Re-evaluate" }));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      createElement(
        RuleSetGroupCard,
        { ruleSet, countLabel: "3 matches", expanded: true, onToggle, showAction: false },
        createElement("p", null, "The items"),
      ),
    );
    expect(screen.getByText("The items")).toBeTruthy();
    expect(screen.queryByText(/^Action:/)).toBeNull();
  });
});

describe("useLifecycleExceptions", () => {
  const list = (ids: string[]) => ({ ok: true, json: async () => ({ mediaItemIds: ids }) });

  it("reads the excepted ids, null when the listing fails", async () => {
    fetchMock.mockResolvedValueOnce(list(["a", "b"]));
    expect(await fetchExceptedItemIds()).toEqual(new Set(["a", "b"]));
    expect(fetchMock).toHaveBeenCalledWith(`${LIFECYCLE_EXCEPTIONS_URL}?idsOnly=1`);
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await fetchExceptedItemIds()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchExceptedItemIds()).toBeNull();
  });

  it("loads on mount, and excludes an item through the route", async () => {
    fetchMock.mockResolvedValueOnce(list(["a"]));
    const { result } = renderHook(() => useLifecycleExceptions({ announce: true }));
    await waitFor(() => expect(result.current.exceptedIds.has("a")).toBe(true));

    let release!: () => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { release = () => r({ ok: true, json: async () => ({}) }); }));
    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.exclude("b", { reason: "Favourite", label: "Inception" });
    });
    expect(result.current.excludingIds.has("b")).toBe(true);
    await act(async () => release());
    expect(await saved).toBe(true);
    expect(result.current.excludingIds.has("b")).toBe(false);
    expect(result.current.exceptedIds.has("b")).toBe(true);
    expect(fetchMock).toHaveBeenLastCalledWith(LIFECYCLE_EXCEPTIONS_URL, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ mediaItemId: "b", reason: "Favourite" });
    expect(toasts.success).toHaveBeenCalledWith("Excluded from lifecycle actions", { description: "Inception" });
  });

  it("says why a refusal failed, and keeps the item out of the excepted set", async () => {
    fetchMock.mockResolvedValueOnce(list([]));
    const { result } = renderHook(() => useLifecycleExceptions());
    await act(async () => {});
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Already excluded" }) });
    let saved = true;
    await act(async () => {
      saved = await result.current.exclude("c");
    });
    expect(saved).toBe(false);
    expect(result.current.exceptedIds.has("c")).toBe(false);
    expect(toasts.error).toHaveBeenCalledWith("Couldn't exclude item", { description: "Already excluded" });
    expect(toasts.success).not.toHaveBeenCalled();
    // The reason is left out when none was given.
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toEqual({ mediaItemId: "c" });
  });
});

describe("ExcludeReasonDialog", () => {
  it("asks for an optional reason and confirms with it, by button or Enter", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(createElement(ExcludeReasonDialog, { itemLabel: "The Show S01E01", onConfirm, onCancel }));
    expect(screen.getByText(/The Show S01E01/)).toBeTruthy();
    const input = screen.getByPlaceholderText("Reason (optional)");
    fireEvent.change(input, { target: { value: "Kids love it" } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude" }));
    expect(onConfirm).toHaveBeenCalledWith("Kids love it");

    // A new item starts with no reason.
    rerender(createElement(ExcludeReasonDialog, { itemLabel: "Other", onConfirm, onCancel }));
    const fresh = screen.getByPlaceholderText("Reason (optional)") as HTMLInputElement;
    expect(fresh.value).toBe("");
    fireEvent.keyDown(fresh, { key: "Enter" });
    expect(onConfirm).toHaveBeenLastCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("is closed with no item", () => {
    render(createElement(ExcludeReasonDialog, { itemLabel: null, onConfirm: () => {}, onCancel: () => {} }));
    expect(screen.queryByPlaceholderText("Reason (optional)")).toBeNull();
  });
});
