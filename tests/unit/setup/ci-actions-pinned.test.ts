import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * Every third-party action in CI runs with the repository's token, and the
 * release workflows with the Docker Hub credentials. A tag (`@v7`) is a name
 * its owner can move to different code at any time; a commit SHA is not.
 * Dependabot's `github-actions` updates keep the pins and their version
 * comments current.
 */
const WORKFLOWS = path.resolve(__dirname, "../../../.github/workflows");

describe("GitHub Actions are pinned to a commit", () => {
  const uses = readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      readFileSync(path.join(WORKFLOWS, file), "utf-8")
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, match: line.match(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/) }))
        .filter((entry) => entry.match)
        .map((entry) => ({ file: entry.file, line: entry.line, ref: entry.match![1], rest: entry.match![2] })),
    );

  it("finds the workflows' actions", () => {
    expect(uses.length).toBeGreaterThan(10);
  });

  it.each(uses.filter((use) => !use.ref.startsWith("./")))("$file:$line $ref", ({ ref, rest }) => {
    const [, version] = ref.split("@");
    expect(version, "pin the action to a full commit SHA, not a tag or branch").toMatch(/^[0-9a-f]{40}$/);
    // The version the SHA is, for whoever reads the workflow (and Dependabot).
    expect(rest.trim()).toMatch(/^# v\d+(\.\d+){0,2}$/);
  });
});
