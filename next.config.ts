import type { NextConfig } from "next";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const packageJson = require("./package.json");

// `'unsafe-eval'` is only needed by the development runtime (React Refresh /
// source-map eval). The production bundle never calls eval, so shipping the
// directive there only widened what an XSS could do. `'unsafe-inline'` for
// scripts remains: Next.js emits inline bootstrap scripts, and dropping it
// requires per-request nonces (a proxy-generated nonce + `'strict-dynamic'`),
// which forces every page dynamic — a follow-up, not a header tweak.
const scriptSrc =
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

const nextConfig: NextConfig = {
  output: "standalone",
  // No `X-Powered-By: Next.js` — it only tells a scanner what to try.
  poweredByHeader: false,
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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self'",
              "connect-src 'self' https://plex.tv https://app.plex.tv",
              "frame-ancestors 'none'",
              // Not covered by default-src: without these an injected <base>
              // could re-point every relative URL, an injected <form> could
              // post to another origin, and <object>/<embed> would load
              // same-origin plugin content. The app uses none of them (SSO
              // starts from a link, Plex from a popup, every form submits via
              // fetch).
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
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
