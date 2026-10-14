/**
 * One social-share image per docs page, rendered at build time from the
 * page's title and description (satori → SVG → sharp → PNG, 1200×630).
 * `src/route-data.ts` points each page's og:image / twitter:image here; the
 * docs index and the landing page keep the hand-made hero image.
 *
 * Text is set in Sora from `@fontsource/sora` (the static files — satori
 * cannot read a variable font), resolved through the package's exports so the
 * path survives a hoisting change in node_modules.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import satori from "satori";
import sharp from "sharp";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "../../route-data";

const require = createRequire(import.meta.url);
const fontFile = (weight: number) =>
  readFileSync(
    require.resolve(`@fontsource/sora/files/sora-latin-${weight}-normal.woff`),
  );
const FONTS = [
  {
    name: "Sora",
    data: fontFile(400),
    weight: 400 as const,
    style: "normal" as const,
  },
  {
    name: "Sora",
    data: fontFile(600),
    weight: 600 as const,
    style: "normal" as const,
  },
  {
    name: "Sora",
    data: fontFile(700),
    weight: 700 as const,
    style: "normal" as const,
  },
];

const SECTION_LABELS: Record<string, string> = {
  "getting-started": "Getting Started",
  guides: "Guides",
  features: "Features",
  integrations: "Integrations",
  advanced: "Advanced",
  development: "Development",
};

// The landing page's palette (index.astro :root), in sRGB for the renderer.
const BG = "#1c1d21";
const BG_GLOW = "#2a2f4f";
const TEXT = "#f2f1ee";
const MUTED = "#9a9db0";
const ACCENT = "#6b7cf7";

const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
) => ({
  type,
  props: { style, children },
});

const PADDING_X = 72;
const PADDING_Y = 64;

function card(section: string, title: string, description: string | undefined) {
  const titleSize = title.length > 48 ? 48 : title.length > 32 ? 58 : 68;
  // The renderer adds padding OUTSIDE the box it is given (content-box), so
  // padding on the root pushed the footer row below the bottom edge and the
  // right-aligned text past the right one. The root is the bare canvas; the
  // content box has explicit dimensions and a margin instead.
  return h(
    "div",
    {
      width: "100%",
      height: "100%",
      display: "flex",
      backgroundColor: BG,
      backgroundImage: `radial-gradient(circle at 85% 0%, ${BG_GLOW} 0%, ${BG} 55%)`,
      color: TEXT,
      fontFamily: "Sora",
    },
    [
      h(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: OG_IMAGE_WIDTH - 2 * PADDING_X,
          height: OG_IMAGE_HEIGHT - 2 * PADDING_Y,
          margin: `${PADDING_Y}px ${PADDING_X}px`,
        },
        [
          h("div", { display: "flex", flexDirection: "column" }, [
            h(
              "div",
              {
                display: "flex",
                alignItems: "center",
                fontSize: 24,
                fontWeight: 600,
                color: ACCENT,
                letterSpacing: 2,
                textTransform: "uppercase",
                marginBottom: 28,
              },
              section,
            ),
            h(
              "div",
              {
                display: "flex",
                fontSize: titleSize,
                fontWeight: 700,
                lineHeight: 1.12,
                letterSpacing: -1.5,
                marginBottom: 28,
              },
              title,
            ),
            ...(description
              ? [
                  h(
                    "div",
                    {
                      display: "block",
                      fontSize: 28,
                      fontWeight: 400,
                      lineHeight: 1.4,
                      color: MUTED,
                      lineClamp: 3,
                      maxWidth: 980,
                    },
                    description,
                  ),
                ]
              : []),
          ]),
          h(
            "div",
            {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 26,
              fontWeight: 600,
            },
            [
              h("div", { display: "flex", alignItems: "center" }, [
                h("div", {
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  backgroundColor: ACCENT,
                  marginRight: 14,
                }),
                h("div", { display: "flex" }, "Librariarr"),
              ]),
              h(
                "div",
                { display: "flex", color: MUTED, fontWeight: 400 },
                "librariarr.dev",
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

export const getStaticPaths: GetStaticPaths = async () => {
  const pages = await getCollection("docs");
  return (
    pages
      // The docs index keeps the hero image (see route-data.ts).
      .filter((page) => page.id !== "docs")
      .map((page) => {
        const section = page.id.split("/")[1] ?? "";
        return {
          params: { slug: page.id },
          props: {
            section: SECTION_LABELS[section] ?? "Documentation",
            title: page.data.seoTitle ?? page.data.title,
            description: page.data.description,
          },
        };
      })
  );
};

export const GET: APIRoute = async ({ props }) => {
  const { section, title, description } = props as {
    section: string;
    title: string;
    description?: string;
  };
  const svg = await satori(card(section, title, description) as never, {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts: FONTS,
  });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new Response(new Uint8Array(png), {
    headers: { "Content-Type": "image/png" },
  });
};
