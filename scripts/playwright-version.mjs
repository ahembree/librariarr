#!/usr/bin/env node
// Prints the @playwright/test version pnpm-lock.yaml resolves for the app.
// docker-compose.e2e.yml builds its Playwright image tag from this, because the
// image's pre-baked browsers only work with the exact matching library version
// and Dependabot bumps the library without touching the compose file.
import { readFileSync } from "node:fs";

const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const matches = [
  ...lockfile.matchAll(/^ {6}'@playwright\/test':\n {8}specifier: .*\n {8}version: (\S+)$/gm),
];
if (matches.length !== 1) {
  console.error(`Expected one @playwright/test importer entry in pnpm-lock.yaml, found ${matches.length}`);
  process.exit(1);
}
console.log(matches[0][1]);
