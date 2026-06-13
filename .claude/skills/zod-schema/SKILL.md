---
name: zod-schema
description: Add a new Zod validation schema to src/lib/validation.ts. All schemas MUST live in this file using zod/v4. Use when creating validation for new API endpoints.
argument-hint: <schema-name> [field-descriptions]
---

# Zod Schema Generator

Add a new validation schema for: $ARGUMENTS

## Rules (MANDATORY)

1. ALL schemas go in `src/lib/validation.ts` — NEVER define schemas inline in route files
2. Uses `zod/v4` subpath import: `import { z } from "zod/v4"` (already at top of file)
3. Export as `const`: `export const mySchema = z.object({ ... })`
4. Create schemas use required fields; Update schemas use `.partial()` on the create schema
5. Schema names use camelCase ending in `Schema` (e.g., `thingCreateSchema`, `thingUpdateSchema`)

## Common Patterns

### Required string:
```typescript
name: z.string().min(1, "Name is required")
```

### URL validation:
```typescript
url: z.url("Invalid URL format")
```

### Optional with default:
```typescript
enabled: z.boolean().optional().default(true)
```

### Enum:
```typescript
type: z.enum(["MOVIE", "SERIES", "MUSIC"])
```

### Optional number with range:
```typescript
delayDays: z.number().int().min(0).max(365).optional().default(7)
```

### Optional string:
```typescript
description: z.string().optional()
```

### Nullable:
```typescript
notes: z.string().nullable()
```

### Array:
```typescript
tags: z.array(z.string()).optional().default([])
```

## Create + Update Pair Pattern

Most CRUD resources need both:
```typescript
export const thingCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  url: z.url("Invalid URL format"),
  apiKey: z.string().min(1, "API key is required"),
});

export const thingUpdateSchema = thingCreateSchema.partial();
```

## Existing Schema Examples for Reference

- `arrInstanceCreateSchema` — name + url + apiKey (integration instances)
- `blackoutCreateSchema` — complex with conditional fields and enums
- `ruleSetCreateSchema` / `ruleSetUpdateSchema` — create + update pair
- `syncScheduleSchema` — single field
- `dashboardLayoutSchema` — nested objects with arrays
- `customCardConfigSchema` — uses `.refine()` for cross-field validation

## Usage in API Routes

After creating the schema, import and use it in the route:
```typescript
import { validateRequest, thingCreateSchema } from "@/lib/validation";

const { data, error } = await validateRequest(request, thingCreateSchema);
if (error) return error;
```

## Steps
1. Read `src/lib/validation.ts` to find appropriate placement (schemas are loosely grouped by feature)
2. Define the schema following existing patterns
3. Export the schema
4. If a corresponding update schema is needed, create it with `.partial()`
5. Run `pnpm lint` to verify
