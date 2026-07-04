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
    expect(trashProfileHash({ ...p, formatItems: { A: "cf-b" } })).not.toBe(h);
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
  });
});
