---
name: api-route
description: Generate a new Next.js API route with project boilerplate (auth, validation, sanitize, Prisma). Use when creating new API endpoints.
argument-hint: <route-path> [HTTP-methods] [prisma-model]
---

# API Route Generator

Generate a new API route at `src/app/api/$ARGUMENTS`.

## Conventions (MANDATORY)

### Imports — use these EXACT paths:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";  // NEVER @/lib/prisma
import { validateRequest, schemaName } from "@/lib/validation";  // schemas ONLY in this file
import { sanitize, sanitizeErrorDetail } from "@/lib/api/sanitize";
```

### Auth check — EVERY handler starts with:
```typescript
const session = await getSession();
if (!session.isLoggedIn) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
```

### Validation — all mutation routes (POST/PUT/PATCH/DELETE with body):
```typescript
const { data, error } = await validateRequest(request, schemaName);
if (error) return error;
```
The Zod schema MUST be defined in `src/lib/validation.ts` using `zod/v4`, NOT inline in the route file.

### Response sanitization:
- Wrap ALL responses containing server/integration records with `sanitize()`
- Wrap error details with `sanitizeErrorDetail()`
- BigInt `fileSize` fields must be serialized: `fileSize: item.fileSize?.toString() ?? null`

### Ownership verification:
- Direct user data: `where: { userId: session.userId! }`
- Media items: `where: { library: { mediaServer: { userId: session.userId } } }`
- Use `findFirst` with userId filter, NOT bare `findUnique({ where: { id } })`

### Dynamic route params (Next.js 16 — params is a Promise):
```typescript
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ...
}
```

### Error handling:
```typescript
// For external service failures:
return NextResponse.json(
  { error: "Failed to connect to Service", detail: sanitizeErrorDetail(result.error) },
  { status: 400 }
);

// For not found (always verify ownership):
const existing = await prisma.model.findFirst({
  where: { id, userId: session.userId! },
});
if (!existing) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
```

## Route Patterns

### List + Create (`route.ts` — no dynamic segment):
```typescript
export async function GET() {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const items = await prisma.model.findMany({
    where: { userId: session.userId! },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ items: sanitize(items) });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await validateRequest(request, createSchema);
  if (error) return error;

  const item = await prisma.model.create({
    data: { userId: session.userId!, ...data },
  });

  return NextResponse.json({ item: sanitize(item) }, { status: 201 });
}
```

### Read + Update + Delete (`[id]/route.ts`):
```typescript
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await validateRequest(request, updateSchema);
  if (error) return error;

  const existing = await prisma.model.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.model.update({ where: { id }, data });
  return NextResponse.json({ item: sanitize(updated) });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const existing = await prisma.model.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.model.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
```

### Paginated list endpoint:
```typescript
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") ?? "1");
  const rawLimit = parseInt(searchParams.get("limit") ?? "50");
  const limit = rawLimit === 0 ? 0 : Math.min(rawLimit, 100);

  const where = { userId: session.userId! };
  const items = await prisma.model.findMany({
    where,
    ...(limit > 0 ? { skip: (page - 1) * limit, take: limit + 1 } : {}),
    orderBy: { createdAt: "desc" },
  });

  const hasMore = limit > 0 && items.length > limit;
  if (hasMore) items.pop();

  return NextResponse.json({
    items: sanitize(items),
    pagination: { page, limit, hasMore },
  });
}
```

### Media routes with multi-server dedup:
```typescript
import { resolveServerFilter } from "@/lib/dedup/server-filter";

// Inside handler:
const sf = await resolveServerFilter(session.userId!, serverId, "MOVIE");
if (!sf) {
  return NextResponse.json({ items: [], pagination: { page, limit, hasMore: false } });
}
const where: Prisma.MediaItemWhereInput = {
  library: { mediaServerId: { in: sf.serverIds } },
  type: "MOVIE",
};
if (!sf.isSingleServer) where.dedupCanonical = true;
```

## Steps
1. Parse arguments to determine: route path, HTTP methods, Prisma model, validation schema
2. If a new Zod schema is needed, add it to `src/lib/validation.ts` using `zod/v4`
3. Create `src/app/api/<route-path>/route.ts` using the patterns above
4. If the route has dynamic params like `[id]`, use the Next.js 16 async params pattern
5. Run `pnpm lint` to verify no lint errors
