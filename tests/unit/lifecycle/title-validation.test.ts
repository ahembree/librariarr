import { describe, it, expect } from "vitest";
import { normalizeTitle, validateArrItem } from "@/lib/lifecycle/actions";

describe("normalizeTitle", () => {
  it("lowercases", () => {
    expect(normalizeTitle("The Matrix")).toBe("matrix");
  });

  it("strips leading articles", () => {
    expect(normalizeTitle("The Matrix")).toBe("matrix");
    expect(normalizeTitle("A Quiet Place")).toBe("quiet place");
    expect(normalizeTitle("An American Werewolf")).toBe("american werewolf");
  });

  it("strips trailing articles (Plex format)", () => {
    expect(normalizeTitle("Matrix, The")).toBe("matrix");
  });

  it("strips parenthetical content", () => {
    expect(normalizeTitle("Avatar (2009)")).toBe("avatar");
    expect(normalizeTitle("Movie (Director's Cut)")).toBe("movie");
  });

  it("strips non-alphanumeric characters (unicode-safe)", () => {
    expect(normalizeTitle("Spider-Man: No Way Home")).toBe("spiderman no way home");
    expect(normalizeTitle("S.H.I.E.L.D.")).toBe("shield");
  });

  it("strips diacritics so accented and unaccented forms compare equal", () => {
    // Plex/Jellyfin/Emby copies sometimes drop accents while Arr keeps them.
    expect(normalizeTitle("Marina Abramović")).toBe("marina abramovic");
    expect(normalizeTitle("Pokémon")).toBe("pokemon");
    expect(normalizeTitle("Café Résumé")).toBe("cafe resume");
    expect(normalizeTitle("naïve")).toBe("naive");
  });

  it("collapses whitespace", () => {
    // Note: leading spaces prevent the ^(the|a|an) regex from matching,
    // so "The" is preserved. This is correct — real titles don't have leading spaces.
    expect(normalizeTitle("  The   Matrix   Reloaded  ")).toBe("the matrix reloaded");
    expect(normalizeTitle("The   Matrix   Reloaded")).toBe("matrix reloaded");
  });
});

