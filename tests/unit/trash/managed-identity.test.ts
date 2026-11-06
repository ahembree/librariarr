/**
 * How a managed TRaSH row finds its app resource when the guide name is not in
 * the app: the resource at the id recorded at the last sync is taken only when
 * it is provably the row's (the name it last synced under, or its content).
 * An id alone can name another app's resource — the instance pointed at a new
 * app, or the app restored from an older backup — and a sync would overwrite
 * and rename the user's own custom format or quality profile.
 */
import { describe, it, expect } from "vitest";
import {
  trashCfToArr,
  findManagedArrResource,
  sameCustomFormatContent,
  sameQualityProfileContent,
  buildQualityProfile,
  buildManagedQualityProfile,
  findManagedQualityProfile,
  overlayAppliedTo,
  overlayScores,
  findOverlayProfile,
  profileScoreOverrides,
  profileOverlayOf,
  nameKey,
  type ManagedProfileContext,
  type ProfileOverlay,
} from "@/lib/trash/translate";
import type {
  ArrCustomFormat,
  ArrQualityProfile,
  ArrQualityProfileSchema,
  TrashCustomFormat,
  TrashQualityProfile,
} from "@/lib/trash/types";

const BR_DISK: TrashCustomFormat = {
  trash_id: "br",
  name: "BR-DISK",
  includeCustomFormatWhenRenaming: false,
  trash_scores: { default: -10000 },
  specifications: [
    { name: "BR-DISK", implementation: "QualityModifierSpecification", negate: false, required: true, fields: { value: 5 } },
  ],
};

/** The user's own format, which the new app happens to number 1. */
const MY_RELEASE_GROUP: ArrCustomFormat = {
  id: 1,
  name: "My Release Group",
  includeCustomFormatWhenRenaming: true,
  specifications: [
    { name: "Group", implementation: "ReleaseGroupSpecification", negate: false, required: true, fields: [{ name: "value", value: "^(GRP)$" }] },
  ],
};

describe("nameKey", () => {
  it("compares names trimmed and case-insensitively", () => {
    expect(nameKey("  HD Bluray ")).toBe(nameKey("hd bluray"));
  });
});

describe("sameCustomFormatContent", () => {
  it("accepts the guide's format under another name, ignoring fields the app adds", () => {
    const renamed: ArrCustomFormat = {
      ...trashCfToArr(BR_DISK, 1),
      name: "No BR-DISK please",
      specifications: [
        {
          name: "BR-DISK",
          implementation: "QualityModifierSpecification",
          negate: false,
          required: true,
          fields: [{ name: "value", value: 5 }, { name: "appDefault", value: false }],
        },
      ],
    };
    expect(sameCustomFormatContent(renamed, BR_DISK)).toBe(true);
  });

  it("refuses another format, a changed value, a missing spec and a changed flag", () => {
    expect(sameCustomFormatContent(MY_RELEASE_GROUP, BR_DISK)).toBe(false);
    const payload = trashCfToArr(BR_DISK, 1);
    const spec = payload.specifications[0];
    expect(
      sameCustomFormatContent({ ...payload, specifications: [{ ...spec, fields: [{ name: "value", value: 6 }] }] }, BR_DISK),
    ).toBe(false);
    expect(sameCustomFormatContent({ ...payload, specifications: [] }, BR_DISK)).toBe(false);
    expect(sameCustomFormatContent({ ...payload, includeCustomFormatWhenRenaming: true }, BR_DISK)).toBe(false);
  });

  it("with findManagedArrResource: a stale id finds nothing, a format renamed in the app is followed", () => {
    const content = (c: ArrCustomFormat) => sameCustomFormatContent(c, BR_DISK);
    const recorded = { arrId: 1, name: "BR-DISK" };
    expect(findManagedArrResource([MY_RELEASE_GROUP], BR_DISK.name, recorded, content)).toBeUndefined();
    const renamedInApp = { ...trashCfToArr(BR_DISK, 1), name: "BR-DISK (mine)" };
    expect(findManagedArrResource([MY_RELEASE_GROUP, { ...renamedInApp, id: 2 }], BR_DISK.name, recorded, content)).toBeUndefined();
    expect(findManagedArrResource([renamedInApp], BR_DISK.name, recorded, content)).toBe(renamedInApp);
  });
});

