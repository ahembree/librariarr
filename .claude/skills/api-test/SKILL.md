---
name: api-test
description: Generate an integration test for an API route with all required mocks and boilerplate. Use when creating tests for API endpoints.
argument-hint: <route-import-path>
---

# Integration Test Generator

Generate an integration test for the API route at `$ARGUMENTS`.

## Required Boilerplate (copy exactly)

### File header — imports and standard mocks:
```typescript
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { cleanDatabase, disconnectTestDb } from "../../setup/test-db";
import { setMockSession, clearMockSession } from "../../setup/mock-session";
import {
  callRoute,
  callRouteWithParams,
  expectJson,
  createTestUser,
  // Add other factories as needed:
  // createTestServer, createTestLibrary, createTestMediaItem,
  // createTestRuleSet, createTestSonarrInstance, createTestRadarrInstance,
  // createTestLidarrInstance, createTestSeerrInstance, createTestExternalId,
  // createTestLogEntry, createTestMediaStream
} from "../../setup/test-helpers";

// Redirect prisma to test database — MUST come before route imports
vi.mock("@/lib/db", async () => {
  const { getTestPrisma } = await import("../../setup/test-db");
  return { prisma: getTestPrisma() };
});

// Suppress logger DB writes
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  apiLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  dbLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
```

### External service mocks (if needed):
```typescript
// CRITICAL: Constructor mocks MUST use function() keyword, NOT arrow functions
const mockTestConnection = vi.fn();
vi.mock("@/lib/arr/sonarr-client", () => ({
  SonarrClient: vi.fn().mockImplementation(function () {
    return { testConnection: mockTestConnection };
  }),
}));
```

### vi.hoisted() pattern — use when mock variables are referenced inside vi.mock() factories:
```typescript
const { mockFn } = vi.hoisted(() => ({
  mockFn: vi.fn(),
}));
vi.mock("@/lib/some-module", () => ({
  someFunction: mockFn,
}));
```

### Route imports — MUST come AFTER all vi.mock() calls:
```typescript
import { GET, POST } from "@/app/api/path/to/route";
```

### Lifecycle hooks:
```typescript
describe("API endpoint description", () => {
  beforeEach(async () => {
    await cleanDatabase();
    clearMockSession();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  // tests go here
});
```

## Standard Test Cases

### For every route — 401 unauthorized:
```typescript
it("returns 401 when not authenticated", async () => {
  const response = await callRoute(GET);
  await expectJson(response, 401);
});
```

### GET list endpoints:
```typescript
it("returns empty array when user has no data", async () => {
  const user = await createTestUser();
  setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

  const response = await callRoute(GET);
  const body = await expectJson<{ items: unknown[] }>(response, 200);
  expect(body.items).toEqual([]);
});

it("returns data belonging to authenticated user", async () => {
  const user = await createTestUser();
  setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });
  // Create test data...

  const response = await callRoute(GET);
  const body = await expectJson<{ items: unknown[] }>(response, 200);
  expect(body.items).toHaveLength(1);
});

it("does not return data belonging to another user", async () => {
  const user1 = await createTestUser();
  const user2 = await createTestUser({ data: { plexId: "other", plexUsername: "other" } });
  // Create data for user2...
  setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

  const response = await callRoute(GET);
  const body = await expectJson<{ items: unknown[] }>(response, 200);
  expect(body.items).toHaveLength(0);
});
```

### POST endpoints:
```typescript
it("returns 400 with invalid body", async () => {
  const user = await createTestUser();
  setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

  const response = await callRoute(POST, { body: {} });
  await expectJson(response, 400);
});

it("creates resource with valid data", async () => {
  const user = await createTestUser();
  setMockSession({ userId: user.id, plexToken: "tok", isLoggedIn: true });

  const response = await callRoute(POST, {
    body: { name: "Test", /* fields */ },
  });
  const body = await expectJson<{ item: { id: string } }>(response, 201);
  expect(body.item.id).toBeDefined();
});
```

### PUT/DELETE with [id] — ownership check:
```typescript
it("returns 404 when resource belongs to another user", async () => {
  const user1 = await createTestUser();
  const user2 = await createTestUser({ data: { plexId: "other", plexUsername: "other" } });
  // Create resource owned by user2...
  setMockSession({ userId: user1.id, plexToken: "tok", isLoggedIn: true });

  const response = await callRouteWithParams(DELETE, { id: resource.id });
  await expectJson(response, 404);
});
```

## Route Handler Invocation

- Simple routes: `callRoute(GET)` or `callRoute(POST, { body: { ... } })`
- With URL: `callRoute(GET, { url: "/api/path?param=value" })`
- Dynamic params: `callRouteWithParams(PUT, { id: "abc" }, { body: { ... } })`
- Assert response: `const body = await expectJson<{ key: Type }>(response, 200);`

## Steps
1. Read the route file to identify which HTTP methods it exports
2. Check imports for external services that need mocking (Plex, Sonarr, Radarr, etc.)
3. Identify which data factories are needed based on Prisma models used
4. Create test file at `tests/integration/<category>/<name>.test.ts`
5. Include all standard test cases plus route-specific edge cases
6. Run the test to verify: `npx vitest run tests/integration/<category>/<name>.test.ts`
