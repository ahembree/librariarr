import type { Metadata, Viewport } from "next";
import { Sora, Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";
import "./globals.css";

const display = Sora({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const sans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
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
        <Toaster position="bottom-right" richColors duration={5000} />
      </body>
    </html>
  );
}