describe("validateArrItem", () => {
  // --- Exact matches ---

  it("passes on exact title match", () => {
    expect(() =>
      validateArrItem("The Matrix", "The Matrix", "Radarr movie", "12345")
    ).not.toThrow();
  });

  it("passes when normalization makes titles equal", () => {
    // "Matrix, The" normalizes to "matrix", "The Matrix" normalizes to "matrix"
    expect(() =>
      validateArrItem("Matrix, The", "The Matrix", "Radarr movie", "12345")
    ).not.toThrow();
  });

  it("passes when year parenthetical is the only difference", () => {
    // "Avatar (2009)" → "avatar", "Avatar" → "avatar"
    expect(() =>
      validateArrItem("Avatar (2009)", "Avatar", "Radarr movie", "12345")
    ).not.toThrow();
  });

  it("passes when titles differ only by diacritics", () => {
    // Regression: Plex stored "Marina Abramovic" but Radarr returned "Marina Abramović".
    expect(() =>
      validateArrItem(
        "Marina Abramovic: The Artist Is Present",
        "Marina Abramović: The Artist Is Present",
        "Radarr movie",
        "84309",
      )
    ).not.toThrow();
    expect(() =>
      validateArrItem("Pokemon", "Pokémon", "Sonarr series", "12345")
    ).not.toThrow();
  });

  // --- Legitimate substring matches ---

  it("allows partial match when titles are similar length", () => {
    // "Agents of SHIELD" (16) vs "Marvel's Agents of S.H.I.E.L.D." (24 after norm)
    // Normalized: "agents of shield" (16) vs "marvels agents of shield" (24)
    // Ratio: 16/24 = 0.67 > 0.5 ✓
    expect(() =>
      validateArrItem(
        "Agents of SHIELD",
        "Marvel's Agents of S.H.I.E.L.D.",
        "Sonarr series",
        "12345"
      )
    ).not.toThrow();
  });

  // --- Dangerous substring matches that should now be BLOCKED ---

  it("blocks short title 'It' matching 'It Follows'", () => {
    // Normalized: "it" (2) vs "it follows" (10) — ratio 0.20 < 0.5
    expect(() =>
      validateArrItem("It", "It Follows", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("blocks short title 'Man' matching 'Spider-Man'", () => {
    // Normalized: "man" (3) vs "spiderman" (9) — ratio 0.33 < 0.5, also < 4 chars
    expect(() =>
      validateArrItem("Man", "Spider-Man", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("blocks short title 'Ice' matching 'Ice Age'", () => {
    // Normalized: "ice" (3) vs "ice age" (7) — ratio 0.43 < 0.5, also < 4 chars
    expect(() =>
      validateArrItem("Ice", "Ice Age", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("blocks 'Avatar' matching 'Avatar: The Way of Water'", () => {
    // Normalized: "avatar" (6) vs "avatar way of water" (19) — ratio 0.32 < 0.5
    expect(() =>
      validateArrItem("Avatar", "Avatar: The Way of Water", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("blocks reversed short match: 'It Follows' vs 'It'", () => {
    // Same ratio check applies in reverse
    expect(() =>
      validateArrItem("It Follows", "It", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  // --- Genuine mismatches ---

  it("throws on completely different titles", () => {
    expect(() =>
      validateArrItem("The Matrix", "Inception", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("throws on partial overlap that doesn't substring-match", () => {
    expect(() =>
      validateArrItem("Breaking Bad", "Better Call Saul", "Sonarr series", "12345")
    ).toThrow(/title mismatch/);
  });

  // --- Edge cases ---

  it("handles empty titles by throwing", () => {
    expect(() =>
      validateArrItem("", "Some Movie", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });

  it("handles titles that normalize to same after punctuation removal", () => {
    // "Spider-Man: No Way Home" → "spiderman no way home"
    // "Spider Man No Way Home" → "spider man no way home"
    // These are NOT equal after normalization (spiderman vs spider man)
    // But "spiderman no way home" contains "spider man no way home"? No — substring doesn't match
    expect(() =>
      validateArrItem("Spider-Man: No Way Home", "Spider Man No Way Home", "Radarr movie", "12345")
    ).toThrow(/title mismatch/);
  });
});

describe("validateArrItem — year guard (remake collisions)", () => {
  it("rejects same-title different-year records (Dune 1984 vs 2021)", () => {
    expect(() =>
      validateArrItem("Dune", "Dune", "Radarr movie", "438631", 2021, 1984)
    ).toThrow(/year mismatch/i);
  });

  it("rejects even when titles match exactly but years are far apart", () => {
    expect(() =>
      validateArrItem("The Office", "The Office", "Sonarr series", "73244", 2005, 2001)
    ).toThrow(/year mismatch/i);
  });

  it("allows a one-year drift (release-date rounding across regions)", () => {
    expect(() =>
      validateArrItem("Movie", "Movie", "Radarr movie", "1", 2020, 2021)
    ).not.toThrow();
  });

  it("does not gate when either year is missing or zero", () => {
    expect(() => validateArrItem("Movie", "Movie", "Radarr movie", "1", null, 1984)).not.toThrow();
    expect(() => validateArrItem("Movie", "Movie", "Radarr movie", "1", 2021, null)).not.toThrow();
    expect(() => validateArrItem("Movie", "Movie", "Radarr movie", "1", 2021, 0)).not.toThrow();
  });

  it("year guard overrides a would-be substring title pass", () => {
    // "Alien" vs "Aliens" would pass the substring escape hatch, but a 7-year
    // gap proves they're different works.
    expect(() =>
      validateArrItem("Alien", "Aliens", "Radarr movie", "1", 1979, 1986)
    ).toThrow(/year mismatch/i);
  });
})
