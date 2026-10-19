import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import { STREAM_QUERY_FIELDS } from "@/lib/conditions/stream-query";

/**
 * The lifecycle docs' field tables give each field's editor label beside the
 * field name rule JSON and API requests use. A field added or relabelled in
 * the registry without its row would leave readers unable to map one to the
 * other, so every registry entry must have a row naming both.
 */
const DOC = readFileSync(
  resolve(__dirname, "../../../docs/src/content/docs/docs/features/lifecycle-rules.mdx"),
  "utf8",
);

describe("lifecycle docs field reference", () => {
  it.each([...CONDITION_FIELDS, ...STREAM_QUERY_FIELDS].map((f) => [f.value, f.label]))(
    "%s has a row with its label",
    (value, label) => {
      expect(DOC).toContain(`| ${label} | \`${value}\` |`);
    },
  );
});
