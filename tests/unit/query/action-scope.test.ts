/**
 * The Query page's own actions under the group-scope gate
 * (`src/lib/query/action-scope.ts`): a query judges each episode or track on
 * its own, so an action on the whole Sonarr series or Lidarr artist may follow
 * only the criteria a rule set with the scope off and that action may.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import {
  queryActionEpisodeScope,
  queryActionGate,
  queryActionScopeError,
  queryActionScopeViolation,
} from "@/lib/query/action-scope";
import { groupScopeViolation } from "@/lib/conditions/group-scope";
import { MUSIC_ACTION_TYPES, SERIES_ACTION_TYPES } from "@/lib/lifecycle/action-types";

function groups(fields: string[]) {
  return [{
    id: "g", condition: "AND", groups: [],
    rules: fields.map((field, i) => ({ id: `r${i}`, field, operator: "equals", value: "x", condition: "AND" })),
  }];
}

const FOURK = groups(["resolution"]);

describe("queryActionScopeViolation", () => {
  it("judges the query as a rule set with the scope off and the action as the route runs it", () => {
    for (const { value } of SERIES_ACTION_TYPES) {
      for (const includeEpisodes of [false, true]) {
        const ours = queryActionScopeViolation("SERIES", FOURK, includeEpisodes, { actionType: value, addArrTags: value === "DO_NOTHING" ? ["t"] : [] });
        const ruleSet = groupScopeViolation("SERIES", false, FOURK, {
          actionEnabled: true, actionType: value, addArrTags: value === "DO_NOTHING" ? ["t"] : [],
          episodeScope: queryActionEpisodeScope("SERIES", includeEpisodes, value),
        });
        expect(ours, `${value} ${includeEpisodes}`).toEqual(ruleSet);
      }
    }
  });

  it("refuses every Series action that acts on the whole show, and Unmonitor and Search grouped by show", () => {
    const refused = (includeEpisodes: boolean) =>
      SERIES_ACTION_TYPES.map((a) => a.value).filter((actionType) => queryActionScopeViolation("SERIES", FOURK, includeEpisodes, { actionType }));
    expect(refused(true)).toEqual([
      "DELETE_SONARR", "UNMONITOR_DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_SONARR", "CHANGE_QUALITY_PROFILE_SONARR",
    ]);
    expect(refused(false)).toEqual([
      "DELETE_SONARR", "UNMONITOR_DELETE_FILES_SONARR", "MONITOR_DELETE_FILES_SONARR", "UNMONITOR_SONARR",
      "CHANGE_QUALITY_PROFILE_SONARR", "SEARCH_SONARR",
    ]);
  });

  it("refuses every Lidarr action but the file delete and Do Nothing, and those with search after or tags", () => {
    const mp3 = groups(["audioCodec"]);
    expect(MUSIC_ACTION_TYPES.map((a) => a.value).filter((actionType) => !queryActionScopeViolation("MUSIC", mp3, false, { actionType })))
      .toEqual(["DO_NOTHING", "DELETE_FILES_LIDARR"]);
    expect(queryActionScopeViolation("MUSIC", mp3, false, { actionType: "DELETE_FILES_LIDARR", searchAfterAction: true })?.wholeRecordAction)
      .toBe("Delete Files Only with Search after");
    expect(queryActionScopeViolation("MUSIC", mp3, false, { actionType: "DO_NOTHING", removeArrTags: ["keep"] })?.wholeRecordAction)
      .toBe("Arr tags");
  });

  it("allows a whole-record action on what every member answers alike, and any action on a movie", () => {
    expect(queryActionScopeViolation("SERIES", groups(["parentTitle", "availableEpisodeCount", "arrEnded", "seerrRequested"]), false, { actionType: "DELETE_SONARR" })).toBeNull();
    expect(queryActionScopeViolation("MOVIE", FOURK, false, { actionType: "DELETE_RADARR" })).toBeNull();
    // A Sonarr file delete searches the deleted episodes by id: it stays per episode.
    expect(queryActionScopeViolation("SERIES", FOURK, false, { actionType: "DELETE_FILES_SONARR", searchAfterAction: true })).toBeNull();
  });
});

describe("queryActionEpisodeScope", () => {
  it("runs Sonarr's Unmonitor and Search on the selected episodes in episode view only", () => {
    expect(queryActionEpisodeScope("SERIES", true, "UNMONITOR_SONARR")).toBe(true);
    expect(queryActionEpisodeScope("SERIES", false, "UNMONITOR_SONARR")).toBe(false);
    expect(queryActionEpisodeScope("SERIES", true, "DELETE_SONARR")).toBe(false);
    expect(queryActionEpisodeScope("MUSIC", true, "UNMONITOR_LIDARR")).toBe(false);
  });
});

describe("queryActionScopeError", () => {
  it("names the action, the criteria and the actions that act on the matched members", () => {
    expect(queryActionScopeError(queryActionScopeViolation("SERIES", groups(["resolution", "playCount"]), false, { actionType: "DELETE_SONARR" })!)).toBe(
      `"Delete from Sonarr" acts on the whole show, so it can't follow query criteria that describe one episode or file: ` +
        `Resolution, Play Count — one matching episode would decide for the whole show. Remove them from the query, or pick ` +
        `an action that acts only on the matched episodes (Delete Files Only, or Unmonitor Only or Search for New Copy with ` +
        `"Include individual episodes" on — without tags).`,
    );
    expect(queryActionScopeError(queryActionScopeViolation("MUSIC", groups(["genre"]), false, { actionType: "DELETE_LIDARR" })!)).toBe(
      `"Delete from Lidarr" acts on the whole artist, so it can't follow query criteria that describe one track or file: ` +
        `Genre — one matching track would decide for the whole artist. Remove them from the query, or pick an action that ` +
        `acts only on the matched tracks (Delete Files Only, without Search after or tags).`,
    );
  });
});

describe("the public API", () => {
  it("has no route that reaches the Query page's actions", () => {
    // `/api/v1` wraps internal handlers (`withApiKey`); none runs query actions,
    // so the route's 400 is the only path to guard.
    const files = readdirSync(path.join(process.cwd(), "src/app/api/v1"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), "src/app/api/v1", file), "utf8");
      expect(source, file).not.toMatch(/api\/query\/actions/);
    }
  });
});

describe("queryActionGate", () => {
  it("gives each action option, its tags and its search after the reason they are off", () => {
    const deleteSeries = queryActionGate("SERIES", FOURK, false, "DELETE_SONARR");
    expect(deleteSeries.action).toMatch(/^"Delete from Sonarr" acts on the whole show/);
    expect(deleteSeries.tags).toBe(deleteSeries.action);

    const files = queryActionGate("SERIES", FOURK, false, "DELETE_FILES_SONARR");
    expect(files.action).toBeNull();
    expect(files.tags).toMatch(/^"Arr tags" acts on the whole show/);
    expect(files.searchAfter).toBeNull();

    const lidarrFiles = queryActionGate("MUSIC", groups(["audioCodec"]), false, "DELETE_FILES_LIDARR");
    expect(lidarrFiles.action).toBeNull();
    expect(lidarrFiles.searchAfter).toMatch(/^"Delete Files Only with Search after" acts on the whole artist/);

    // "Do Nothing (tags only)" always changes tags.
    expect(queryActionGate("SERIES", FOURK, false, "DO_NOTHING").action).toMatch(/^"Arr tags" acts on the whole show/);
  });

  it("offers everything on criteria every member answers alike", () => {
    for (const { value } of SERIES_ACTION_TYPES) {
      expect(queryActionGate("SERIES", groups(["parentTitle"]), false, value)).toEqual({ action: null, tags: null, searchAfter: null });
    }
  });
});
