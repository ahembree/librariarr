// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import {
  USER_PICKER_LIMIT,
  UserPicker,
  filterUserOptions,
  perUserOptions,
} from "@/components/builder/user-picker";

describe("filterUserOptions", () => {
  const users = ["bob", "Alice", "carol", "malice", "alicia"];

  it("lists everyone A–Z, case-insensitively, without a search", () => {
    expect(filterUserOptions(users, "")).toEqual({ shown: ["Alice", "alicia", "bob", "carol", "malice"], total: 5 });
  });

  it("matches anywhere in the name, names starting with the search first", () => {
    expect(filterUserOptions(users, " ALI ")).toEqual({ shown: ["Alice", "alicia", "malice"], total: 3 });
    expect(filterUserOptions(users, "zzz")).toEqual({ shown: [], total: 0 });
  });

  it("shows at most the limit, reporting every match", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `user${String(i).padStart(4, "0")}`);
    const all = filterUserOptions(many, "");
    expect(all.shown).toHaveLength(USER_PICKER_LIMIT);
    expect(all.total).toBe(5000);
    expect(all.shown[0]).toBe("user0000");
    expect(filterUserOptions(many, "user49")).toMatchObject({ total: 100 });
    expect(filterUserOptions(many, "user4999")).toEqual({ shown: ["user4999"], total: 1 });
  });
});

describe("perUserOptions", () => {
  it("drops blanks and duplicates", () => {
    expect(perUserOptions(["alice", "", "  ", "alice", "bob"], "")).toEqual(["alice", "bob"]);
    expect(perUserOptions(undefined, "")).toEqual([]);
  });

  it("keeps the rule's own user unless a listed name stands for it", () => {
    expect(perUserOptions(["Alice"], "alice")).toEqual(["Alice"]);
    expect(perUserOptions(["bob"], " gone ")).toEqual(["bob", "gone"]);
    expect(perUserOptions([], "gone")).toEqual(["gone"]);
  });
});

describe("UserPicker", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  function render(props: Parameters<typeof UserPicker>[0]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(UserPicker, props)));
    return container.querySelector("button[role=combobox]") as HTMLButtonElement;
  }

  it("shows the chosen user, or a prompt", () => {
    expect(render({ value: "alice", options: ["alice"], onChange: () => {} }).textContent).toContain("alice");
    act(() => root?.unmount());
    expect(render({ value: "", options: ["alice"], onChange: () => {} }).textContent).toContain("Select user...");
  });

  it("caps the rendered list and says how many matched", () => {
    const options = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const trigger = render({ value: "", options, onChange: vi.fn() });
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
    expect(document.querySelectorAll("[cmdk-item]")).toHaveLength(USER_PICKER_LIMIT);
    expect(document.body.textContent).toContain(`Showing ${USER_PICKER_LIMIT} of 250`);
  });
});
