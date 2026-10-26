import { NextResponse } from "next/server";
import type { IronSession } from "iron-session";
import { getSession, type SessionData } from "@/lib/auth/session";

/** A session `withSession` has checked: signed in, as the user it names. */
export type LoggedInSession = IronSession<SessionData> & { isLoggedIn: true; userId: string };

/** Whether `session` is a signed-in one — what every route's 401 guard asks. */
export function isLoggedInSession(session: IronSession<SessionData>): session is LoggedInSession {
  return session.isLoggedIn === true && typeof session.userId === "string" && session.userId.length > 0;
}

/**
 * A route handler for a signed-in user: answers 401 `{ error: "Unauthorized" }`
 * otherwise, and hands the handler the checked session, whose `userId` is a
 * string.
 *
 * It reads the session through `getSession()`, so everything that already
 * answers there keeps working: revocation, the settings bundle's shared read
 * (`withSharedSession`), and `withApiKey`, which runs a handler as the key's
 * owner (`/api/v1` files wrap these handlers again in `withApiKey`).
 *
 * The session comes first and the handler's own parameters — the request,
 * then the route context — follow, so the wrapped handler takes exactly what
 * the handler reads: one that takes only the session is callable with no
 * arguments, which is how the settings bundle runs its handlers
 * (`src/app/api/settings/bundle/route.ts`), while one that reads the request
 * must be given one.
 */
export function withSession<A extends unknown[]>(
  handler: (session: LoggedInSession, ...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    const session = await getSession();
    if (!isLoggedInSession(session)) return unauthorized();
    return handler(session, ...args);
  };
}

/** The 401 every signed-in route answers a request without a valid session. */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
