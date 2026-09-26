import { describe, it, expect, beforeEach } from "vitest";
import {
  beginTracearrImport,
  endTracearrImport,
  getTracearrImportActivity,
  recordTracearrImportPage,
  type TracearrImportHandle,
} from "@/lib/sync/tracearr-import-activity";

describe("tracearr import activity", () => {
  const live: TracearrImportHandle[] = [];
  const begin = (serverId: string) => {
    const handle = beginTracearrImport(serverId, "user-1");
    live.push(handle);
    return handle;
  };

  beforeEach(() => {
    for (const handle of live.splice(0)) endTracearrImport(handle);
  });

  it("reports nothing for a server with no import running", () => {
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("reports a started import before its first page, with no pass yet", () => {
    begin("srv-1");
    expect(getTracearrImportActivity("srv-1")).toMatchObject({
      pass: null,
      pages: 0,
      imported: 0,
      oldestReached: null,
    });
  });

  it("carries the latest committed page's figures", () => {
    const run = begin("srv-1");
    recordTracearrImportPage(run, {
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
    begin("srv-1");
    expect(getTracearrImportActivity("srv-1")).not.toHaveProperty("userId");
  });

  it("ignores a page reported after the run ended", () => {
    const run = begin("srv-1");
    endTracearrImport(run);
    recordTracearrImportPage(run, { pass: "forward", pages: 1, imported: 1, oldestReached: null });
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("ends with the owner returned once, then nothing", () => {
    const run = begin("srv-1");
    expect(endTracearrImport(run)).toEqual({ userId: "user-1" });
    expect(endTracearrImport(run)).toBeUndefined();
    expect(getTracearrImportActivity("srv-1")).toBeNull();
  });

  it("keeps servers independent", () => {
    const first = begin("srv-1");
    begin("srv-2");
    endTracearrImport(first);
    expect(getTracearrImportActivity("srv-2")).not.toBeNull();
  });

  describe("two runs of the same server at once", () => {
    // A History-page Refresh runs in a request, outside the MAIN_QUEUE a
    // backfill slice runs on, so one server can have two imports in flight.

    it("keeps each run's figures to itself and shows the newest", () => {
      const backfill = begin("srv-1");
      const refresh = begin("srv-1");
      recordTracearrImportPage(backfill, { pass: "backfill", pages: 40, imported: 3900, oldestReached: null });
      recordTracearrImportPage(refresh, { pass: "forward", pages: 1, imported: 12, oldestReached: null });
      expect(getTracearrImportActivity("srv-1")).toMatchObject({ pass: "forward", pages: 1, imported: 12 });
    });

    it("still reports the other run when one finishes first", () => {
      const backfill = begin("srv-1");
      const refresh = begin("srv-1");
      recordTracearrImportPage(backfill, { pass: "backfill", pages: 40, imported: 3900, oldestReached: null });
      endTracearrImport(refresh);
      expect(getTracearrImportActivity("srv-1")).toMatchObject({ pass: "backfill", pages: 40, imported: 3900 });
    });

    it("does not let the older run's end remove the newer one", () => {
      const backfill = begin("srv-1");
      begin("srv-1");
      expect(endTracearrImport(backfill)).toEqual({ userId: "user-1" });
      expect(getTracearrImportActivity("srv-1")).not.toBeNull();
    });
  });
});
