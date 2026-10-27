import type { NextConfig } from "next";
import { createRequire } from "module";
import { buildCsp } from "./src/lib/security/csp";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");

// Pages get their Content-Security-Policy from `src/proxy.ts`, with a nonce
// per request (see `src/lib/security/csp.ts`); the proxy's header replaces
// this one there (`e2e/security-headers.spec.ts` reads which one arrives).
// This nonce-less form covers every other response — API JSON, and the files
// the proxy's matcher skips (icons, the manifest, static chunks).
const fallbackCsp = buildCsp({ dev: process.env.NODE_ENV === "development" });

const nextConfig: NextConfig = {
  output: "standalone",
  // No `X-Powered-By: Next.js` — it only tells a scanner what to try.
  poweredByHeader: false,
  experimental: {
    // Every shadcn primitive imports from the `radix-ui` umbrella package, a
    // barrel re-exporting all ~60 Radix packages; Next's built-in list of
    // barrels it rewrites to direct imports does not include it.
    optimizePackageImports: ["radix-ui"],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Content-Security-Policy", value: fallbackCsp },
        ],
      },
      // Artwork proxies return bytes a media server sent, content type and
      // all: an image the cache could not decode, or a session thumbnail, is
      // passed through as is. Served under the page policy, an HTML or SVG
      // body from a hostile or compromised server would run with
      // 'unsafe-inline' on the app's origin when opened directly. Nothing in
      // an image response ever needs to run, so these get a policy that
      // forbids everything; `<img>` loads are not affected by it. Listed after
      // the catch-all so this header replaces its policy for these paths.
      ...["/api/media/:id/image", "/api/v1/media/:id/image", "/api/tools/sessions/image"].map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; sandbox" }],
      })),
    ];
  },
};

export default nextConfig;
