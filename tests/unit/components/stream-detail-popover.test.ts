// @vitest-environment happy-dom
/**
 * The play row's Tracearr stream detail (`StreamDetailPopover` in
 * `src/components/play-history.tsx`). It must open on a tap (a HoverCard never
 * did, so phones could not read it), still open on a mouse hover, stay open
 * when a hover-opened popover is clicked, and close on Esc without the Esc
 * reaching the side panel's document listener (which closes the whole panel).
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StreamDetailPopover, type DetailSection } from "@/components/play-history";

const SECTIONS: DetailSection[] = [
  { title: "Video", rows: [{ label: "Codec", value: "HEVC" }] },
];

function trigger() {
  return screen.getByRole("button", { name: "Stream details" });
}

function isOpen() {
  return screen.queryByText("HEVC") !== null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StreamDetailPopover", () => {
  it("opens and closes on a tap", () => {
    render(createElement(StreamDetailPopover, { sections: SECTIONS }));
    expect(isOpen()).toBe(false);
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
    fireEvent.click(trigger());
    expect(isOpen()).toBe(false);
  });

  it("opens on a mouse hover and closes when the mouse leaves", () => {
    vi.useFakeTimers();
    render(createElement(StreamDetailPopover, { sections: SECTIONS }));
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(isOpen()).toBe(true);
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(isOpen()).toBe(false);
  });

  it("ignores a touch pointer's enter", () => {
    vi.useFakeTimers();
    render(createElement(StreamDetailPopover, { sections: SECTIONS }));
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(200));
    expect(isOpen()).toBe(false);
  });

  it("pins a hover-opened popover on click instead of closing it", () => {
    vi.useFakeTimers();
    render(createElement(StreamDetailPopover, { sections: SECTIONS }));
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.click(trigger());
    expect(isOpen()).toBe(true);
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(isOpen()).toBe(true);
    fireEvent.click(trigger());
    expect(isOpen()).toBe(false);
  });

  it("keeps a click-opened popover open when the mouse leaves", () => {
    vi.useFakeTimers();
    render(createElement(StreamDetailPopover, { sections: SECTIONS }));
    fireEvent.click(trigger());
    fireEvent.pointerEnter(screen.getByText("HEVC"), { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(isOpen()).toBe(true);
  });

  it("closes on Esc without the Esc reaching a document listener", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      render(createElement(StreamDetailPopover, { sections: SECTIONS }));
      fireEvent.click(trigger());
      expect(isOpen()).toBe(true);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(isOpen()).toBe(false);
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });
});
