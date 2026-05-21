/**
 * Authoritative map of MediaItem fields that are non-nullable in
 * `prisma/schema.prisma`, paired with their Prisma scalar type.
 *
 * The rule engine consults this when building isNull / isNotNull WHERE
 * clauses. Prisma 7 throws on non-nullable columns:
 *   { field: null }            → "Argument `<field>` is missing"
 *   { field: { not: null } }   → "Argument `not` is missing"
 *
 * Semantic per type:
 *   - String non-nullable: "no value" is the empty string; the engine
 *     substitutes `{ field: "" }` / `{ NOT: { field: "" } }`.
 *   - Int / Float / Boolean / DateTime / BigInt non-nullable: the column
 *     always has a value, so `isNull` matches zero rows (UNSATISFIABLE) and
 *     `isNotNull` matches every row (empty WHERE). applyNegate inverts
 *     correctly across both polarities.
 *
 * CI guard rail: tests/unit/conditions/field-metadata.test.ts parses
 * prisma/schema.prisma and asserts every MediaItem non-nullable scalar
 * field that's exposed as a CONDITION_FIELDS entry is mapped here. Adding
 * a new non-nullable scalar field without updating this map fails CI.
 */

export type PrismaScalarType =
  | "String"
  | "Int"
  | "Float"
  | "Boolean"
  | "DateTime"
  | "BigInt";

const NON_NULLABLE_FIELDS = new Map<string, PrismaScalarType>([
  ["title", "String"],
  ["playCount", "Int"],
  ["isWatchlisted", "Boolean"],
]);

export function getNonNullableType(field: string): PrismaScalarType | undefined {
  return NON_NULLABLE_FIELDS.get(field);
}

export function isNonNullableField(field: string): boolean {
  return NON_NULLABLE_FIELDS.has(field);
}

export function isNonNullableTextField(field: string): boolean {
  return NON_NULLABLE_FIELDS.get(field) === "String";
}

export function isNonNullableNonTextField(field: string): boolean {
  const t = NON_NULLABLE_FIELDS.get(field);
  return t !== undefined && t !== "String";
}

export function listNonNullableFields(): ReadonlyArray<readonly [string, PrismaScalarType]> {
  return Array.from(NON_NULLABLE_FIELDS.entries());
}
