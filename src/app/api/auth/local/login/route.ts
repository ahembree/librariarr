import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rotateSession } from "@/lib/auth/session";
import bcrypt from "bcryptjs";
import { apiLogger } from "@/lib/logger";
import { validateRequest, authLoginSchema } from "@/lib/validation";
import { checkAuthRateLimit } from "@/lib/rate-limit/rate-limiter";
import { loadPasswordSignInState, passwordSignInEnabled } from "@/lib/auth/password-sign-in";

/**
 * A real cost-12 bcrypt hash of a throwaway string. Compared against on the
 * unknown-username path purely to equalise timing; nothing ever matches it.
 */
const UNKNOWN_USER_DUMMY_HASH =
  "$2b$12$Hx3w06n5Vs5p8Ajdvdz9FuOw0kR7BGtKcAGI4PyfqiNglFBMsoFY6";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = checkAuthRateLimit(request, "login");
    if (rateLimited) return rateLimited;

    const { data, error } = await validateRequest(request, authLoginSchema);
    if (error) return error;
    const { username, password } = data;

    // Gate before credential check: the login page hides the local form when
    // localAuthEnabled is false or when SSO is usable (SSO hides local). Without
    // this check, a direct POST would bypass those toggles entirely — a real
    // auth-bypass for anyone with valid credentials. Return the same generic
    // 401 as a credential mismatch so we don't leak which toggle is off.
    //
    // SSO_DISABLE_OVERRIDE bypasses the localAuthEnabled toggle here for the
    // same reason check-setup re-surfaces the local form: an admin who had
    // localAuthEnabled=false because they were using SSO would otherwise be
    // locked out when SSO is down even though they have valid local
    // credentials. ssoUsable is already false under override
    // (getSsoSettings forces ssoEnabled=false), so that part of the gate
    // takes care of itself.
    //
    // The rule lives in password-sign-in.ts: every other place a password is
    // proof (the API-key step-up, "Confirm it's you", a credential change)
    // applies the same one, so a password the login refuses counts for
    // nothing anywhere.
    if (!passwordSignInEnabled(await loadPasswordSignInState())) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { localUsername: username.trim().toLowerCase() },
    });

    if (!user || !user.passwordHash) {
      // Burn the same bcrypt cost the known-user path pays, so the response
      // time does not tell the caller whether the username exists (a cost-12
      // compare is ~250ms; skipping it made an unknown name answer in ~5ms).
      await bcrypt.compare(password, UNKNOWN_USER_DUMMY_HASH);
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 }
      );
    }

    // Destroy first to clear any stale data (e.g. prior plexToken from a different session)
    const session = await rotateSession();
    session.userId = user.id;
    session.isLoggedIn = true;
    session.sessionVersion = user.sessionVersion;
    if (user.plexToken) {
      session.plexToken = user.plexToken;
    }
    await session.save();

    apiLogger.info("Auth", `Local login: "${user.username}"`);

    return NextResponse.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    apiLogger.error("Auth", "Local login failed", { error: String(error) });
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
