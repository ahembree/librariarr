/**
 * The `appCache` key prefix of the library listings' finished responses
 * (`withListResponseCache` in `src/lib/api/cached-list-response.ts`), dropped
 * by `invalidateMediaCaches()`. In a module of its own, with no imports, so the
 * test database's cleanup can name it whatever a test file mocks.
 */
export const LIST_RESPONSE_CACHE_PREFIX = "media-list:";
