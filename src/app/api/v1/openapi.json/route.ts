import { withApiKey } from "@/lib/api-keys/guard";
import { openApiResponse } from "@/lib/api-keys/openapi-response";

// The API's own OpenAPI document, for any valid key.
export const GET = withApiKey(null, (request) => openApiResponse(request));
