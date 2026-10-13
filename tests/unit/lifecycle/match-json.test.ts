import { describe, it, expect } from "vitest";
import { matchItemJson } from "@/lib/lifecycle/match-json";

const at = new Date("2026-03-04T05:06:07.000Z");
/** What the route used to send: the parsed snapshot spread, plus the stamp. */
const spread = (itemData: unknown) => ({ ...(itemData as Record<string, unknown>), detectedAt: at.toISOString() });

describe("matchItemJson", () => {
  it("parses to the spread of the snapshot plus detectedAt, in the same key order", () => {
    // jsonb's own text form: spaces after separators, keys in its order.
    const stored = `{"id": "m1", "year": 1954, "title": "Rear Window", "servers": [{"serverId": "s1"}], "fileSize": "123", "parentTitle": null}`;
    const out = JSON.parse(matchItemJson(stored, at));
    const expected = spread(JSON.parse(stored));
    expect(out).toEqual(expected);
    expect(Object.keys(out)).toEqual(Object.keys(expected));
  });

  it("stamps an empty snapshot", () => {
    expect(JSON.parse(matchItemJson("{}", at))).toEqual({ detectedAt: at.toISOString() });
    expect(JSON.parse(matchItemJson(" { } ", at))).toEqual({ detectedAt: at.toISOString() });
  });

  it("keeps a snapshot's own detectedAt key in place and gives it the match's value", () => {
    const stored = `{"detectedAt": "2020-01-01T00:00:00.000Z", "id": "m1"}`;
    const out = JSON.parse(matchItemJson(stored, at));
    const expected = spread(JSON.parse(stored));
    expect(out).toEqual(expected);
    expect(Object.keys(out)).toEqual(Object.keys(expected));
  });

  it("treats a snapshot that is not an object as the spread did", () => {
    expect(JSON.parse(matchItemJson(null, at))).toEqual(spread(null));
    expect(JSON.parse(matchItemJson("null", at))).toEqual(spread(null));
    expect(JSON.parse(matchItemJson(`["a"]`, at))).toEqual(spread(["a"]));
  });

  it("leaves braces and separators inside strings alone", () => {
    const stored = `{"title": "a}, {\\"b\\": 1", "summary": "x: y, z"}`;
    expect(JSON.parse(matchItemJson(stored, at))).toEqual(spread(JSON.parse(stored)));
  });
});
