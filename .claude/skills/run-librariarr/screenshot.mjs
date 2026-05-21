#!/usr/bin/env node
// screenshot.mjs — headless-Chromium screenshot of a path on the running app.
//
// Called from driver.sh, never run directly by humans. Reads its inputs
// from env so the shell side doesn't have to worry about argv quoting:
//
//   LIBRARIARR_BASE_URL    base URL of the running app  (e.g. http://localhost:3000)
//   LIBRARIARR_COOKIE_JAR  Netscape-format cookie file from `curl -c`
//   LIBRARIARR_SHOT_PATH   path to load on the app      (e.g. /)
//   LIBRARIARR_SHOT_OUT    output PNG path
//   LIBRARIARR_VIEWPORT_W  optional viewport width      (default 1440)
//   LIBRARIARR_VIEWPORT_H  optional viewport height     (default 900)
//
// The Playwright import is dynamic so a missing install gives a clean
// error message instead of an ESM resolution stack trace.

import { readFileSync, existsSync } from "node:fs";

const env = (name, fallback) => process.env[name] ?? fallback;
const baseUrl   = env("LIBRARIARR_BASE_URL",  "http://localhost:3000");
const cookieJar = env("LIBRARIARR_COOKIE_JAR", "");
const shotPath  = env("LIBRARIARR_SHOT_PATH", "/");
const shotOut   = env("LIBRARIARR_SHOT_OUT",  "screenshot.png");
const viewportW = parseInt(env("LIBRARIARR_VIEWPORT_W", "1440"), 10);
const viewportH = parseInt(env("LIBRARIARR_VIEWPORT_H", "900"), 10);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "could not import 'playwright' — install with: pnpm dlx playwright@1.49.0 install chromium"
  );
  process.exit(2);
}

// Parse the librariarr_session line out of curl's Netscape-format jar.
// Cookie attributes are tab-separated: domain, includeSub, path, secure, expiry, name, value.
// curl prefixes HttpOnly entries with `#HttpOnly_` on the domain field — we
// strip that prefix instead of treating the line as a comment, otherwise
// the only cookie we care about (which IS HttpOnly) gets filtered out.
function loadSessionCookies() {
  if (!cookieJar || !existsSync(cookieJar)) return [];
  const url = new URL(baseUrl);
  return readFileSync(cookieJar, "utf8")
    .split("\n")
    .map((line) => line.replace(/^#HttpOnly_/, ""))
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 7 && parts[5] === "librariarr_session")
    .map((parts) => ({
      name: parts[5],
      value: parts[6],
      domain: url.hostname,
      path: parts[2] || "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }));
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: viewportW, height: viewportH },
});
const cookies = loadSessionCookies();
if (cookies.length) {
  await context.addCookies(cookies);
} else {
  console.warn("[screenshot] no session cookie loaded — capturing as anonymous");
}

const page = await context.newPage();
const target = baseUrl.replace(/\/+$/, "") + (shotPath.startsWith("/") ? shotPath : "/" + shotPath);
try {
  await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 });
} catch (err) {
  console.error(`[screenshot] navigation failed for ${target}: ${err.message}`);
  await browser.close();
  process.exit(3);
}
await page.screenshot({ path: shotOut, fullPage: true });
await browser.close();
console.log(`wrote ${shotOut} (${shotPath} on ${baseUrl})`);
