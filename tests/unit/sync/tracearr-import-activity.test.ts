import { describe, it, expect, beforeEach } from "vitest";
import {
  beginTracearrImport,
  endTracearrImport,
  getTracearrImportActivity,
  getTracearrBackfillReach,
  recordTracearrImportPage,
  supersedeTracearrImports,
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

  it("reports the backfill pass's reach separately, never the forward pass's", () => {
    // The status route reads this as live archive progress between the slice
    // writes of `tracearrBackfillCursorAt`. A forward page's oldest play is
    // near "now", so letting it in would read as the walk barely started.
    const run = begin("srv-1");
    recordTracearrImportPage(run, {
      pass: "forward",
      pages: 1,
      imported: 5,
      oldestReached: new Date("2026-10-06T00:00:00.000Z"),
    });
    expect(getTracearrImportActivity("srv-1")?.backfillReached).toBeNull();

    recordTracearrImportPage(run, {
      pass: "backfill",
      pages: 2,
      imported: 105,
      oldestReached: new Date("2021-01-01T00:00:00.000Z"),
    });
    expect(getTracearrImportActivity("srv-1")?.backfillReached).toBe(
      "2021-01-01T00:00:00.000Z",
    );

    // A backfill page with no parseable instant keeps the last known reach.
    recordTracearrImportPage(run, { pass: "backfill", pages: 3, imported: 105, oldestReached: null });
    expect(getTracearrImportActivity("srv-1")?.backfillReached).toBe(
      "2021-01-01T00:00:00.000Z",
    );
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

    it("reports the running backfill's reach even while a newer forward run is shown", () => {
      // The status route reads `backfillReached` as live archive progress. With
      // a Refresh overlapping a slice, the newest run is the forward one, whose
      // reach is always null — the bar froze for as long as the two overlapped.
      const backfill = begin("srv-1");
      const refresh = begin("srv-1");
      recordTracearrImportPage(backfill, {
        pass: "backfill",
        pages: 40,
        imported: 3900,
        oldestReached: new Date("2020-05-01T00:00:00.000Z"),
      });
      recordTracearrImportPage(refresh, {
        pass: "forward",
        pages: 1,
        imported: 12,
        oldestReached: new Date("2026-10-06T00:00:00.000Z"),
      });
      expect(getTracearrImportActivity("srv-1")).toMatchObject({
        pass: "forward",
        pages: 1,
        backfillReached: "2020-05-01T00:00:00.000Z",
      });
      expect(getTracearrBackfillReach("srv-1")).toBe("2020-05-01T00:00:00.000Z");
    });

    it("does not let the older run's end remove the newer one", () => {
      const backfill = begin("srv-1");
      begin("srv-1");
      expect(endTracearrImport(backfill)).toEqual({ userId: "user-1" });
      expect(getTracearrImportActivity("srv-1")).not.toBeNull();
    });
  });

  describe("supersedeTracearrImports", () => {
    // Called when the walk is restarted (purge, restore) or re-pointed (mapping
    // change) while a slice is running. The slice keeps walking from its old,
    // deep position, and the status route takes the OLDER of the live reach and
    // the stored cursor — so without this a restarted walk read as nearly done.
    it("drops a running slice's reach and keeps it out for the rest of the run", () => {
      const slice = begin("srv-1");
      recordTracearrImportPage(slice, {
        pass: "backfill",
        pages: 300,
        imported: 29000,
        oldestReached: new Date("2019-01-01T00:00:00.000Z"),
      });

      supersedeTracearrImports("srv-1");

      expect(getTracearrBackfillReach("srv-1")).toBeNull();
      recordTracearrImportPage(slice, {
        pass: "backfill",
        pages: 301,
        imported: 29100,
        oldestReached: new Date("2018-12-01T00:00:00.000Z"),
      });
      expect(getTracearrImportActivity("srv-1")).toMatchObject({
        // The run is still live and still counting — only its reach is void.
        pages: 301,
        imported: 29100,
        backfillReached: null,
      });
    });

    it("leaves a run begun after the restart reporting normally", () => {
      begin("srv-1");
      supersedeTracearrImports("srv-1");
      const restarted = begin("srv-1");
      recordTracearrImportPage(restarted, {
        pass: "backfill",
        pages: 1,
        imported: 100,
        oldestReached: new Date("2026-10-01T00:00:00.000Z"),
      });
      expect(getTracearrBackfillReach("srv-1")).toBe("2026-10-01T00:00:00.000Z");
    });

    it("touches only the server it names", () => {
      const other = begin("srv-2");
      recordTracearrImportPage(other, {
        pass: "backfill",
        pages: 1,
        imported: 1,
        oldestReached: new Date("2021-01-01T00:00:00.000Z"),
      });
      supersedeTracearrImports("srv-1");
      expect(getTracearrBackfillReach("srv-2")).toBe("2021-01-01T00:00:00.000Z");
    });
  });
});
