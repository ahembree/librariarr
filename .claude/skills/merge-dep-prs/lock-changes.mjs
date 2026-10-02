#!/usr/bin/env node
// List every DIRECT dependency whose resolved version differs between a git ref and the working
// tree, for both lockfiles (the app's pnpm-lock.yaml and docs/package-lock.json).
//
//   node .claude/skills/merge-dep-prs/lock-changes.mjs [base-ref, default origin/main]
//
// Run it after any relock. Every line it prints is going to main, so every line must be
// intentional and named in the squash title or body. A relock can move more than the PR's own
// package — a peer requirement drags its peer along (Starlight 0.42 moved astro 7.2.9 -> 7.3.1
// under a title that only named Starlight) — and a diff piped through `head` does not show it.
// Dependency-free on purpose: no YAML parser is resolvable from the repo root under pnpm.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

process.chdir(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
const base = process.argv[2] ?? "origin/main";

const atRef = (path) => {
  try {
    return execFileSync("git", ["show", `${base}:${path}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const inTree = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

// pnpm-lock.yaml (v9): importers -> "." -> (dev)dependencies -> <name> -> specifier / version.
// The version carries a peer suffix — "21.2.2(@types/node@26.4.0)" — which is stripped.
function pnpmDirect(text) {
  const block = text.split(/^importers:\n/m)[1]?.split(/^\S/m)[0] ?? "";
  const out = {};
  for (const m of block.matchAll(/^ {6}('?)([^'\s]+)\1:\n {8}specifier: [^\n]*\n {8}version: (\S+)/gm))
    out[m[2]] = m[3].replace(/\(.*$/, "");
  return out;
}

// package-lock.json (v3): the root's declared dependencies, resolved via packages["node_modules/<name>"].
function npmDirect(text) {
  const lock = JSON.parse(text);
  const root = lock.packages?.[""] ?? {};
  const names = Object.keys({ ...root.dependencies, ...root.devDependencies });
  return Object.fromEntries(names.map((n) => [n, lock.packages[`node_modules/${n}`]?.version]));
}

// An older npm drops the `libc` field from optional platform packages on relock. Counting libc
// lines in a diff cannot see that — a correct relock that adds or removes a platform package
// changes libc lines too — so compare per package: present in both, had libc, lost it.
function strippedLibc(beforeText, afterText) {
  const a = JSON.parse(beforeText).packages ?? {};
  const b = JSON.parse(afterText).packages ?? {};
  return Object.keys(a).filter((k) => a[k].libc && b[k] && !b[k].libc);
}

let moved = 0;
{
  const before = atRef("docs/package-lock.json");
  const after = inTree("docs/package-lock.json");
  const lost = before && after ? strippedLibc(before, after) : [];
  if (lost.length) {
    console.log(`docs/package-lock.json: ${lost.length} package(s) lost their libc field (e.g. ${lost[0]}) — relocked with an npm older than main's; redo it with a newer one.`);
    process.exitCode = 1;
  }
}
for (const [file, parse] of [["pnpm-lock.yaml", pnpmDirect], ["docs/package-lock.json", npmDirect]]) {
  const before = atRef(file);
  const after = inTree(file);
  if (before === null || after === null) continue;
  const a = parse(before);
  const b = parse(after);
  if (Object.keys(a).length === 0 || Object.keys(b).length === 0) {
    console.log(`${file}: could not parse — lockfile format changed? Check it by hand.`);
    process.exitCode = 1;
    continue;
  }
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[name] === b[name]) continue;
    console.log(`${file}  ${name}: ${a[name] ?? "(absent)"} -> ${b[name] ?? "(removed)"}`);
    moved++;
  }
}
if (moved === 0 && !process.exitCode) console.log(`no direct dependency moved relative to ${base}`);
