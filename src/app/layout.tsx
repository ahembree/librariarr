import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
import "./globals.css";

const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const sans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Librariarr",
  description: "Media library management for Plex, Jellyfin, and Emby",
  applicationName: "Librariarr",
  appleWebApp: {
    capable: true,
    title: "Librariarr",
    // `black-translucent` lets the app paint edge-to-edge behind the iOS
    // status bar; the mobile header and sidebar drawer pad with
    // env(safe-area-inset-top) so content clears the notch.
    statusBarStyle: "black-translucent",
  },
  // Next.js only emits the standard `mobile-web-app-capable` tag, but
  // iOS 15–16 Safari still requires the apple-prefixed legacy name to
  // enable standalone "Add to Home Screen" mode.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  // Matches --background in globals.css: oklch(0.16 0.018 235).
  themeColor: "#060f14",
  // Extend the canvas under notches/home indicators; safe-area-inset
  // padding (.pt-safe / .pb-safe / .pb-tabbar) keeps content clear.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}
      >
        <ThemeProvider>{children}</ThemeProvider>
        {/* mobileOffset clears the bottom tab bar on small screens */}
        <Toaster
          position="bottom-right"
          richColors
          duration={5000}
          mobileOffset={{ bottom: 88 }}
        />
      </body>
    </html>
  );
}
