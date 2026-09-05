import { describe, it, expect } from "vitest";
import { normalizePlexMessage } from "@/lib/media-server/realtime/normalize-plex";

const ctx = { serverId: "s1" };

describe("normalizePlexMessage", () => {
  it("maps a playing notification to session-changed", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "playing",
          PlaySessionStateNotification: [{ sessionKey: "1", state: "playing", viewOffset: 1000 }],
        },
      },
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "session-changed", serverId: "s1", serverType: "PLEX" });
  });

  it("adds watch-changed when a play stops", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "playing",
          PlaySessionStateNotification: [{ sessionKey: "1", state: "stopped" }],
        },
      },
      ctx,
    );
    expect(events.map((e) => e.kind)).toEqual(["session-changed", "watch-changed"]);
  });

  it("emits session-changed for a bare playing container", () => {
    const events = normalizePlexMessage({ NotificationContainer: { type: "playing" } }, ctx);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("session-changed");
  });

  it("emits library-changed for any timeline entry, regardless of state", () => {
    const timeline = (entries: unknown[]) =>
      normalizePlexMessage({ NotificationContainer: { type: "timeline", TimelineEntry: entries } }, ctx);
    // Completed (5) — added/updated.
    expect(timeline([{ itemID: "5", state: 5 }])[0].kind).toBe("library-changed");
    // Intermediate states must NOT be dropped — a scan-detected deletion can
    // arrive with an unexpected state and must still trigger a reconciling sync.
    expect(timeline([{ itemID: "1", state: 0 }])[0].kind).toBe("library-changed");
    expect(timeline([{ itemID: "1", state: 3 }])[0].kind).toBe("library-changed");
    // Deleted (9) and stateless entries too, as long as they name an item.
    expect(timeline([{ itemID: "9", state: 9 }])[0].kind).toBe("library-changed");
    expect(timeline([{ itemID: "9" }])[0].kind).toBe("library-changed");
    // An entry naming no item is not actionable, and neither is an empty frame:
    // "something changed but we don't know what" used to mean "resync the whole
    // server", which is the escalation this normalizer exists to avoid.
    expect(timeline([{ state: 9 }])).toEqual([]);
    expect(timeline([])).toEqual([]);
  });

  it("drops entries belonging to no library section (sectionID -1)", () => {
    // Adding one movie emits a timeline entry for the movie (sectionID 1) plus
    // one per extra/trailer (sectionID -1, type 12). The extras belong to no
    // library section, so they can never map to a Library row; carrying them
    // made a single add unmappable and escalated it to a full server sync.
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { sectionID: "1", itemID: "169827", type: 1, state: 1, metadataState: "created" },
            { sectionID: "-1", itemID: "169828", type: 12, state: 0, metadataState: "created" },
            { sectionID: "-1", itemID: "169829", type: 12, state: 0, metadataState: "created" },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["169827"]);
    expect(events[0].detail?.droppedSectionless).toBe(2);
  });

  it("keeps a real deletion, which carries a valid sectionID", () => {
    // Verified against a live server: a deleted movie arrives sectionID=1
    // type=1 state=9, a deleted episode sectionID=2 type=4 state=9. Only extras
    // arrive sectionless, so the -1 filter never swallows a real removal.
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { sectionID: "1", itemID: "169827", type: 1, state: 9, metadataState: "deleted" },
            { sectionID: "2", itemID: "138453", type: 4, state: 9, metadataState: "deleted" },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["169827", "138453"]);
  });

  it("keeps an entry whose sectionID is absent rather than negative", () => {
    // Absent is a response gap, not evidence of no section — the sync resolves
    // it from the item's own metadata or its existing row.
    const events = normalizePlexMessage(
      { NotificationContainer: { type: "timeline", TimelineEntry: [{ itemID: "77", state: 5 }] } },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["77"]);
  });

  it("only an explicitly negative sectionID drops an entry", () => {
    const one = (entry: Record<string, unknown>) =>
      normalizePlexMessage(
        { NotificationContainer: { type: "timeline", TimelineEntry: [entry] } },
        ctx,
      );
    // Section 0 is a real section; "-0", a non-numeric value and an absent
    // field are all "no evidence", and evidence-free must fail safe by KEEPING
    // the entry — the sync can still place it from its own metadata.
    expect(one({ itemID: "1", sectionID: 0 })[0]?.detail?.changedIds).toEqual(["1"]);
    expect(one({ itemID: "1", sectionID: "0" })[0]?.detail?.changedIds).toEqual(["1"]);
    expect(one({ itemID: "1", sectionID: "-0" })[0]?.detail?.changedIds).toEqual(["1"]);
    expect(one({ itemID: "1", sectionID: "abc" })[0]?.detail?.changedIds).toEqual(["1"]);
    expect(one({ itemID: "1", sectionID: null })[0]?.detail?.changedIds).toEqual(["1"]);
    expect(one({ itemID: "1" })[0]?.detail?.changedIds).toEqual(["1"]);
    // Only a real negative drops, and a frame of only those emits nothing.
    expect(one({ itemID: "1", sectionID: -1 })).toEqual([]);
    expect(one({ itemID: "1", sectionID: "-1" })).toEqual([]);
  });

  it("a sectionless entry never suppresses a good one for the same item", () => {
    // The drop runs before the dedupe set is populated, so a -1 frame cannot
    // claim the id and hide a later valid entry for the same item.
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { itemID: "5", sectionID: "-1" },
            { itemID: "5", sectionID: "1" },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["5"]);
  });

  it("dedupes repeated frames for the same item", () => {
    // One added movie walked through create/analyze/load emitted seven frames
    // for the same ratingKey. That is one change, not seven.
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { sectionID: "1", itemID: "169827", state: 0 },
            { sectionID: "1", itemID: "169827", state: 1 },
            { sectionID: "1", itemID: "169827", state: 4 },
            { sectionID: "1", itemID: "169827", state: 5 },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["169827"]);
  });

  it("drops collection and playlist entries — containers are never library items", () => {
    // Plex emits a timeline entry for the collection itself on every
    // collection edit (librariarr's own collection sync included). Carrying it
    // forward only ever bought a metadata fetch that ended in "skip".
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { sectionID: "1", itemID: "900", type: 18, state: 5 },
            { sectionID: "1", itemID: "901", type: "18", state: 9, metadataState: "deleted" },
            { sectionID: "1", itemID: "902", type: 15, state: 5 },
            { sectionID: "1", itemID: "903", type: 16, state: 5 },
            { sectionID: "1", itemID: "10", type: 1, state: 5 },
            { sectionID: "2", itemID: "11", type: 4, state: 5 },
            // No type at all is a response gap, not evidence of a container.
            { sectionID: "1", itemID: "12", state: 5 },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["10", "11", "12"]);
    expect(events[0].detail?.droppedContainers).toBe(4);
  });

  it("a frame naming only containers emits nothing", () => {
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [{ sectionID: "1", itemID: "900", type: 18, state: 5 }],
        },
      },
      ctx,
    );
    expect(events).toEqual([]);
  });

  it("flags entries that look like deletions, without removing them from changedIds", () => {
    // Advisory: the sync still resolves every id against the server. The flag
    // exists so the manager never drops a deletion as the echo of librariarr's
    // own write, and it must survive an earlier non-deletion frame for the
    // same id in the same container.
    const events = normalizePlexMessage(
      {
        NotificationContainer: {
          type: "timeline",
          TimelineEntry: [
            { sectionID: "1", itemID: "1", type: 1, state: 5 },
            { sectionID: "1", itemID: "1", type: 1, state: 9, metadataState: "deleted" },
            { sectionID: "1", itemID: "2", type: 1, state: 5, metadataState: "Deleted" },
            { sectionID: "1", itemID: "3", type: 1, state: "9" },
            { sectionID: "1", itemID: "4", type: 1, state: 5 },
          ],
        },
      },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["1", "2", "3", "4"]);
    expect(events[0].detail?.deletedIds).toEqual(["1", "2", "3"]);
  });

  it("carries changed item ratingKeys (itemID) for incremental sync", () => {
    const events = normalizePlexMessage(
      { NotificationContainer: { type: "timeline", TimelineEntry: [{ itemID: 12, state: 5 }, { itemID: 34, state: 9 }] } },
      ctx,
    );
    expect(events[0].detail?.changedIds).toEqual(["12", "34"]);
  });

  it("ignores ended library.* activities — they name no items", () => {
    // `library.refresh.items` (Plex's periodic metadata refresh) ends with
    // Context null and zero timeline entries: nothing changed. It used to
    // produce an id-less library-changed, which the manager read as "resync
    // everything" — a full server sync per refresh cycle. Real changes arrive on
    // the timeline channel; the scheduled sync reconciles anything missed.
    for (const type of ["library.update.section", "library.refresh.items", "library.update.item.metadata"]) {
      expect(
        normalizePlexMessage(
          {
            NotificationContainer: {
              type: "activity",
              ActivityNotification: [{ event: "ended", Activity: { type } }],
            },
          },
          ctx,
        ),
      ).toEqual([]);
    }
  });

  it("ignores in-progress / non-library activities", () => {
    expect(
      normalizePlexMessage(
        {
          NotificationContainer: {
            type: "activity",
            ActivityNotification: [{ event: "started", Activity: { type: "library.update.section" } }],
          },
        },
        ctx,
      ),
    ).toEqual([]);
    expect(
      normalizePlexMessage(
        {
          NotificationContainer: {
            type: "activity",
            ActivityNotification: [{ event: "ended", Activity: { type: "provider.subscriptions.process" } }],
          },
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it("accepts a top-level container without the NotificationContainer wrapper", () => {
    const events = normalizePlexMessage(
      { type: "playing", PlaySessionStateNotification: [{ state: "playing" }] },
      ctx,
    );
    expect(events[0].kind).toBe("session-changed");
  });

  it("ignores unrelated types and malformed input", () => {
    expect(normalizePlexMessage({ NotificationContainer: { type: "status" } }, ctx)).toEqual([]);
    expect(normalizePlexMessage({ NotificationContainer: { type: "transcodeSession.update" } }, ctx)).toEqual([]);
    expect(normalizePlexMessage(null, ctx)).toEqual([]);
    expect(normalizePlexMessage("nope", ctx)).toEqual([]);
    expect(normalizePlexMessage({}, ctx)).toEqual([]);
  });
});
