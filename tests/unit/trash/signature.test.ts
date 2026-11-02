import { describe, it, expect } from "vitest";
import {
  trashCfHash,
  trashProfileHash,
  trashQualitySizeHash,
  namingSelectionHash,
} from "@/lib/trash/signature";
import { stableStringify, hashDefinition } from "@/lib/trash/hash";
import type {
  TrashCustomFormat,
  TrashQualityProfile,
  TrashQualitySize,
  TrashNaming,
} from "@/lib/trash/types";

const cf: TrashCustomFormat = {
  trash_id: "x",
  name: "AMZN",
  includeCustomFormatWhenRenaming: true,
  specifications: [{ name: "s", implementation: "i", fields: { value: 1 } }],
};

describe("stable hashing", () => {
  it("is order-independent for object keys", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(hashDefinition({ a: 1, b: 2 })).toBe(hashDefinition({ b: 2, a: 1 }));
  });
});

describe("resource hashes", () => {
  it("custom-format hash changes only when the definition changes", () => {
    const h1 = trashCfHash(cf);
    // trash_id / scores don't affect the definition hash.
    expect(trashCfHash({ ...cf, trash_id: "different", trash_scores: { default: 9 } })).toBe(h1);
    // A spec change flips the hash.
    expect(
      trashCfHash({ ...cf, specifications: [{ name: "s", implementation: "i", fields: { value: 2 } }] }),
    ).not.toBe(h1);
  });

  it("profile hash reacts to items and formatItems", () => {
    const p: TrashQualityProfile = {
      trash_id: "p",
      name: "P",
      cutoff: "Bluray-1080p",
      items: [{ name: "Bluray-1080p", allowed: true }],
      formatItems: { A: "cf-a" },
    };
    const h = trashProfileHash(p);
    expect(trashProfileHash({ ...p })).toBe(h);
    expect(trashProfileHash({ ...p, formatItems: { A: "cf-b" } })).not.toBe(h);
    expect(trashProfileHash({ ...p, items: [{ name: "Bluray-1080p", allowed: false }] })).not.toBe(h);
  });

  it("profile hash folds in the referenced formats' guide scores and the local selection", () => {
    const p: TrashQualityProfile = {
      trash_id: "p",
      name: "P",
      cutoff: "Bluray-1080p",
      items: [{ name: "Bluray-1080p", allowed: true }],
      formatItems: { AMZN: "cf-a" },
    };
    const cfs = (score: number) =>
      new Map<string, TrashCustomFormat>([
        ["cf-a", { ...cf, trash_id: "cf-a", trash_scores: { default: score } }],
        // Not referenced by the profile: its scores must not matter.
        ["cf-z", { ...cf, trash_id: "cf-z", trash_scores: { default: 1 } }],
      ]);
    const h = trashProfileHash(p, cfs(100));
    // A guide score re-tune lives in the CF catalog, not the profile file.
    expect(trashProfileHash(p, cfs(75))).not.toBe(h);
    const unreferencedRetune = cfs(100);
    unreferencedRetune.set("cf-z", { ...cf, trash_id: "cf-z", trash_scores: { default: 2 } });
    expect(trashProfileHash(p, unreferencedRetune)).toBe(h);
    // A local option change flips it too.
    expect(trashProfileHash(p, cfs(100), { resetUnmatchedScores: true })).not.toBe(h);
  });

  it("quality-size hash reacts to any size change", () => {
    const qs: TrashQualitySize = { trash_id: "q", type: "movie", qualities: [{ quality: "X", min: 1, max: 2 }] };
    const h = trashQualitySizeHash(qs);
    expect(trashQualitySizeHash({ ...qs, qualities: [{ quality: "X", min: 1, max: 3 }] })).not.toBe(h);
  });

  it("naming hash folds in the chosen variant strings", () => {
    const naming: TrashNaming = { file: { a: "AAA", b: "BBB" }, folder: { d: "DDD" } };
    const h1 = namingSelectionHash(naming, { file: "a", folder: "d" }, "RADARR");
    const h2 = namingSelectionHash(naming, { file: "b", folder: "d" }, "RADARR");
    expect(h1).not.toBe(h2);
    // The guide string is what counts: an upstream edit of the chosen variant flips it.
    expect(namingSelectionHash({ ...naming, file: { a: "AAA2", b: "BBB" } }, { file: "a", folder: "d" }, "RADARR")).not.toBe(h1);
  });

  it("naming hash reads Sonarr's episode variants and ignores Radarr's keys", () => {
    const naming: TrashNaming = {
      file: { a: "AAA" },
      series: { default: "SSS" },
      episodes: { standard: { default: "EEE", alt: "EE2" } },
    };
    const h = namingSelectionHash(naming, { series: "default", standard: "default" }, "SONARR");
    expect(namingSelectionHash(naming, { series: "default", standard: "alt" }, "SONARR")).not.toBe(h);
    expect(namingSelectionHash(naming, { series: "default", standard: "default", file: "a" }, "SONARR")).toBe(h);
  });
});
