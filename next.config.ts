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
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
