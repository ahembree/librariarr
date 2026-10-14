/**
 * Starlight route middleware: the per-page SEO head on top of Starlight's own
 * tags (canonical, Open Graph, meta description, the share-image tags from
 * the config `head`).
 *
 * - `<title>` and `og:title` take the page's `seoTitle` frontmatter when set,
 *   suffixed with the docs site name; the docs index keeps its bare title.
 * - Every docs page but the index gets its own social image, rendered at
 *   build time by `src/pages/og/[...slug].png.ts` from the page's title and
 *   description, in place of the shared hero image.
 * - BreadcrumbList (Home → Documentation → page) + TechArticle JSON-LD, the
 *   latter with the page's last-updated date from git.
 */
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import type { StarlightRouteData } from "@astrojs/starlight/route-data";

type HeadEntry = StarlightRouteData["head"][number];

const DOCS_SITE_NAME = "Librariarr Docs";
const FALLBACK_SITE = "https://librariarr.dev/";
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/** Replace the first head entry `matches` accepts, or append `entry`. */
function upsert(
  head: HeadEntry[],
  matches: (entry: HeadEntry) => boolean,
  entry: HeadEntry,
) {
  const index = head.findIndex(matches);
  if (index === -1) head.push(entry);
  else head[index] = entry;
}

const meta = (
  attr: "name" | "property",
  key: string,
  content: string,
): HeadEntry => ({
  tag: "meta",
  attrs: { [attr]: key, content },
  content: "",
});

const metaMatcher =
  (attr: "name" | "property", key: string) => (entry: HeadEntry) =>
    entry.tag === "meta" && entry.attrs?.[attr] === key;

/** The published path of a page's generated social image, `/og/<id>.png`. */
export function ogImagePath(pathname: string): string {
  const slug = pathname.replace(/^\/+|\/+$/g, "");
  return `/og/${slug}.png`;
}

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  const { entry, siteTitle, lastUpdated, lang, head } = route;
  const site = context.site ?? new URL(FALLBACK_SITE);
  const pageUrl = new URL(context.url.pathname, site);
  const docsUrl = new URL("/docs/", site);
  const isDocsIndex = pageUrl.pathname === docsUrl.pathname;

  // --- title ---
  const pageTitle = entry.data.seoTitle ?? entry.data.title;
  const documentTitle = isDocsIndex
    ? entry.data.title
    : `${pageTitle} | ${DOCS_SITE_NAME}`;
  upsert(head, (h) => h.tag === "title", {
    tag: "title",
    attrs: {},
    content: documentTitle,
  });
  upsert(
    head,
    metaMatcher("property", "og:title"),
    meta("property", "og:title", pageTitle),
  );

  // --- social image ---
  if (!isDocsIndex) {
    const image = new URL(ogImagePath(pageUrl.pathname), site).href;
    const alt = `${pageTitle} — ${DOCS_SITE_NAME}`;
    upsert(
      head,
      metaMatcher("property", "og:image"),
      meta("property", "og:image", image),
    );
    upsert(
      head,
      metaMatcher("property", "og:image:type"),
      meta("property", "og:image:type", "image/png"),
    );
    upsert(
      head,
      metaMatcher("property", "og:image:width"),
      meta("property", "og:image:width", String(OG_IMAGE_WIDTH)),
    );
    upsert(
      head,
      metaMatcher("property", "og:image:height"),
      meta("property", "og:image:height", String(OG_IMAGE_HEIGHT)),
    );
    upsert(
      head,
      metaMatcher("property", "og:image:alt"),
      meta("property", "og:image:alt", alt),
    );
    upsert(
      head,
      metaMatcher("name", "twitter:image"),
      meta("name", "twitter:image", image),
    );
    upsert(
      head,
      metaMatcher("name", "twitter:image:alt"),
      meta("name", "twitter:image:alt", alt),
    );
  }

  // --- structured data ---
  const crumbs = [
    { name: siteTitle, item: site.href },
    { name: "Documentation", item: docsUrl.href },
    ...(isDocsIndex ? [] : [{ name: entry.data.title, item: pageUrl.href }]),
  ];
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((crumb, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: crumb.name,
          item: crumb.item,
        })),
      },
      {
        "@type": "TechArticle",
        headline: pageTitle,
        ...(entry.data.description
          ? { description: entry.data.description }
          : {}),
        url: pageUrl.href,
        inLanguage: lang,
        ...(lastUpdated ? { dateModified: lastUpdated.toISOString() } : {}),
        isPartOf: { "@type": "WebSite", name: siteTitle, url: site.href },
      },
    ],
  };
  head.push({
    tag: "script",
    attrs: { type: "application/ld+json" },
    // JSON inside <script> must not be able to close the element.
    content: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
  });
});
