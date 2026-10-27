// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";

// The hover card's own open delay and pointer handling are Radix's; the test
// opens it the way Radix would, through `onOpenChange`.
const hover = vi.hoisted(() => ({ open: null as null | ((open: boolean) => void) }));
vi.mock("@/components/ui/hover-card", () => ({
  HoverCard: ({ children, onOpenChange }: { children: ReactNode; onOpenChange: (open: boolean) => void }) => {
    hover.open = onOpenChange;
    return children;
  },
  HoverCardTrigger: ({ children }: { children: ReactNode }) => children,
  HoverCardContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/media-hover-popover", () => ({
  MediaHoverPopover: ({ data }: { data: { title: string } }) => createElement("p", null, data.title),
}));

import { LazyMediaHoverPopover } from "@/components/lazy-media-hover-popover";
import { detailPrefetch, mediaRecordUrl } from "@/lib/media/detail-prefetch";

const fetchMock = vi.fn();
const RECORD_URL = mediaRecordUrl("m1");

function popover() {
  // The trigger is passed as createElement's children argument.
  const props = {
    fetchUrl: RECORD_URL,
    extractData: (json: unknown) => ({ title: (json as { item: { title: string } }).item.title }),
    placeholder: { title: "placeholder" },
  } as ComponentProps<typeof LazyMediaHoverPopover>;
  return createElement(LazyMediaHoverPopover, props, createElement("span", null, "tile"));
}

async function openCard() {
  await act(async () => {
    hover.open!(true);
    await Promise.resolve();
  });
}

beforeEach(() => {
  detailPrefetch.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  detailPrefetch.clear();
});

describe("LazyMediaHoverPopover", () => {
  it("keeps the record it fetched for the click that follows the hover", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: { title: "Alien" } }) });
    render(popover());
    expect(screen.getByText("placeholder")).toBeTruthy();

    await openCard();
    expect(await screen.findByText("Alien")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The detail panel or page reads the record through the same store.
    const record = await detailPrefetch.fetch<{ item: { title: string } }>(RECORD_URL);
    expect(record.body?.item.title).toBe("Alien");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches once however often it opens", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ item: { title: "Alien" } }) });
    render(popover());
    await openCard();
    await screen.findByText("Alien");
    await openCard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the placeholder on a failed answer, and keeps no failure for the click", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
    render(popover());
    await openCard();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("placeholder")).toBeTruthy();
    // Not opened again after a failure.
    await openCard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The error was not stored: the click asks the server itself.
    expect(detailPrefetch.take(RECORD_URL)).toBeNull();
  });
});
