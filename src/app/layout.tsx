import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
import "./globals.css";

// Self-hosted (see src/app/fonts/README.md), not next/font/google: that
// loader downloads the stylesheet from Google at build time, so a change in
// what Google serves — or an outage — fails the production build. Each file is
// the family's variable font; `weight` keeps the range the UI was designed
// against (a heavier or lighter request clamps to it, as it did before).
// Turbopack names each @font-face after its const, so these stay the family
// names rather than generic words like "sans" or "mono".
const sora = localFont({
  src: "./fonts/Sora-Variable.woff2",
  variable: "--font-display",
  weight: "400 700",
});

const plusJakartaSans = localFont({
  src: "./fonts/PlusJakartaSans-Variable.woff2",
  variable: "--font-sans",
  weight: "300 700",
});

const jetBrainsMono = localFont({
  src: "./fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-mono",
  weight: "400 600",
});

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
      <body
        className={`${sora.variable} ${plusJakartaSans.variable} ${jetBrainsMono.variable} antialiased`}
      >
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
