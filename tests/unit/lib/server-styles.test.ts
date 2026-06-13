import { describe, it, expect } from "vitest";
import {
  SERVER_TYPE_STYLES,
  DEFAULT_SERVER_STYLE,
  getServerTypeLabel,
  getDuplicateServerNames,
} from "@/lib/server-styles";

describe("SERVER_TYPE_STYLES", () => {
  it("contains PLEX, JELLYFIN, and EMBY entries", () => {
    expect(Object.keys(SERVER_TYPE_STYLES).sort()).toEqual(["EMBY", "JELLYFIN", "PLEX"]);
  });

  it("PLEX has expected label and color but no manual styles", () => {
    expect(SERVER_TYPE_STYLES.PLEX.label).toBe("Plex");
    expect(SERVER_TYPE_STYLES.PLEX.color).toBe("#fb923c");
    expect(SERVER_TYPE_STYLES.PLEX.manual).toBeUndefined();
  });

  it("JELLYFIN has manual styles", () => {
    expect(SERVER_TYPE_STYLES.JELLYFIN.label).toBe("Jellyfin");
    expect(SERVER_TYPE_STYLES.JELLYFIN.manual).toBeDefined();
    expect(SERVER_TYPE_STYLES.JELLYFIN.manual?.btn).toBe("bg-purple-500");
  });

  it("EMBY has manual styles", () => {
    expect(SERVER_TYPE_STYLES.EMBY.label).toBe("Emby");
    expect(SERVER_TYPE_STYLES.EMBY.manual).toBeDefined();
    expect(SERVER_TYPE_STYLES.EMBY.manual?.btnText).toBe("text-white");
  });

  it("each style exposes the full ServerStyle shape (classes, rgba, onboarding)", () => {
    for (const type of Object.keys(SERVER_TYPE_STYLES)) {
      const style = SERVER_TYPE_STYLES[type];
      expect(typeof style.classes).toBe("string");
      expect(style.rgba).toMatchObject({
        bg: expect.any(String),
        hover: expect.any(String),
        text: expect.any(String),
      });
      expect(style.onboarding).toMatchObject({
        iconColor: expect.any(String),
        borderColor: expect.any(String),
        bgColor: expect.any(String),
        hoverBg: expect.any(String),
        glowColor: expect.any(String),
      });
    }
  });
});

describe("DEFAULT_SERVER_STYLE", () => {
  it("has an Unknown label and a neutral color", () => {
    expect(DEFAULT_SERVER_STYLE.label).toBe("Unknown");
    expect(DEFAULT_SERVER_STYLE.color).toBe("#a1a1aa");
  });

  it("has no manual styles", () => {
    expect(DEFAULT_SERVER_STYLE.manual).toBeUndefined();
  });
});

describe("getServerTypeLabel", () => {
  it("returns the friendly label for known types", () => {
    expect(getServerTypeLabel("PLEX")).toBe("Plex");
    expect(getServerTypeLabel("JELLYFIN")).toBe("Jellyfin");
    expect(getServerTypeLabel("EMBY")).toBe("Emby");
  });

  it("returns the raw type for unknown types (fallback)", () => {
    expect(getServerTypeLabel("MYSTERY")).toBe("MYSTERY");
  });

  it("returns empty string for empty input (fallback)", () => {
    expect(getServerTypeLabel("")).toBe("");
  });

  it("is case-sensitive (lowercase plex is not recognized)", () => {
    expect(getServerTypeLabel("plex")).toBe("plex");
  });
});

describe("getDuplicateServerNames", () => {
  it("returns an empty set for an empty list", () => {
    expect(getDuplicateServerNames([])).toEqual(new Set());
  });

  it("returns an empty set when all names are unique", () => {
    const result = getDuplicateServerNames([
      { name: "A" },
      { name: "B" },
      { name: "C" },
    ]);
    expect(result).toEqual(new Set());
  });

  it("identifies names appearing more than once", () => {
    const result = getDuplicateServerNames([
      { name: "Home" },
      { name: "Home" },
      { name: "Work" },
    ]);
    expect(result).toEqual(new Set(["Home"]));
  });

  it("identifies multiple duplicate names", () => {
    const result = getDuplicateServerNames([
      { name: "X" },
      { name: "X" },
      { name: "Y" },
      { name: "Y" },
      { name: "Z" },
    ]);
    expect(result).toEqual(new Set(["X", "Y"]));
  });

  it("treats names appearing three+ times as a single duplicate entry", () => {
    const result = getDuplicateServerNames([
      { name: "Dup" },
      { name: "Dup" },
      { name: "Dup" },
    ]);
    expect(result).toEqual(new Set(["Dup"]));
    expect(result.size).toBe(1);
  });

  it("preserves extra fields on objects (generic constraint only needs name)", () => {
    const result = getDuplicateServerNames([
      { name: "A", id: 1 },
      { name: "A", id: 2 },
    ]);
    expect(result.has("A")).toBe(true);
  });

  it("is case-sensitive when comparing names", () => {
    const result = getDuplicateServerNames([{ name: "Plex" }, { name: "plex" }]);
    expect(result).toEqual(new Set());
  });
});
