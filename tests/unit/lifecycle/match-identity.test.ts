import { describe, it, expect } from "vitest";
import { matchIdentityChange, type IdentityRow } from "@/lib/lifecycle/match-identity";

function row(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return { title: "The Matrix", parentTitle: null, year: 1999, externalIds: [], ...overrides };
}

describe("matchIdentityChange", () => {
  it("accepts an unchanged movie", () => {
    const snapshot = { title: "The Matrix", parentTitle: null, year: 1999, externalIds: [{ source: "TMDB", externalId: "603" }] };
    expect(matchIdentityChange(snapshot, row({ externalIds: [{ source: "TMDB", externalId: "603" }] }), "MOVIE")).toBeNull();
  });

  it("ignores the cosmetic differences title validation ignores", () => {
    expect(matchIdentityChange({ title: "The Matrix" }, row({ title: "Matrix, The" }), "MOVIE")).toBeNull();
    expect(matchIdentityChange({ title: "Fish & Chips" }, row({ title: "fish and chips" }), "MOVIE")).toBeNull();
  });

  it("refuses a movie a Fix Match turned into a different title", () => {
    expect(matchIdentityChange({ title: "The Matrix" }, row({ title: "Hackers" }), "MOVIE")).toMatch(/"The Matrix" is now "Hackers"/);
  });

  it("refuses a movie whose TMDB id changed under the same title (a remake)", () => {
    const snapshot = { title: "Dune", year: 2021, externalIds: [{ source: "TMDB", externalId: "438631" }] };
    const now = row({ title: "Dune", year: 2021, externalIds: [{ source: "TMDB", externalId: "841" }] });
    expect(matchIdentityChange(snapshot, now, "MOVIE")).toMatch(/TMDB id changed from 438631 to 841/);
  });

  it("refuses a movie whose year moved by more than one, even with no ids recorded", () => {
    expect(matchIdentityChange({ title: "Dune", year: 2021 }, row({ title: "Dune", year: 1984 }), "MOVIE")).toMatch(/year changed from 2021 to 1984/);
    // A one-year correction is the same film.
    expect(matchIdentityChange({ title: "Dune", year: 2021 }, row({ title: "Dune", year: 2020 }), "MOVIE")).toBeNull();
  });

  it("compares a grouped series match against the representative episode's show", () => {
    // Detection stores the group: title = the show, parentTitle cleared. The
    // RuleMatch points at one episode, whose own title is the episode's.
    const snapshot = { title: "Breaking Bad", parentTitle: null, externalIds: [{ source: "TVDB", externalId: "81189" }] };
    const episode = row({ title: "Pilot", parentTitle: "Breaking Bad", year: 2008, externalIds: [{ source: "TVDB", externalId: "81189" }] });
    expect(matchIdentityChange(snapshot, episode, "SERIES")).toBeNull();

    const refixed = { ...episode, parentTitle: "Better Call Saul" };
    expect(matchIdentityChange(snapshot, refixed, "SERIES")).toMatch(/"Breaking Bad" is now "Better Call Saul"/);

    const otherId = { ...episode, externalIds: [{ source: "TVDB", externalId: "273181" }] };
    expect(matchIdentityChange(snapshot, otherId, "SERIES")).toMatch(/TVDB id changed/);
  });

  it("does not compare years for series: an episode's air year is not the show's", () => {
    const snapshot = { title: "Doctor Who", year: 1963 };
    expect(matchIdentityChange(snapshot, row({ title: "Rose", parentTitle: "Doctor Who", year: 2005 }), "SERIES")).toBeNull();
  });

  it("compares both the artist and the track for a track matched on its own", () => {
    const snapshot = { title: "Paranoid Android", parentTitle: "Radiohead" };
    expect(matchIdentityChange(snapshot, row({ title: "Paranoid Android", parentTitle: "Radiohead" }), "MUSIC")).toBeNull();
    expect(matchIdentityChange(snapshot, row({ title: "Karma Police", parentTitle: "Radiohead" }), "MUSIC")).toMatch(/is now "Radiohead — Karma Police"/);
    expect(matchIdentityChange(snapshot, row({ title: "Paranoid Android", parentTitle: "Someone Else" }), "MUSIC")).not.toBeNull();
  });

  it("compares a grouped artist match against the track's artist, by MusicBrainz id too", () => {
    const snapshot = { title: "Radiohead", parentTitle: null, externalIds: [{ source: "MUSICBRAINZ", externalId: "a74b1b7f" }] };
    const track = row({ title: "Creep", parentTitle: "Radiohead", externalIds: [{ source: "MUSICBRAINZ", externalId: "a74b1b7f" }] });
    expect(matchIdentityChange(snapshot, track, "MUSIC")).toBeNull();
    expect(matchIdentityChange(snapshot, { ...track, externalIds: [{ source: "MUSICBRAINZ", externalId: "zzz" }] }, "MUSIC")).toMatch(/MUSICBRAINZ id changed/);
  });

  it("only compares the id the Arr family resolves by", () => {
    // A changed IMDB id on a movie is not what Radarr resolves by.
    const snapshot = { title: "The Matrix", externalIds: [{ source: "IMDB", externalId: "tt0133093" }] };
    expect(matchIdentityChange(snapshot, row({ externalIds: [{ source: "IMDB", externalId: "tt9999999" }] }), "MOVIE")).toBeNull();
  });

  it("does not treat a lost id as a change — the action cannot resolve anything without one", () => {
    const snapshot = { title: "The Matrix", externalIds: [{ source: "TMDB", externalId: "603" }] };
    expect(matchIdentityChange(snapshot, row({ externalIds: [] }), "MOVIE")).toBeNull();
  });

  it("cannot judge a match stored without a snapshot, and lets it through", () => {
    expect(matchIdentityChange(null, row(), "MOVIE")).toBeNull();
    expect(matchIdentityChange({}, row(), "MOVIE")).toBeNull();
    expect(matchIdentityChange("junk", row(), "MOVIE")).toBeNull();
    expect(matchIdentityChange({ title: 42, externalIds: "nope" }, row(), "MOVIE")).toBeNull();
  });
});
