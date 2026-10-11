import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
// Self-hosted (Fontsource) rather than next/font/google, which downloads the
// fonts from Google at build time and fails the build when that request does.
import "@fontsource-variable/sora";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Librariarr",
  description: "Media library management for Plex, Jellyfin, and Emby",
  applicationName: "Librariarr",
  appleWebApp: {
    capable: true,
    title: "Librariarr",
    // `default` lets iOS pick a status-bar background from `theme_color` and
    // an opaque inset; avoids the notch overlapping the authenticated
    // header (which has no safe-area-inset padding).
    statusBarStyle: "default",
  },
  // Next.js only emits the standard `mobile-web-app-capable` tag, but
  // iOS 15–16 Safari still requires the apple-prefixed legacy name to
  // enable standalone "Add to Home Screen" mode.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#0c0d10",
  // Extend the canvas under notches/home indicators; safe-area-inset
  // padding (.pt-safe / .pb-safe) keeps content clear.
  viewportFit: "cover",
  // Shrink the layout viewport when the soft keyboard opens so dvh-bound
  // dialogs become scrollable instead of being clipped behind it.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        {/* Toasts auto-dismiss after 4s; a close button lets users dismiss
            sooner. On phones sonner spans the bottom edge full-width, so the
            mobileOffset keeps it clear of the home indicator / safe area. */}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          duration={4000}
          mobileOffset={{ bottom: 16, left: 16, right: 16 }}
        />
      </body>
    </html>
  );
}
