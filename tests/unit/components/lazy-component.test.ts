// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { lazyComponent } from "@/components/lazy-component";

function Real({ label }: { label: string }) {
  return createElement("span", null, label);
}

describe("lazyComponent", () => {
  it("shows the fallback until the code has loaded", async () => {
    const Lazy = lazyComponent(async () => Real, () => createElement("i", null, "loading"));
    const { container } = render(createElement(Lazy, { label: "ready" }));
    expect(container.textContent).toBe("loading");
    await act(async () => {});
    expect(container.textContent).toBe("ready");
  });

  it("renders a preloaded component on its first render", async () => {
    // A dialog opened by a tap must mount in the tap's own update, or a phone
    // does not bring its keyboard up for the dialog's input.
    const Lazy = lazyComponent(async () => Real, () => createElement("i", null, "loading"));
    await Lazy.preload();
    const { container } = render(createElement(Lazy, { label: "ready" }));
    expect(container.textContent).toBe("ready");
  });
});
