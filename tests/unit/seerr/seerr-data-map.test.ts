import { describe, it, expect } from "vitest";
import { SeerrDataMapBuilder, seerrRequesterName } from "@/lib/seerr/seerr-data-map";
import type { SeerrRequest } from "@/lib/seerr/seerr-client";

function r(p: {
  tmdbId?: number | null;
  tvdbId?: number | null;
  status?: number;
  createdAt?: string;
  updatedAt?: string;
  by?: string;
}): SeerrRequest {
  return {
    id: 1,
    type: "movie",
    status: p.status ?? 1,
    media: { tmdbId: p.tmdbId ?? null, tvdbId: p.tvdbId ?? null },
    requestedBy: { plexUsername: p.by ?? "u" },
    createdAt: p.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: p.updatedAt ?? "2024-01-02T00:00:00.000Z",
  } as unknown as SeerrRequest;
}

describe("SeerrDataMapBuilder", () => {
  it("records approval for APPROVED, FAILED and COMPLETED but not PENDING/DECLINED", () => {
    const b = new SeerrDataMapBuilder("MOVIE");
    [1, 2, 3, 4, 5].forEach((status) => b.add(r({ tmdbId: status, status })));
    const map = b.build();
    // updatedAt is the only approval (or decline) timestamp Seerr exposes.
    const updatedAt = "2024-01-02T00:00:00.000Z";
    expect(map["TMDB:1"]).toMatchObject({ approvalDate: null, declineDate: null });
    expect(map["TMDB:2"]).toMatchObject({ approvalDate: updatedAt, declineDate: null });
    expect(map["TMDB:3"]).toMatchObject({ approvalDate: null, declineDate: updatedAt });
    expect(map["TMDB:4"]).toMatchObject({ approvalDate: updatedAt, declineDate: null });
    expect(map["TMDB:5"]).toMatchObject({ approvalDate: updatedAt, declineDate: null });
  });

  it("keeps the most recent request, approval and decline dates", () => {
    const b = new SeerrDataMapBuilder("MOVIE");
    b.add(r({ tmdbId: 9, status: 5, createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2021-01-05T00:00:00.000Z" }));
    b.add(r({ tmdbId: 9, status: 5, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" }));
    b.add(r({ tmdbId: 9, status: 2, createdAt: "2023-01-01T00:00:00.000Z", updatedAt: "2023-01-02T00:00:00.000Z" }));
    b.add(r({ tmdbId: 9, status: 3, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2022-01-03T00:00:00.000Z" }));
    const m = b.build()["TMDB:9"];
    expect(m).toEqual({
      requested: true,
      requestCount: 4,
      requestedBy: ["u"],
      requestDate: "2026-09-01T00:00:00.000Z",
      approvalDate: "2026-09-02T00:00:00.000Z",
      declineDate: "2022-01-03T00:00:00.000Z",
    });
  });

  it("ignores tvdbId for movies and keys TV by TMDB with a TVDB alias", () => {
    const movies = new SeerrDataMapBuilder("MOVIE");
    movies.add(r({ tmdbId: 1, tvdbId: 2 }));
    expect(Object.keys(movies.build())).toEqual(["TMDB:1"]);

    const tv = new SeerrDataMapBuilder("SERIES");
    tv.add(r({ tmdbId: 1, tvdbId: 2 }));
    const map = tv.build();
    expect(map["TVDB:2"]).toBe(map["TMDB:1"]);
  });

  it("keys a TV request with no tmdbId by its tvdbId and merges it into the alias", () => {
    const b = new SeerrDataMapBuilder("SERIES");
    b.add(r({ tmdbId: null, tvdbId: 50, by: "a" }));
    b.add(r({ tmdbId: 7, tvdbId: 50, by: "b" }));
    const map = b.build();
    expect(map["TVDB:50"].requestCount).toBe(2);
    expect(map["TVDB:50"].requestedBy.sort()).toEqual(["a", "b"]);
    expect(map["TMDB:7"].requestCount).toBe(1);
  });

  it("skips a request with no usable id", () => {
    const b = new SeerrDataMapBuilder("MOVIE");
    b.add(r({ tmdbId: null }));
    expect(b.build()).toEqual({});
  });

  it("absorbs another builder exactly as if its requests had been added after", () => {
    // Deterministic pseudo-random requests over a few ids and dates, some with
    // an unparseable date, split between two "instances".
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const dates = ["2021-01-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z", "garbage", "2023-03-03T00:00:00.000Z"];
    const make = () =>
      r({
        tmdbId: rand(3) === 0 ? null : rand(4),
        tvdbId: rand(2) === 0 ? null : 50 + rand(3),
        status: 1 + rand(5),
        createdAt: dates[rand(4)],
        updatedAt: dates[rand(4)],
        by: ["a", "b", "c"][rand(3)],
      });
    for (let trial = 0; trial < 25; trial++) {
      const first = Array.from({ length: 1 + rand(8) }, make);
      const second = Array.from({ length: 1 + rand(8) }, make);

      const sequential = new SeerrDataMapBuilder("SERIES");
      for (const req of [...first, ...second]) sequential.add(req);

      const one = new SeerrDataMapBuilder("SERIES");
      const two = new SeerrDataMapBuilder("SERIES");
      first.forEach((req) => one.add(req));
      second.forEach((req) => two.add(req));
      const folded = new SeerrDataMapBuilder("SERIES");
      folded.absorb(one);
      folded.absorb(two);

      expect(folded.build()).toEqual(sequential.build());
      // Absorbing copies: the source builders are left as they were.
      const oneAlone = new SeerrDataMapBuilder("SERIES");
      first.forEach((req) => oneAlone.add(req));
      expect(one.build()).toEqual(oneAlone.build());
    }
  });
});

describe("seerrRequesterName", () => {
  it("prefers plexUsername, then username, then email", () => {
    const base = r({});
    expect(seerrRequesterName({ ...base, requestedBy: { plexUsername: "p", username: "u", email: "e" } } as SeerrRequest)).toBe("p");
    expect(seerrRequesterName({ ...base, requestedBy: { plexUsername: null, username: "u", email: "e" } } as SeerrRequest)).toBe("u");
    expect(seerrRequesterName({ ...base, requestedBy: { username: null, email: "e" } } as SeerrRequest)).toBe("e");
    expect(seerrRequesterName({ ...base, requestedBy: {} } as SeerrRequest)).toBe("Unknown");
  });
});
