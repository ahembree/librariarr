import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://librariarr.dev",
  integrations: [
    starlight({
      title: "Librariarr",
      logo: {
        src: "./src/assets/logo.svg",
      },
      favicon: "/favicon.svg",
      description:
        "Media library management for Plex, Jellyfin, and Emby servers",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ahembree/librariarr",
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://librariarr.dev/librariarr_hero.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:card",
            content: "summary_large_image",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://librariarr.dev/librariarr_hero.png",
          },
        },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            {
              label: "Installation",
              slug: "docs/getting-started/installation",
            },
            {
              label: "Unraid Installation",
              slug: "docs/getting-started/unraid",
            },
            {
              label: "Configuration",
              slug: "docs/getting-started/configuration",
            },
            {
              label: "Connecting a Server",
              slug: "docs/getting-started/connecting-a-server",
            },
          ],
        },
        {
          label: "Features",
          items: [
            { label: "Dashboard", slug: "docs/features/dashboard" },
            { label: "Library Browsing", slug: "docs/features/library" },
            {
              label: "Lifecycle Rules",
              slug: "docs/features/lifecycle-rules",
            },
            {
              label: "Stream Manager",
              slug: "docs/features/stream-manager",
            },
            {
              label: "Preroll Manager",
              slug: "docs/features/preroll-manager",
            },
            {
              label: "Backup & Restore",
              slug: "docs/features/backup-restore",
            },
            { label: "Notifications", slug: "docs/features/notifications" },
            { label: "System Logs", slug: "docs/features/system-logs" },
          ],
        },
        {
          label: "Integrations",
          items: [
            { label: "Plex", slug: "docs/integrations/plex" },
            {
              label: "Jellyfin & Emby",
              slug: "docs/integrations/jellyfin-emby",
            },
            { label: "Sonarr", slug: "docs/integrations/sonarr" },
            { label: "Radarr", slug: "docs/integrations/radarr" },
            { label: "Lidarr", slug: "docs/integrations/lidarr" },
            { label: "Seerr", slug: "docs/integrations/seerr" },
          ],
        },
        {
          label: "Advanced",
          items: [
            { label: "Development", slug: "docs/advanced/development" },
          ],
        },
        {
          label: "Disclaimer",
          slug: "docs/disclaimer",
        },
      ],
    }),
  ],
});
