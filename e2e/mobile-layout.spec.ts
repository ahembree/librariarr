import { test, expect, type Page } from "@playwright/test";
import { PAGES } from "./constants";

/**
 * Phone layouts: no page may scroll sideways or cut content off at a phone's
 * width. The shell's <main> clips horizontal overflow, so a toolbar or card
 * header too wide for the screen either loses its last buttons off the edge
 * or, inside a page's own scroll box, makes the whole page slide left and
 * right under the finger. Both happened (Rule Matches, Pending Actions), and
 * neither shows up as an overflowing document, so this measures them
 * directly. Tables and tab strips that scroll sideways on purpose are their
 * own scroll boxes and are allowed.
 */

const WIDTHS = [375, 320];

/** Waits for the page's own data to land, so it is measured in its final layout. */
async function settle(page: Page) {
  await expect(page.locator("main [data-slot=skeleton]")).toHaveCount(0);
}

/** Everything about the page that is wider than the screen, described. */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element) => {
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 60)}"> "${text}"`;
    };
    const problems: string[] = [];

    if (document.documentElement.scrollWidth > vw + 1) {
      problems.push(`the document is ${document.documentElement.scrollWidth}px wide`);
    }

    // A scroll box holding the page heading is the page itself: if it can
    // scroll sideways, the whole page does.
    const heading = document.querySelector("main h1");
    for (let p = heading?.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 1) {
        problems.push(`the page scrolls sideways: ${describe(p)} is ${p.scrollWidth}px wide in ${p.clientWidth}px`);
      }
    }

    // Content past the screen edge that no scroll box can bring back. A
    // narrow clipping box (a card, a truncated label) is deliberate; a
    // page-wide one (the shell's <main>) is the screen edge.
    const reachable = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const style = getComputedStyle(p);
        if (/(auto|scroll)/.test(style.overflowX)) return true;
        if (/(hidden|clip)/.test(style.overflowX) && p.getBoundingClientRect().width < vw * 0.85) return true;
      }
      return false;
    };
    const cut = new Set<Element>();
    for (const el of document.querySelectorAll("main *")) {
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= vw + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      if (!reachable(el)) cut.add(el);
    }
    for (const el of cut) {
      if (cut.has(el.parentElement!)) continue;
      const rect = el.getBoundingClientRect();
      problems.push(`cut off at the screen edge: ${describe(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)}px`);
    }
    return problems;
  });
}

for (const width of WIDTHS) {
  test.describe(`phone layout at ${width}px`, () => {
    test.use({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });

    for (const { path, heading } of PAGES) {
      test(`${path} fits the screen`, async ({ page }) => {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
        await settle(page);
        expect(await horizontalOverflow(page)).toEqual([]);
      });
    }

    test("rule set cards on Rule Matches keep their buttons on screen", async ({ page }) => {
      await page.route("**/api/lifecycle/rules/matches", (route) =>
        route.fulfill({ json: { ruleMatches: [RULE_MATCH_GROUP] } }),
      );
      await page.goto("/lifecycle/matches");
      await expect(page.getByText(RULE_MATCH_GROUP.ruleSet.name)).toBeVisible();
      await settle(page);
      await expect(page.getByRole("button", { name: /^Re-evaluate$/ })).toBeInViewport({ ratio: 1 });
      expect(await horizontalOverflow(page)).toEqual([]);
    });

    test("rule set cards on Pending Actions keep Execute All on screen", async ({ page }) => {
      await page.route("**/api/lifecycle/actions?*", (route) =>
        route.fulfill({ json: { groups: [PENDING_GROUP] } }),
      );
      await page.route("**/api/lifecycle/stats", (route) => route.fulfill({ json: DELETION_STATS }));
      await page.goto("/lifecycle/pending");
      await expect(page.getByText(PENDING_GROUP.ruleSet.name)).toBeVisible();
      await settle(page);
      await expect(page.getByRole("button", { name: /^Execute All$/ })).toBeInViewport({ ratio: 1 });
      expect(await horizontalOverflow(page)).toEqual([]);
    });
  });
}

/**
 * A notched phone: viewport-fit=cover extends the page under the notch and
 * the home indicator, so the page has to pad itself clear of them. Chromium
 * stands in for the phone through its safe-area override, which makes
 * `env(safe-area-inset-*)` resolve as on the device.
 */
async function emulateSafeArea(
  page: Page,
  insets: { top: number; right: number; bottom: number; left: number },
) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
  } catch (error) {
    test.skip(true, `this Chromium has no safe-area override: ${(error as Error).message}`);
  }
}

test.describe("notched phone safe areas", () => {
  test.use({ hasTouch: true, isMobile: true });

  test.describe("in landscape", () => {
    test.use({ viewport: { width: 844, height: 390 } });

    test("nothing sits under the notch on either side", async ({ page }) => {
      await emulateSafeArea(page, { top: 0, right: 47, bottom: 21, left: 47 });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: PAGES[0].heading })).toBeVisible();
      await settle(page);
      const underNotch = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out: string[] = [];
        for (const el of document.querySelectorAll("a[href], button, h1")) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0 || el.closest('[aria-hidden="true"]')) continue;
          // A row that scrolls sideways (Recently Added) passes under the
          // edge by design; its own box is what has to stay clear.
          let inSideScroller = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 1) {
              inSideScroller = true;
              break;
            }
          }
          if (inSideScroller) continue;
          if (rect.left < 47 - 1 || rect.right > vw - 47 + 1) {
            out.push(`"${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}" spans ${Math.round(rect.left)}..${Math.round(rect.right)}px`);
          }
        }
        return out;
      });
      expect(underNotch).toEqual([]);
    });
  });

  test.describe("in portrait", () => {
    test.use({ viewport: { width: 390, height: 780 } });

    test("the filter sheet ends above the home indicator", async ({ page }) => {
      await emulateSafeArea(page, { top: 0, right: 0, bottom: 34, left: 0 });
      await page.goto("/library/movies");
      await page.getByRole("button", { name: /^Filters/ }).click();
      const sheet = page.locator("[data-slot=sheet-content]");
      await expect(sheet).toBeVisible();
      expect(await sheet.evaluate((el) => getComputedStyle(el).paddingBottom)).toBe("34px");
    });
  });
});

const RULE_SET = {
  id: "mobile-rs",
  name: "Films nobody has watched in years",
  type: "MOVIE",
  actionEnabled: true,
  actionType: "DELETE_RADARR",
  actionDelayDays: 7,
  arrInstanceId: null,
  targetQualityProfileId: null,
  addImportExclusion: true,
  searchAfterAction: false,
  addArrTags: ["librariarr-delete"],
  removeArrTags: [],
};

const RULE_MATCH_GROUP = {
  ruleSet: { ...RULE_SET, collectionName: "Leaving Soon" },
  items: [],
  count: 1333,
};

const PENDING_GROUP = { ruleSet: RULE_SET, items: [], count: 1333 };

const DELETION_STATS = {
  totalBytesDeleted: "45150000000",
  actionCount: 300,
  pendingBytes: "533100000000000",
  pendingCount: 10804,
  byRuleSet: [
    {
      ruleSetId: RULE_SET.id,
      ruleSetName: RULE_SET.name,
      ruleSetType: "MOVIE",
      deleted: false,
      deletedBytes: "45150000000",
      deletedCount: 300,
      pendingBytes: "66650000000000",
      pendingCount: 1333,
    },
  ],
  resetAt: null,
};
