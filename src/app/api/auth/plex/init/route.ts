import { NextRequest, NextResponse } from "next/server";
import { createPlexPin, getPlexAuthUrl, getPlexClientId, PLEX_PRODUCT, PLEX_VERSION } from "@/lib/plex/auth";
import { apiLogger } from "@/lib/logger";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "plex-init");
    if (rateLimited) return rateLimited;

    const pin = await createPlexPin();
    const clientId = await getPlexClientId();
    const authUrl = await getPlexAuthUrl(pin.code);

    return NextResponse.json({
      pinId: pin.id,
      code: pin.code,
      clientId,
      product: PLEX_PRODUCT,
      version: PLEX_VERSION,
      authUrl,
      expiresAt: pin.expiresAt,
    });
  } catch (error) {
    apiLogger.error("Auth", "Failed to initialize Plex auth", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to initialize Plex authentication" },
      { status: 500 }
    );
  }
}
