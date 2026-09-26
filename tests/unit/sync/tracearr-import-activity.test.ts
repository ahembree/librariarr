import { describe, it, expect, beforeEach } from "vitest";
import {
  beginTracearrImport,
  endTracearrImport,
  getTracearrImportActivity,
  recordTracearrImportPage,
} from "@/lib/sync/tracearr-import-activity";

describe("tracearr import activity", () => {
  beforeEach(() => {
    endTracearrImport("srv-1");
    endTracearrImport("srv-2");
  });

  it("reports nothing for a server with no import running", () => {
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("reports a started import before its first page, with no pass yet", () => {
    beginTracearrImport("srv-1", "user-1");
    expect(getTracearrImportActivity("srv-1")).toMatchObject({
      pass: null,
      pages: 0,
      imported: 0,
      oldestReached: null,
    });
  });

  it("carries the latest committed page's figures", () => {
    beginTracearrImport("srv-1", "user-1");
    recordTracearrImportPage("srv-1", {
      pass: "backfill",
      pages: 3,
      imported: 250,
      oldestReached: new Date("2022-03-04T00:00:00.000Z"),
    });
    expect(getTracearrImportActivity("srv-1")).toMatchObject({
      pass: "backfill",
      pages: 3,
      imported: 250,
      oldestReached: "2022-03-04T00:00:00.000Z",
    });
  });

  it("never exposes the owner — that is for the cleanup path only", () => {
    beginTracearrImport("srv-1", "user-1");
    expect(getTracearrImportActivity("srv-1")).not.toHaveProperty("userId");
  });

  it("ignores a page for a server whose import was not begun", () => {
    // A page reported after the entry was cleared must not resurrect it.
    recordTracearrImportPage("srv-1", { pass: "forward", pages: 1, imported: 1, oldestReached: null });
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("ends with the owner returned once, then nothing", () => {
    beginTracearrImport("srv-1", "user-1");
    expect(endTracearrImport("srv-1")).toEqual({ userId: "user-1" });
    expect(endTracearrImport("srv-1")).toBeUndefined();
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("keeps servers independent", () => {
    beginTracearrImport("srv-1", "user-1");
    beginTracearrImport("srv-2", "user-1");
    endTracearrImport("srv-1");
    expect(getTracearrImportActivity("srv-2")).not.toBeNull();
  });
});
