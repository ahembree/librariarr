---
name: doc-feature
description: Create or update documentation in the Astro Starlight docs site (librariarr.dev) — which page covers each area, MDX format, sidebar, SEO frontmatter, guides and the rule-set library, and how the site is built. Use when adding features, changing behaviour that docs describe, or editing anything under docs/.
argument-hint: <feature-name> [new|update]
---

# Documentation Generator

Create or update documentation for: $ARGUMENTS

## Context

The docs site is **completely isolated** from the Next.js app:
- Built with Astro + Starlight, deployed to GitHub Pages at librariarr.dev
- Separate `package.json`, `tsconfig.json`, build toolchain
- MDX files at `docs/src/content/docs/docs/`
- Sidebar configured in `docs/astro.config.mjs`

## Directory Structure

```
docs/src/content/docs/docs/
  getting-started/    — installation, configuration, connecting a server, Unraid
  features/           — dashboard, library, query, lifecycle rules, deletion safety, stream manager, …
  guides/             — use-case guides and the importable rule-set library
  integrations/       — Plex, Jellyfin/Emby, Sonarr, Radarr, Lidarr, Seerr, Tracearr
  advanced/           — API, API reference, SSO, security hardening, development
  development/        — style guide
```

## MDX File Format

```mdx
---
title: Feature Name
description: Brief description for SEO and link previews.
---

Content here using standard Markdown.

## Section Heading

Use Starlight components for rich content:
- `:::note` / `:::tip` / `:::caution` / `:::danger` — callout boxes
- `import { Tabs, TabItem } from '@astrojs/starlight/components';` — tabbed content
- `import { Steps } from '@astrojs/starlight/components';` — numbered steps
```

## Sidebar Configuration

New pages must be added to `docs/astro.config.mjs`:

```javascript
// In the sidebar array, under the appropriate section:
{
  label: "Features",
  items: [
    // ... existing items
    { label: "New Feature", slug: "docs/features/new-feature" },
  ],
},
```

The `slug` must match the file path relative to `docs/src/content/docs/` without the `.mdx` extension.

### MDX is not Markdown

MDX reads `<` followed by a letter as a JSX tag, so a bare placeholder such as `"Discovery OK: <issuer>"` or `<name>` fails the whole site's build (`Expected a closing tag for <issuer>`). Put literal angle brackets in a code span (`` `Discovery OK: <issuer>` ``) or escape them (`&lt;issuer&gt;`); `{` and `}` outside code are JSX expressions too. Lowercase HTML tags (`<details>`, `<summary>`, `<br />`) and imported Starlight components (`<Aside>`, `<Tabs>`) are real elements and must be closed.

### Always build the docs

Whenever a change touches `docs/` — or a source the build reads (`scripts/generate-openapi.ts`, `scripts/validate-rule-set-library.ts`, `scripts/rule-set-library-check.ts`, `src/lib/api-keys/{openapi,scopes,limits}.ts`, `src/lib/conditions/{fields,operators,types}.ts`, `src/lib/lifecycle/action-types.ts`, `package.json`) — run `pnpm docs:build` and see it pass before committing. `.claude/hooks/docs-build-before-commit.sh` (wired in `.claude/settings.json`) does this on every `git commit` Claude runs whose changes touch those paths, and blocks the commit with the build's error when it fails; keep its path list in step with what the build reads.

## Existing Sidebar Sections

Read `docs/astro.config.mjs` for the current sidebar; add every new page there.

## Steps

### For new documentation pages:
1. Create MDX file at `docs/src/content/docs/docs/<category>/<name>.mdx`
2. Add frontmatter with `title`, a specific keyword-bearing `description` (quoted when it contains `: `) and, where the H1 is short, a `seoTitle`
3. Write content covering: what the feature does, how to configure it, key options
4. Add sidebar entry in `docs/astro.config.mjs` under the correct section
5. Verify: `pnpm docs:build` (catches broken links/formatting, and an MDX parse error that fails the deploy; the first run needs `pnpm --prefix docs install --frozen-lockfile`). The **Build Docs** check on every pull request runs the same build

### For updating existing pages:
1. Find the existing MDX file in `docs/src/content/docs/docs/`
2. Update content to reflect changes
3. Verify: `pnpm docs:build` (the same build the **Build Docs** pull-request check runs)

## Which page to update