const q = (id: number, name: string) => ({ id, name });

const SCHEMA: ArrQualityProfileSchema = {
  name: "",
  upgradeAllowed: true,
  cutoff: 0,
  minFormatScore: 0,
  cutoffFormatScore: 0,
  minUpgradeFormatScore: 1,
  items: [
    { quality: q(1, "SDTV"), items: [], allowed: false },
    { quality: q(7, "Bluray-1080p"), items: [], allowed: false },
  ],
  formatItems: [
    { format: 10, name: "BR-DISK", score: 0 },
    { format: 11, name: "AMZN", score: 0 },
  ],
  language: { id: 1, name: "English" },
};

const QP: TrashQualityProfile = {
  trash_id: "qp1",
  name: "HD Bluray",
  cutoff: "Bluray-1080p",
  upgradeAllowed: true,
  cutoffFormatScore: 10000,
  items: [{ name: "Bluray-1080p", allowed: true }],
  formatItems: { "BR-DISK": "br" },
};

const CF_MAP = new Map([["br", BR_DISK]]);

function ctx(over: Partial<ManagedProfileContext> = {}): ManagedProfileContext {
  return { schema: SCHEMA, service: "SONARR", cfMapByTrashId: CF_MAP, overlays: [], ...over };
}

/** The profile a sync of QP leaves in the app, at `id`. */
function synced(id: number, over: Partial<ArrQualityProfile> = {}): ArrQualityProfile {
  return { ...buildQualityProfile(QP, SCHEMA, "SONARR", CF_MAP).payload, id, ...over };
}

/** The app's stock profile the new app numbers 3. */
const ANY: ArrQualityProfile = {
  id: 3,
  name: "Any",
  upgradeAllowed: false,
  cutoff: 1,
  minFormatScore: 0,
  cutoffFormatScore: 0,
  items: [
    { quality: q(1, "SDTV"), items: [], allowed: true },
    { quality: q(7, "Bluray-1080p"), items: [], allowed: true },
  ],
  formatItems: [
    { format: 10, name: "BR-DISK", score: 0 },
    { format: 11, name: "AMZN", score: 0 },
  ],
};

describe("sameQualityProfileContent / findManagedQualityProfile", () => {
  it("compares everything but the name", () => {
    const payload = synced(3);
    expect(sameQualityProfileContent({ ...payload, name: "Renamed" }, payload, "SONARR")).toBe(true);
    expect(sameQualityProfileContent(ANY, { ...payload, id: 3 }, "SONARR")).toBe(false);
    expect(
      sameQualityProfileContent({ ...payload, formatItems: payload.formatItems.map((f) => ({ ...f, score: 1 })) }, payload, "SONARR"),
    ).toBe(false);
  });

  it("never takes another profile at the recorded id", () => {
    const recorded = { arrId: 3, name: "HD Bluray" };
    expect(findManagedQualityProfile([ANY], QP, recorded, ctx())).toBeUndefined();
    expect(findManagedQualityProfile([ANY], QP, recorded)).toBeUndefined();
  });

  it("follows a profile renamed in the app when its content is untouched, given the schema", () => {
    const renamed = synced(3, { name: "My HD" });
    const recorded = { arrId: 3, name: "HD Bluray" };
    expect(findManagedQualityProfile([renamed], QP, recorded, ctx())).toBe(renamed);
    // Without the schema only the recorded name can prove it.
    expect(findManagedQualityProfile([renamed], QP, recorded)).toBeUndefined();
    expect(findManagedQualityProfile([renamed], QP, { arrId: 3, name: "my hd" })).toBe(renamed);
    // Renamed AND changed: no longer provably the row's.
    const changed = { ...renamed, cutoffFormatScore: 5 };
    expect(findManagedQualityProfile([changed], QP, recorded, ctx())).toBeUndefined();
  });

  it("judges the content with the overlay targeting the profile folded in", () => {
    // The overlay overrides a score the guide profile sets (BR-DISK -10000).
    const overlay: ProfileOverlay = {
      profileName: "HD Bluray",
      arrId: 3,
      name: "HD Bluray",
      formats: [{ trashId: "br", name: "BR-DISK", score: -500 }],
    };
    const withOverlay = synced(3, {
      name: "My HD",
      formatItems: [
        { format: 10, name: "BR-DISK", score: -500 },
        { format: 11, name: "AMZN", score: 0 },
      ],
    });
    const recorded = { arrId: 3, name: "HD Bluray" };
    expect(findManagedQualityProfile([withOverlay], QP, recorded, ctx())).toBeUndefined();
    expect(findManagedQualityProfile([withOverlay], QP, recorded, ctx({ overlays: [overlay] }))).toBe(withOverlay);
    expect(buildManagedQualityProfile(QP, ctx({ overlays: [overlay] }), withOverlay).payload.formatItems).toEqual(
      withOverlay.formatItems,
    );
  });
});

