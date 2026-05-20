---
name: doc-feature
description: Create or update feature documentation in the Astro Starlight docs site. Use when adding new features or updating existing documentation.
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
  getting-started/    — Installation, configuration, server setup
  features/           — Dashboard, library, lifecycle rules, stream manager, etc.
  integrations/       — Sonarr, Radarr, Lidarr, Seerr, Plex, Jellyfin/Emby
  advanced/           — Development guide
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

## Existing Sidebar Sections

- **Getting Started**: installation, configuration, connecting-a-server
- **Features**: dashboard, library, lifecycle-rules, stream-manager, preroll-manager, backup-restore, notifications, system-logs
- **Integrations**: plex, jellyfin-emby, sonarr, radarr, lidarr, seerr
- **Advanced**: development, security-hardening, sso

## Steps

### For new documentation pages:
1. Create MDX file at `docs/src/content/docs/docs/<category>/<name>.mdx`
2. Add frontmatter with `title` and `description`
3. Write content covering: what the feature does, how to configure it, key options
4. Add sidebar entry in `docs/astro.config.mjs` under the correct section
5. Verify: `pnpm docs:build` (catches broken links/formatting)

### For updating existing pages:
1. Find the existing MDX file in `docs/src/content/docs/docs/`
2. Update content to reflect changes
3. Verify: `pnpm docs:build`