| Area | Documentation file |
|------|--------------------|
| Installation & env vars | `getting-started/installation.mdx`, `getting-started/configuration.mdx` |
| Server setup | `getting-started/connecting-a-server.mdx` |
| Library browsing & filters | `features/library.mdx` |
| Query Builder (criteria, criterion columns, saved queries, convert to rule set, ad-hoc actions) | `features/query.mdx` |
| Dashboard | `features/dashboard.mdx` |
| Lifecycle rules & actions | `features/lifecycle-rules.mdx` |
| Deletion safeguards (evaluability, ceiling, guards) | `features/deletion-safety.mdx` |
| Use-case guides & importable rule sets | `guides/delete-unwatched-media.mdx`, `guides/leaving-soon-collection.mdx`, `guides/seerr-request-cleanup.mdx`, `guides/replace-low-quality-files.mdx`, `guides/ended-shows.mdx`, `guides/rule-set-library.mdx` |
| Backup & restore | `features/backup-restore.mdx` |
| Notifications | `features/notifications.mdx` |
| Stream manager & maintenance | `features/stream-manager.mdx` |
| AI Analysis | `features/ai-analysis.mdx` |
| Real-time media-server sync | `features/real-time-sync.mdx` |
| Preroll manager | `features/preroll-manager.mdx` |
| TRaSH Guide Sync | `features/trash-guide-sync.mdx` |
| System logs | `features/system-logs.mdx` |
| Integrations | `integrations/plex.mdx`, `integrations/jellyfin-emby.mdx`, `integrations/sonarr.mdx`, `integrations/radarr.mdx`, `integrations/lidarr.mdx`, `integrations/seerr.mdx`, `integrations/tracearr.mdx` |
| Unraid | `getting-started/unraid.mdx` |
| Style guide | `development/style-guide.mdx` |
| Security | `advanced/security-hardening.mdx` |
| SSO (OIDC & forward-auth) | `advanced/sso.mdx` |
| Public API & API keys | `advanced/api.mdx`, `advanced/api-reference.mdx` (renders the generated OpenAPI document) |
| Development | `advanced/development.mdx` |
| Docs home & disclaimer | `index.mdx`, `disclaimer.mdx` (landing page: `docs/src/pages/index.astro`) |

## Documentation Site

`docs/` is an **Astro + Starlight** site deployed to GitHub Pages at `librariarr.dev`, isolated from the app: its own `package.json`, `tsconfig.json`, and pnpm workspace (`docs/pnpm-workspace.yaml`, `docs/pnpm-lock.yaml`, the same supply-chain controls and its own `overrides` — the root's overrides do not reach it; keep `packageManager` in step with the root's). Root `tsconfig.json`, `eslint.config.mjs` and `.dockerignore` exclude `docs/`.

```bash
pnpm docs:dev      # Start docs dev server (localhost:4321)
pnpm docs:build    # Production build
pnpm docs:preview  # Preview built docs
```

- `docs/src/pages/index.astro` — the custom landing page (outside Starlight, so it carries its own `<head>`: title, description, canonical, robots, Open Graph/Twitter, JSON-LD whose `softwareVersion` comes from the generated `public/openapi.json`).
- `docs/src/route-data.ts` — Starlight route middleware adding per-page SEO: `<title>`/`og:title` from the **`seoTitle`** frontmatter (a `docsSchema` extension in `content.config.ts`; the H1 stays `title`), the page's social image, and `BreadcrumbList` + `TechArticle` JSON-LD with `dateModified` from git (`lastUpdated: true`, so `docs-deploy.yml` checks out with `fetch-depth: 0`). Every page keeps a specific `description` (quoted when it contains `: `).
- `docs/src/pages/og/[...slug].png.ts` — a 1200×630 social image per page (satori → `sharp`), in Sora from `@fontsource/sora`'s static files.
- Fonts are self-hosted (`@fontsource-variable/*`), never Google Fonts.
- `docs/src/content/docs/docs/guides/` — use-case guides. `rule-set-library.mdx` holds importable rule sets as Export JSON (`RuleSetExport` in `src/components/lifecycle-rule-page.tsx`; every one with `actionEnabled: false`, each folded in a `<details>`). `scripts/rule-set-library-check.ts` (alias-free) validates every json block against `CONDITION_FIELDS`, `CONDITION_OPERATORS` and the action lists in both the docs build (`validate:rulesets`) and `tests/unit/docs/rule-set-library.test.ts` (which also checks `ruleSetCreateSchema` and that every field is described in `lifecycle-rules.mdx`). Renaming a field, operator or action type fails both until the docs follow.
- `docs/src/content/docs/docs/` — MDX docs at `librariarr.dev/docs/...`; `docs/astro.config.mjs` — sidebar and site config; `.github/workflows/docs-deploy.yml` — builds the site on every pull request (the **Build Docs** check, no paths filter, deploy skipped) and deploys on a push to main touching `docs/**` or the OpenAPI source files.
