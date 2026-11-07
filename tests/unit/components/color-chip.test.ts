// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, createRef } from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { ColorChip } from "@/components/color-chip";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ColorChip", () => {
  it("renders a span without onClick and a button with it", () => {
    const el = render(createElement("div", null,
      createElement(ColorChip, null, "plain"),
      createElement(ColorChip, { onClick: () => {} }, "clickable"),
    ));
    expect(el.querySelector("span")?.textContent).toBe("plain");
    expect(el.querySelector("button")?.getAttribute("type")).toBe("button");
  });

  // Radix asChild triggers (TooltipTrigger, PopoverTrigger) hand the child their
  // ref, data attributes and pointer/focus handlers as props; a chip that drops
  // them never opens its tooltip.
  it("passes the ref, data attributes and handlers to the element", () => {
    const ref = createRef<HTMLSpanElement>();
    let entered = false;
    const el = render(createElement(ColorChip, {
      ref,
      "data-state": "closed",
      onPointerEnter: () => { entered = true; },
    } as React.ComponentProps<typeof ColorChip>, "chip"));
    const span = el.querySelector("span")!;
    expect(ref.current).toBe(span);
    expect(span.getAttribute("data-state")).toBe("closed");
    act(() => { span.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })); });
    expect(entered).toBe(true);
  });
});
