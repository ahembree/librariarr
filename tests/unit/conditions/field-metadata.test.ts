/**
 * CI guard rail: parses prisma/schema.prisma and asserts that every MediaItem
 * non-nullable scalar field exposed as a CONDITION_FIELDS entry is present in
 * the NON_NULLABLE_FIELDS map with the correct Prisma type.
 *
 * Adding a new non-nullable scalar to MediaItem without updating
 * src/lib/conditions/field-metadata.ts will fail this test — preventing the
 * latent "Prisma 7 rejects { field: null }" throw the rule engine guards
 * against.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CONDITION_FIELDS } from "@/lib/conditions/fields";
import {
  isNonNullableField,
  isNonNullableTextField,
  isNonNullableNonTextField,
  getNonNullableType,
  listNonNullableFields,
  type PrismaScalarType,
} from "@/lib/conditions/field-metadata";

const SCHEMA_PATH = resolve(__dirname, "../../../prisma/schema.prisma");

const SCALAR_TYPES: ReadonlySet<PrismaScalarType> = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "BigInt",
]);

/**
 * Extract `model MediaItem { ... }` non-nullable scalar fields from
 * schema.prisma. A field is non-nullable scalar iff its type is one of
 * SCALAR_TYPES with no trailing `?` and no `[]`. Relation/JSON/enum fields
 * are skipped — only fields with isNull/isNotNull WHERE clause concerns.
 */
function parseMediaItemNonNullableScalars(): Map<string, PrismaScalarType> {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const match = schema.match(/model MediaItem \{([\s\S]*?)\n\}/);
  if (!match) throw new Error("Could not locate `model MediaItem { ... }` in schema.prisma");
  const body = match[1];

  const result = new Map<string, PrismaScalarType>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("@@")) continue;
    // Field syntax: `<name>  <Type>  [modifiers...]`
    const m = line.match(/^(\w+)\s+(\w+)(\??)(\[\])?/);
    if (!m) continue;
    const [, name, type, nullable, list] = m;
    if (nullable === "?" || list === "[]") continue;
    if (!SCALAR_TYPES.has(type as PrismaScalarType)) continue;
    result.set(name, type as PrismaScalarType);
  }
  return result;
}

describe("field-metadata: non-nullable field map", () => {
  const schemaNonNullable = parseMediaItemNonNullableScalars();
  const conditionFieldNames = new Set(CONDITION_FIELDS.map((f) => f.value));

  it("schema parser locates the MediaItem model and finds non-nullable scalars", () => {
    expect(schemaNonNullable.size).toBeGreaterThan(0);
    // Sanity: title must be one of them (we know it from the existing fix).
    expect(schemaNonNullable.get("title")).toBe("String");
  });

  it("every NON_NULLABLE_FIELDS entry corresponds to a non-nullable scalar in the schema", () => {
    for (const [name, type] of listNonNullableFields()) {
      expect(schemaNonNullable.get(name), `${name} should be a non-nullable scalar in schema.prisma`).toBe(type);
    }
  });

  it("every condition-exposed non-nullable scalar in the schema is mapped", () => {
    const missing: Array<{ field: string; type: PrismaScalarType }> = [];
    for (const [field, type] of schemaNonNullable) {
      if (!conditionFieldNames.has(field)) continue;
      if (!isNonNullableField(field)) missing.push({ field, type });
      else if (getNonNullableType(field) !== type) missing.push({ field, type });
    }
    expect(missing, `Add to NON_NULLABLE_FIELDS in src/lib/conditions/field-metadata.ts: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("string/non-string predicates partition the map correctly", () => {
    for (const [field, type] of listNonNullableFields()) {
      if (type === "String") {
        expect(isNonNullableTextField(field), `${field} should be text`).toBe(true);
        expect(isNonNullableNonTextField(field), `${field} should not be non-text`).toBe(false);
      } else {
        expect(isNonNullableTextField(field), `${field} should not be text`).toBe(false);
        expect(isNonNullableNonTextField(field), `${field} should be non-text`).toBe(true);
      }
    }
  });

  it("unknown fields are reported as nullable", () => {
    expect(isNonNullableField("totally-bogus-field-name")).toBe(false);
    expect(isNonNullableTextField("totally-bogus-field-name")).toBe(false);
    expect(isNonNullableNonTextField("totally-bogus-field-name")).toBe(false);
    expect(getNonNullableType("totally-bogus-field-name")).toBeUndefined();
  });
});
