// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import {
  CollectionOrderPreviewDialog,
  formatCollectionSortValue,
  positionChange,
} from "@/components/collection-order-preview-dialog";
import { EMPTY_PROGRESS } from "@/components/query-progress";
import type { CollectionOrderPreview } from "@/lib/lifecycle/collection-order-preview";

describe("formatCollectionSortValue", () => {
  it("formats each kind of value", () => {
    expect(formatCollectionSortValue("text", "Office, The")).toBe("Office, The");
    expect(formatCollectionSortValue("bytes", 1024 ** 3)).toBe("1.0 GB");
    expect(formatCollectionSortValue("duration", 90 * 60 * 1000)).toBe("1h 30m");
    expect(formatCollectionSortValue("count", 1234)).toBe("1,234");
    expect(formatCollectionSortValue("rating", 7.25)).toBe("7.3");
    expect(formatCollectionSortValue("dateOnly", Date.UTC(2010, 6, 16))).toBe("July 16, 2010");
    expect(formatCollectionSortValue("date", Date.UTC(2024, 0, 15, 12))).toMatch(/January 1[45], 2024/);
  });

  it("says when an item has no value", () => {
    expect(formatCollectionSortValue("bytes", null)).toBe("No value");
    expect(formatCollectionSortValue("text", "")).toBe("No value");
  });
});

describe("positionChange", () => {
  const item = (position: number, previousPosition: number | null) =>
    ({ ratingKey: "k", title: "T", value: null, position, previousPosition });

  it("reads added, up, down and unchanged", () => {
    expect(positionChange(item(0, null), true)).toEqual({ kind: "added" });
    expect(positionChange(item(0, 3), true)).toEqual({ kind: "up", by: 3 });
    expect(positionChange(item(4, 1), true)).toEqual({ kind: "down", by: 3 });
    expect(positionChange(item(2, 2), true)).toBeNull();
  });

  it("claims nothing when Plex's current order is unknown", () => {
    expect(positionChange(item(0, null), false)).toBeNull();
  });
});

describe("CollectionOrderPreviewDialog", () => {
  const result: CollectionOrderPreview = {
    field: "FILE_SIZE",
    direction: "desc",
    libraries: [{
      libraryId: "lib1", libraryTitle: "Movies", serverName: "Home", status: "ok", message: null,
      collectionExists: true, plexSorted: false, moves: 2,
      items: [
        { ratingKey: "a", title: "Alpha", value: 5 * 1024 ** 3, position: 0, previousPosition: null },
        { ratingKey: "d", title: "Delta", value: 2 * 1024 ** 3, position: 1, previousPosition: 1 },
        { ratingKey: "b", title: "Bravo", value: 1024 ** 3, position: 2, previousPosition: 0 },
      ],
      removed: [{ ratingKey: "gone", title: "Gone Movie", previousPosition: 2 }],
    }],
  };

  it("lists the new order with values, changes and the items leaving", () => {
    const { getByRole } = render(createElement(CollectionOrderPreviewDialog, {
      open: true, onOpenChange: () => {}, collectionName: "Big",
      loading: false, progress: EMPTY_PROGRESS, error: null, result,
    }));
    const dialog = getByRole("dialog");
    expect(dialog.textContent).toContain(`"Big" by file size, descending`);
    expect(dialog.textContent).toContain("3 items · 1 new · 1 removed · 1 change position · 2 moves on the next sync");
    const rows = [...dialog.querySelectorAll("ol li")].map((li) => li.textContent);
    expect(rows[0]).toContain("Alpha");
    expect(rows[0]).toContain("5.0 GB");
    expect(rows[0]).toContain("New");
    expect(rows[2]).toContain("Bravo");
    expect(dialog.querySelector("ol li:nth-child(3) [title='Was #1, now #3']")).not.toBeNull();
    expect(dialog.textContent).toContain("Gone Movie");
  });

  it("shows the error a refused preview gives", () => {
    const { getByRole } = render(createElement(CollectionOrderPreviewDialog, {
      open: true, onOpenChange: () => {}, collectionName: "Big",
      loading: false, progress: EMPTY_PROGRESS, error: "No active rules to evaluate", result: null,
    }));
    expect(getByRole("alert").textContent).toContain("No active rules to evaluate");
  });
});
