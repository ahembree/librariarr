import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // Lock the PWA's identity so future tweaks to start_url don't create
    // a "second app" install on user devices.
    id: "/",
    name: "Librariarr",
    short_name: "Librariarr",
    description: "Media library management for Plex, Jellyfin, and Emby",
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Matches src/app/globals.css --background = oklch(0.16 0.006 270); avoids
    // a colour flash between the PWA splash and the loaded app shell.
    background_color: "#0c0d10",
    theme_color: "#0c0d10",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