describe("PROFILE_CF overlays", () => {
  const scores = overlayScores([{ trashId: "br", name: "Old BR name", score: -500 }], CF_MAP);

  it("keys an overlay's scores by the guide's current format name", () => {
    expect([...scores]).toEqual([["br-disk", -500]]);
  });

  it("overlayAppliedTo needs every present format scored as the overlay says, one of them non-zero", () => {
    const profile = (score: number) => ({ ...ANY, formatItems: [{ format: 10, name: "BR-DISK", score }] });
    expect(overlayAppliedTo(profile(-500), scores)).toBe(true);
    expect(overlayAppliedTo(profile(0), scores)).toBe(false);
    expect(overlayAppliedTo(profile(0), new Map([["br-disk", 0]]))).toBe(false);
    expect(overlayAppliedTo({ ...ANY, formatItems: [] }, scores)).toBe(false);
    expect(overlayAppliedTo({ ...ANY, formatItems: undefined as unknown as [] }, scores)).toBe(false);
  });

  it("findOverlayProfile: by name, by id under the recorded name, by id with its scores on — never by id alone", () => {
    const applied = { ...ANY, id: 9, name: "Renamed in app", formatItems: [{ format: 10, name: "BR-DISK", score: -500 }] };
    expect(findOverlayProfile([ANY], { profileName: "any", arrId: null, name: null }, scores)).toBe(ANY);
    expect(findOverlayProfile([ANY], { profileName: "HD", arrId: 3, name: "Any" }, scores)).toBe(ANY);
    expect(findOverlayProfile([applied], { profileName: "HD", arrId: 9, name: "HD" }, scores)).toBe(applied);
    expect(findOverlayProfile([ANY], { profileName: "HD", arrId: 3, name: "HD" }, scores)).toBeUndefined();
  });

  it("profileScoreOverrides folds in only the overlays that provably target the profile", () => {
    const o = (over: Partial<ProfileOverlay>): ProfileOverlay => ({
      profileName: "Elsewhere",
      arrId: null,
      name: null,
      formats: [{ trashId: "br", name: "BR-DISK", score: -1 }],
      ...over,
    });
    const profile = synced(3, { name: "My HD" });
    const fold = (overlay: ProfileOverlay, p: ArrQualityProfile | undefined = profile) =>
      profileScoreOverrides("HD Bluray", p, [overlay], CF_MAP).get("br-disk");
    expect(fold(o({ profileName: "hd bluray" }), undefined)).toBe(-1);
    expect(fold(o({ profileName: "My HD" }))).toBe(-1);
    expect(fold(o({ arrId: 3, name: "my hd" }))).toBe(-1);
    // A stale id: another profile under that id, scores not on it.
    expect(fold(o({ arrId: 3, name: "Something else" }))).toBeUndefined();
    expect(fold(o({ arrId: 3, name: "Something else" }), undefined)).toBeUndefined();
  });

  it("profileOverlayOf reads a PROFILE_CF row", () => {
    expect(profileOverlayOf({ trashId: "HD", arrId: 4, name: "HD 2", selection: { formats: [{ trashId: "br", name: "BR-DISK", score: 1 }] } })).toEqual({
      profileName: "HD",
      arrId: 4,
      name: "HD 2",
      formats: [{ trashId: "br", name: "BR-DISK", score: 1 }],
    });
    expect(profileOverlayOf({ trashId: "HD", arrId: null, name: "HD", selection: null }).formats).toEqual([]);
  });
});
